'use strict';

// ============================================================================================
// PHẦN AO + AP + AQ + CO + FC-11 — NGUỒN YOUTUBE (v6.23: Supadata, MỘT tầng duy nhất)
// ============================================================================================
// Ranh giới quan trọng nhất ở đây KHÔNG phải token mà là TRUNG THỰC: nếu không lấy được transcript
// thì hệ thống PHẢI nói "chưa đọc được nội dung video", tuyệt đối không dùng tiêu đề/mô tả để suy ra
// nội dung rồi trình bày như thể đã xem (PHẦN FA). Một câu trả lời bịa nghe rất trôi chảy vẫn là
// câu trả lời sai.
//
// v6.23: bỏ Innertube tự viết + proxy + thư viện ngoài + ASR Gemini tự chế (4 tầng, gốc bệnh là IP
// datacenter bị YouTube chặn). Nay gọi Supadata: `native` (phụ đề gốc) trước; không có mới gọi
// `generate` (AI nhận dạng) đúng MỘT lần để còn stamp được 'asr-supadata' cho UI cảnh báo.
//
// Về token: transcript 1 giờ ≈ 60–90k ký tự. Gửi nguyên là vô nghĩa khi câu hỏi chỉ cần 2 phút —
// nên transcript được cắt theo MỐC THỜI GIAN, và retrieval chọn đúng mốc liên quan.

const { contentFingerprint } = require('../queryFingerprint');
const contentCache = require('./sourceContentCache');
const singleFlight = require('../singleFlight');

// v6.23: bump -> cache cũ (kể cả INCOMPLETE do IP bị chặn) tự miss, không cần xoá tay.
const EXTRACTOR_VERSION = 'yt-transcript-v4-supadata';
const CHUNK_SECONDS = 90;
// Trần cứng cho cả 2 lệnh gọi + polling. PHẢI ngắn hơn maxDuration (60s) của route ít nhất 10s.
const DEFAULT_TIMEOUT_MS = 45000;
const POLL_INTERVAL_MS = 1500;
const METADATA_TIMEOUT_MS = 6000;

const MSG_UNAVAILABLE = 'Video này không có phụ đề/bản ghi lời nên hệ thống chưa đọc được nội dung. Hãy cung cấp bản ghi hoặc nguồn khác.';
const MSG_GENERATE_FAILED = 'Video này không có phụ đề, và cơ chế nhận dạng lời nói tự động cũng không trích được nội dung (video quá dài, không có lời thoại, hoặc dịch vụ đang giới hạn). Vui lòng cung cấp bản ghi hoặc nguồn khác.';
const MSG_SERVICE_FAILED = 'Dịch vụ đọc phụ đề YouTube đang lỗi hoặc đã hết hạn mức nên chưa đọc được nội dung video. Hãy thử lại sau, hoặc cung cấp bản ghi/nguồn khác.';
const MSG_NOT_CONFIGURED = 'Hệ thống chưa được cấu hình dịch vụ đọc phụ đề YouTube nên chưa đọc được nội dung video. Hãy cung cấp bản ghi hoặc nguồn khác.';

/**
 * parseVideoId() — chấp nhận mọi dạng URL YouTube phổ biến, trả về id 11 ký tự chuẩn.
 * @returns {string|null}
 */
