'use strict';

// ============================================================================================
// MỤC 2 (backlog v6.22) — LỚP B: thư viện ngoài, CHỈ chạy khi Lớp A (tự viết, có/không proxy) trả
// INCOMPLETE, và ĐỨNG TRƯỚC bước ASR Gemini (ASR vẫn là lưới an toàn cuối: Gemini tự tải video từ hạ
// tầng Google nên KHÔNG bị chặn theo IP outbound của server mình).
//
// Thứ tự thử:
//   1. youtubei.js (bảo trì tích cực; tiêm `fetch` tuỳ chỉnh -> proxy ĐÚNG PHẠM VI, không đụng global)
//   2. youtube-transcript (nhẹ; v1.3.1 CÓ tham số `fetch` per-call nên proxy cũng đúng phạm vi —
//      master prompt v6.22 nói "không có tham số proxy per-call", đã xác minh lại trên bản cài thật: SAI,
//      không cần setGlobalDispatcher)
//   3. @distube/ytdl-core: CỐ Ý KHÔNG thêm — chính trang gói ghi "sẽ không còn được bảo trì". Không thêm
//      nợ kỹ thuật có hạn dùng khi (1) và (2) đã phủ; ghi rõ trong FIX-REPORT.
//
// Mọi nhánh trả về ĐÚNG schema cues `{start,duration,text}` của parseTranscriptXml() để tái dùng
// chunkTranscript(); `method` khắc tên thư viện lên từng chunk (trung thực nguồn, như field `method` cũ).
//
// Proxy: undici ProxyAgent/Socks5ProxyAgent truyền qua `dispatcher` CỦA TỪNG LỆNH FETCH — không gọi
// setGlobalDispatcher (tránh rò sang lệnh gọi AI provider chạy song song trong cùng tiến trình).
// Chỉ host miền YouTube đi qua proxy (cùng PROXY_ALLOWED_HOST_RE với fetchPinned); host khác đi thẳng.

const { PROXY_ALLOWED_HOST_RE } = require('../safeHttp');

const METHOD_YOUTUBEI = 'text-youtubeijs';
const METHOD_YT_TRANSCRIPT = 'text-youtube-transcript';

/** Bật mặc định (chỉ thêm cơ hội thử, không tốn tiền/không gọi AI). Tắt: YOUTUBE_FALLBACK_LIB_ENABLED=false */
function isEnabled() {
  return String(process.env.YOUTUBE_FALLBACK_LIB_ENABLED || 'true').toLowerCase() !== 'false';
}

const dispatcherCache = new Map();
function buildDispatcher(proxyUrl) {
  if (dispatcherCache.has(proxyUrl)) return dispatcherCache.get(proxyUrl);
  const undici = require('undici');
  const protocol = new URL(proxyUrl).protocol;
  let d = null;
  if (protocol === 'http:' || protocol === 'https:') d = new undici.ProxyAgent(proxyUrl);
  else if ((protocol === 'socks5:' || protocol === 'socks5h:') && typeof undici.Socks5ProxyAgent === 'function') d = new undici.Socks5ProxyAgent(proxyUrl);
  dispatcherCache.set(proxyUrl, d); // null = giao thức không hỗ trợ cho lớp B (socks4) -> đi thẳng
  return d;
}

/**
 * fetch tuỳ chỉnh: host YouTube đi qua proxy (nếu có), còn lại dùng fetch mặc định.
 * @param {string|null} proxyUrl
 * @param {Function} [baseFetch] (test tiêm vào)
 */
