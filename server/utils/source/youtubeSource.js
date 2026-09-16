'use strict';

// ============================================================================================
// PHẦN AO + AP + AQ + CO + FC-11 — NGUỒN YOUTUBE
// ============================================================================================
// Ranh giới quan trọng nhất ở đây KHÔNG phải token mà là TRUNG THỰC: nếu không lấy được transcript
// thì hệ thống PHẢI nói "chưa đọc được nội dung video", tuyệt đối không dùng tiêu đề/mô tả để suy ra
// nội dung rồi trình bày như thể đã xem (PHẦN FA). Một câu trả lời bịa nghe rất trôi chảy vẫn là
// câu trả lời sai.
//
// Về token: transcript 1 giờ ≈ 60–90k ký tự. Gửi nguyên là vô nghĩa khi câu hỏi chỉ cần 2 phút —
// nên transcript được cắt theo MỐC THỜI GIAN, và retrieval chọn đúng mốc liên quan.

const safeHttp = require('../safeHttp');
const { contentFingerprint } = require('../queryFingerprint');
const singleFlight = require('../singleFlight');

const EXTRACTOR_VERSION = 'yt-transcript-v1';
const TIMEOUT_MS = 8000;
const MAX_BYTES = 4 * 1024 * 1024;
const CHUNK_SECONDS = 90;

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

/** Transcript XML của YouTube -> các đoạn có mốc thời gian. Deterministic, không AI. */
function parseTranscriptXml(xml) {
  const out = [];
  const re = /<text start="([\d.]+)"(?:\s+dur="([\d.]+)")?[^>]*>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = re.exec(String(xml || '')))) {
    const text = m[3]
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (x, n) => String.fromCodePoint(Number(n)))
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    out.push({ start: Number(m[1]) || 0, duration: Number(m[2]) || 0, text });
  }
  return out;
}

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
 */
function chunkTranscript(cues, { chunkSeconds = CHUNK_SECONDS } = {}) {
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
    text: c.text.replace(/\s+/g, ' ').trim()
  }));
}

/**
 * fetchYoutubeSource() — lấy transcript nếu có.
 * @returns {Promise<{ok:boolean, status:'READY'|'INCOMPLETE'|'ERROR', videoId?:string, url?:string,
 *   fingerprint?:string, chunks?:Array, extractorVersion?:string, reason?:string, transcriptAvailable:boolean}>}
 */
async function fetchYoutubeSource(rawUrl, opts = {}) {
  const videoId = parseVideoId(rawUrl);
  if (!videoId) return { ok: false, status: 'ERROR', reason: 'invalid_youtube_url', transcriptAvailable: false };

  return singleFlight.run(`youtube::${videoId}`, async () => {
    const langs = opts.languages || ['vi', 'en'];
    for (const lang of langs) {
      const url = new URL(`https://www.youtube.com/api/timedtext?v=${encodeURIComponent(videoId)}&lang=${encodeURIComponent(lang)}`);
      let res;
      try {
        res = await safeHttp.fetchPinned(url, { maxBytes: opts.maxBytes || MAX_BYTES, timeoutMs: opts.timeoutMs || TIMEOUT_MS });
      } catch (e) {
        res = { ok: false, reason: 'fetch_failed' };
      }
      if (!res.ok || res.location || res.status !== 200 || !res.body || !res.body.length) continue;
      const cues = parseTranscriptXml(res.body.toString('utf8'));
      if (!cues.length) continue;
      const chunks = chunkTranscript(cues, opts);
      return {
        ok: true,
        status: 'READY',
        videoId,
        url: canonicalUrl(videoId),
        language: lang,
        transcriptAvailable: true,
        // PHẦN CA: transcript đổi (video được sửa phụ đề) -> fingerprint đổi -> evidence cũ hết hiệu lực.
        fingerprint: contentFingerprint(cues.map((c) => `${c.start}:${c.text}`).join('\u0000')),
        extractorVersion: EXTRACTOR_VERSION,
        chunks
      };
    }
    // PHẦN AP/DM/FC-11: KHÔNG có transcript = KHÔNG có nội dung. Trả INCOMPLETE và dừng ở đó.
    return {
      ok: false,
      status: 'INCOMPLETE',
      videoId,
      url: canonicalUrl(videoId),
      transcriptAvailable: false,
      reason: 'transcript_unavailable',
      // Thông điệp này đi thẳng ra UI: nói rõ hệ thống CHƯA đọc được video, không bịa nội dung.
      userMessage: 'Video này không có phụ đề/bản ghi lời nên hệ thống chưa đọc được nội dung. Hãy cung cấp bản ghi hoặc nguồn khác.'
    };
  });
}

module.exports = {
  fetchYoutubeSource, parseVideoId, canonicalUrl, parseTranscriptXml,
  chunkTranscript, formatTimestamp, EXTRACTOR_VERSION
};