function parseVideoId(raw) {
  const s = String(raw || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  let u;
  try { u = new URL(s); } catch (e) { return null; }
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  const valid = (id) => (/^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : null);
  if (host === 'youtu.be') return valid(u.pathname.slice(1).split('/')[0]);
  if (host !== 'youtube.com') return null;
  if (u.pathname === '/watch') return valid(u.searchParams.get('v'));
  const m = /^\/(shorts|embed|live|v)\/([^/?#]+)/.exec(u.pathname);
  if (m) return valid(m[2]);
  return null;
}

function canonicalUrl(videoId) { return `https://youtube.com/watch?v=${videoId}`; }

function formatTimestamp(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
}

/**
 * PHẦN AQ: gom cue thành chunk ~CHUNK_SECONDS giây — đơn vị retrieval là "một mốc thời gian", nên
 * citation của YouTube trỏ được tới đúng phút thay vì tới cả video.
 * `method` stamp lên MỌI chunk: 'text-supadata' = phụ đề gốc của video, 'asr-supadata' = Supadata
 * tự nhận dạng lời nói bằng AI (có thể sai) — client/citation dựa vào field NÀY để cảnh báo đúng mức.
 */
function chunkTranscript(cues, { chunkSeconds = CHUNK_SECONDS, method = 'text' } = {}) {
  const chunks = [];
  let current = null;
  (cues || []).forEach((cue) => {
    if (!current || (cue.start - current.startSeconds) >= chunkSeconds) {
      if (current) chunks.push(current);
      current = { startSeconds: cue.start, endSeconds: cue.start + (cue.duration || 0), text: cue.text };
    } else {
      current.endSeconds = cue.start + (cue.duration || 0);
      current.text += ' ' + cue.text;
    }
  });
  if (current) chunks.push(current);
  return chunks.map((c, i) => ({
    chunkIndex: i + 1,
    totalChunks: chunks.length,
    startSeconds: Math.floor(c.startSeconds),
    endSeconds: Math.ceil(c.endSeconds),
    locator: `${formatTimestamp(c.startSeconds)}–${formatTimestamp(c.endSeconds)}`,
    text: c.text.replace(/\s+/g, ' ').trim(),
    extractionMethod: method
  }));
}


// ---------- Supadata ----------

let cachedClient = null;
let cachedKey = null;
/** Đọc env MỖI LẦN gọi (đổi key/test không cần restart). Không có key -> null. */
function getSupadataClient() {
  const key = String(process.env.SUPADATA_API_KEY || '').trim();
  if (!key) return null;
  if (!cachedClient || cachedKey !== key) {
    const { Supadata } = require('@supadata/js'); // nạp lười: route khác không trả phí nạp SDK
    cachedClient = new Supadata({ apiKey: key });
    cachedKey = key;
  }
  return cachedClient;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`${label}_timeout`), { code: 'timeout' })), Math.max(1, ms)); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Supadata trả 206 `transcript-unavailable` như một response "ok" (SDK không throw) hoặc như SupadataError. */
function unavailableCode(x) {
  return !!x && (x.error === 'transcript-unavailable' || (x.error && x.error.error === 'transcript-unavailable'));
}

/**
 * Supadata `content:[{text,offset,duration}]` (MILI-GIÂY) -> cues `{start,duration,text}` (GIÂY),
 * cùng schema chunkTranscript() đã dùng. Chỉ nhận mảng — chuỗi phẳng không có mốc thời gian.
 */
function toCues(content) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const c of content) {
    const text = String((c && c.text) || '').replace(/\s+/g, ' ').trim();
    const offset = Number(c && c.offset);
    if (!text || !Number.isFinite(offset) || offset < 0) continue;
    const dur = Number(c.duration);
    out.push({ start: offset / 1000, duration: Number.isFinite(dur) && dur > 0 ? dur / 1000 : 0, text });
  }
  return out;
}

/**
 * Một lệnh gọi Supadata (kể cả poll job 202) dưới `deadline` tuyệt đối.
 * @returns {Promise<{state:'ok', cues:Array, lang:string}|{state:'unavailable'}|{state:'not_found'}|{state:'failed', code:string}>}
 */
async function requestTranscript(client, url, { lang, mode, deadline, pollIntervalMs }) {
  const remaining = () => deadline - Date.now();
  let res;
  try {
    res = await withTimeout(client.transcript({ url, lang, text: false, mode }), remaining(), 'supadata');
    // Job dài: poll tới completed/failed hoặc hết deadline.
    if (res && res.jobId) {
      const jobId = res.jobId;
      for (;;) {
        if (remaining() <= 0) return { state: 'failed', code: 'timeout' };
        await sleep(Math.min(pollIntervalMs, Math.max(1, remaining())));
        const job = await withTimeout(client.transcript.getJobStatus(jobId), remaining(), 'supadata_job');
        if (job && job.status === 'completed') { res = job.result || {}; break; }
        if (job && job.status === 'failed') return unavailableCode(job.error) ? { state: 'unavailable' } : { state: 'failed', code: (job.error && job.error.error) || 'job_failed' };
      }
    }
  } catch (e) {
    const code = (e && (e.error || e.code)) || 'request_failed';
    if (code === 'transcript-unavailable') return { state: 'unavailable' };
    if (code === 'not-found') return { state: 'not_found' };
    return { state: 'failed', code: String(code) };
  }
  if (unavailableCode(res)) return { state: 'unavailable' };
  const cues = toCues(res && res.content);
  if (!cues.length) return { state: 'unavailable' };
  return { state: 'ok', cues, lang: String(res.lang || lang || '') };
}

/** Tiêu đề/kênh: best-effort, KHÔNG bao giờ làm hỏng transcript. */
async function fetchMeta(client, url) {
  try {
    const m = await withTimeout(client.metadata({ url }), METADATA_TIMEOUT_MS, 'supadata_meta');
    return {
      title: m && m.title ? String(m.title).trim() : null,
      author: m && m.author && m.author.displayName ? String(m.author.displayName).trim() : null
    };
  } catch (e) {
    return { title: null, author: null };
  }
}