function makeScopedFetch(proxyUrl, baseFetch) {
  const base = baseFetch || ((...a) => globalThis.fetch(...a));
  if (!proxyUrl) return base;
  let dispatcher = null;
  try { dispatcher = buildDispatcher(proxyUrl); } catch (e) { dispatcher = null; }
  if (!dispatcher) return base;
  const undiciFetch = (...a) => require('undici').fetch(...a);
  return (input, init) => {
    let host = '';
    try { host = new URL(typeof input === 'string' ? input : (input && input.url) || String(input)).hostname; } catch (e) { host = ''; }
    if (!PROXY_ALLOWED_HOST_RE.test(host)) return base(input, init);
    return (baseFetch ? baseFetch : undiciFetch)(input, { ...(init || {}), dispatcher });
  };
}

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error(`${label} timeout`), { code: 'LIB_TIMEOUT' })), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** youtubei.js: getInfo -> getTranscript -> segments (start_ms/end_ms là chuỗi ms). */
async function viaYoutubei(videoId, { langs = [], proxyUrl = null, timeoutMs = 15000, loader, fetchImpl } = {}) {
  const mod = loader ? await loader() : await import('youtubei.js');
  const Innertube = mod.Innertube || (mod.default && mod.default.Innertube) || mod.default;
  const yt = await withTimeout(Innertube.create({ fetch: makeScopedFetch(proxyUrl, fetchImpl), lang: langs[0] || 'vi' }), timeoutMs, 'youtubei.create');
  const info = await withTimeout(yt.getInfo(videoId), timeoutMs, 'youtubei.getInfo');
  let tr = await withTimeout(info.getTranscript(), timeoutMs, 'youtubei.getTranscript');
  // Ưu tiên ngôn ngữ người dùng yêu cầu nếu track đó có; lỗi chọn ngôn ngữ -> dùng bản mặc định.
  try {
    const avail = tr.languages || [];
    const want = langs.find((l) => avail.some((a) => String(a).toLowerCase().startsWith(l)));
    const cur = String(tr.selectedLanguage || '').toLowerCase();
    if (want && !cur.startsWith(want)) {
      const target = avail.find((a) => String(a).toLowerCase().startsWith(want));
      if (target) tr = await withTimeout(tr.selectLanguage(target), timeoutMs, 'youtubei.selectLanguage');
    }
  } catch (e) { /* giữ bản mặc định */ }
  const segs = (tr && tr.transcript && tr.transcript.content && tr.transcript.content.body && tr.transcript.content.body.initial_segments) || [];
  const cues = [];
  for (const s of segs) {
    if (s.start_ms == null || s.end_ms == null) continue; // TranscriptSectionHeader không có mốc thời gian
    const text = clean(s.snippet && (s.snippet.text != null ? s.snippet.text : s.snippet.toString && s.snippet.toString()));
    if (!text) continue;
    const start = (Number(s.start_ms) || 0) / 1000;
    cues.push({ start, duration: Math.max(0, ((Number(s.end_ms) || 0) / 1000) - start), text });
  }
  return { cues, language: tr && tr.selectedLanguage ? String(tr.selectedLanguage) : null, method: METHOD_YOUTUBEI };
}

/** youtube-transcript: fetchTranscript(id, {lang, fetch}) -> [{text, duration, offset(giây? ms?)}]. */
async function viaYoutubeTranscript(videoId, { langs = [], proxyUrl = null, timeoutMs = 15000, loader, fetchImpl } = {}) {
  const mod = loader ? await loader() : require('youtube-transcript');
  const fetchTranscript = mod.fetchTranscript || (mod.YoutubeTranscript && mod.YoutubeTranscript.fetchTranscript.bind(mod.YoutubeTranscript));
  const f = makeScopedFetch(proxyUrl, fetchImpl);
  let rows = null; let lastErr = null;
  for (const lang of (langs.length ? langs : [undefined])) {
    try { rows = await withTimeout(fetchTranscript(videoId, { ...(lang ? { lang } : {}), fetch: f }), timeoutMs, 'youtube-transcript'); if (rows && rows.length) break; } catch (e) { lastErr = e; }
  }
  if (!rows || !rows.length) { if (lastErr) throw lastErr; return { cues: [], language: null, method: METHOD_YT_TRANSCRIPT }; }
  // ĐÃ ĐỌC dist/commonjs/index.js của youtube-transcript@1.3.1: định dạng srv3 trả offset/duration
  // dạng SỐ NGUYÊN mili-giây; định dạng classic <text start="1.36"> trả SỐ THỰC theo GIÂY (parseFloat).
  // Thư viện không cho biết đã dùng định dạng nào -> phân biệt bằng kiểu số: có bất kỳ giá trị không
  // nguyên => giây; toàn số nguyên => mili-giây (classic của YouTube luôn có phần thập phân).
  const isMs = rows.every((r) => Number.isInteger(Number(r.offset)) && Number.isInteger(Number(r.duration)));
  const div = isMs ? 1000 : 1;
  const cues = rows.map((r) => ({ start: (Number(r.offset) || 0) / div, duration: (Number(r.duration) || 0) / div, text: clean(r.text) })).filter((c) => c.text);
  return { cues, language: (rows[0] && rows[0].lang) || null, method: METHOD_YT_TRANSCRIPT };
}

/**
 * Thử lần lượt các thư viện; trả bản đầu tiên có cues, hoặc null. KHÔNG bao giờ ném ra ngoài
 * (mọi lỗi thư viện chỉ có nghĩa là "nhánh này không lấy được" -> tiếp tục xuống ASR).
 * @returns {Promise<{cues:Array, language:string|null, method:string}|null>}
 */
async function tryFallbackLibs(videoId, opts = {}) {
  if (!isEnabled()) return null;
  const attempts = opts.attempts || [viaYoutubei, viaYoutubeTranscript];
  for (const fn of attempts) {
    try {
      const r = await fn(videoId, opts);
      if (r && Array.isArray(r.cues) && r.cues.length) return r;
    } catch (e) { /* thư viện hỏng/bị chặn -> thử tiếp */ }
  }
  return null;
}

module.exports = { isEnabled, tryFallbackLibs, viaYoutubei, viaYoutubeTranscript, makeScopedFetch, METHOD_YOUTUBEI, METHOD_YT_TRANSCRIPT };