/**
 * fetchYoutubeSource() — lấy transcript nếu có.
 * opts (chủ yếu cho test): languages, noCache, chunkSeconds, timeoutMs, pollIntervalMs, supadataClient.
 * @returns {Promise<{ok:boolean, status:'READY'|'INCOMPLETE'|'ERROR', videoId?:string, url?:string,
 *   fingerprint?:string, chunks?:Array, extractorVersion?:string, reason?:string, transcriptAvailable:boolean}>}
 */
async function fetchYoutubeSource(rawUrl, opts = {}) {
  const videoId = parseVideoId(rawUrl);
  if (!videoId) return { ok: false, status: 'ERROR', reason: 'invalid_youtube_url', transcriptAvailable: false };

  return singleFlight.run(`youtube::${videoId}`, async () => {
    const url = canonicalUrl(videoId);
    const incomplete = (userMessage, extra = {}) => ({
      ok: false,
      status: 'INCOMPLETE',
      videoId,
      title: `YouTube: ${videoId}`,
      url,
      transcriptAvailable: false,
      reason: 'transcript_unavailable',
      userMessage,
      ...extra
    });

    // Caller truyền languages rỗng (test INV11: nhánh không có transcript) -> không gọi mạng.
    if (Array.isArray(opts.languages) && opts.languages.length === 0) return incomplete(MSG_UNAVAILABLE);

    const langs = opts.languages || ['vi', 'en'];
    // ---------- MỤC 27: CACHE TRANSCRIPT ----------
    const cacheParts = { url: `yt:${videoId}:${langs.join(',')}`, extractorVersion: EXTRACTOR_VERSION };
    const cached = opts.noCache ? null : await contentCache.get(cacheParts);
    if (cached && cached.value) return { ...cached.value, fromCache: true };

    const client = opts.supadataClient || getSupadataClient();
    if (!client) {
      console.warn('[youtubeSource] SUPADATA_API_KEY chưa đặt — không thể đọc transcript YouTube.');
      return incomplete(MSG_NOT_CONFIGURED);
    }

    const deadline = Date.now() + (Number(opts.timeoutMs) || Number(process.env.SUPADATA_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
    const base = { lang: langs[0], deadline, pollIntervalMs: Number(opts.pollIntervalMs) || POLL_INTERVAL_MS };

    // Metadata chạy SONG SONG với lệnh native (không cộng thêm độ trễ).
    const metaP = fetchMeta(client, url);
    let method = 'text-supadata';
    let r = await requestTranscript(client, url, { ...base, mode: 'native' });
    // Chỉ khi video THẬT SỰ không có phụ đề mới gọi AI generate — đúng 1 lần. Lỗi khác (quota, key sai,
    // timeout, not-found) gọi generate cũng vô ích và tốn tiền.
    if (r.state === 'unavailable') {
      method = 'asr-supadata';
      r = await requestTranscript(client, url, { ...base, mode: 'generate' });
    }

    if (r.state === 'not_found') {
      return { ok: false, status: 'ERROR', videoId, url, transcriptAvailable: false, reason: 'video_unavailable',
        userMessage: 'Video YouTube này không tồn tại hoặc ở chế độ riêng tư.' };
    }
    if (r.state !== 'ok') {
      // PHẦN AP/DM/FC-11: không có nội dung truy hồi được -> INCOMPLETE trung thực, không bịa từ tiêu đề.
      if (method === 'asr-supadata') return incomplete(MSG_GENERATE_FAILED);
      return incomplete(r.state === 'failed' ? MSG_SERVICE_FAILED : MSG_UNAVAILABLE);
    }

    const meta = await metaP;
    const payload = {
      ok: true,
      status: 'READY',
      videoId,
      title: meta.title || `YouTube: ${videoId}`,
      author: meta.author || '',
      url,
      language: r.lang || langs[0] || 'vi',
      transcriptAvailable: true,
      ...(method === 'asr-supadata' ? { asrGenerated: true } : {}),
      fingerprint: contentFingerprint(r.cues.map((c) => `${c.start}:${c.text}`).join('\u0000')),
      extractorVersion: EXTRACTOR_VERSION,
      chunks: chunkTranscript(r.cues, { chunkSeconds: opts.chunkSeconds, method })
    };
    await contentCache.set(cacheParts, payload, {});
    return payload;
  });
}

module.exports = {
  fetchYoutubeSource, parseVideoId, canonicalUrl, toCues,
  chunkTranscript, formatTimestamp, EXTRACTOR_VERSION
};
