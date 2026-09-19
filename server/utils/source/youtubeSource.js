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
const contentCache = require('./sourceContentCache');
const singleFlight = require('../singleFlight');

const EXTRACTOR_VERSION = 'yt-transcript-v2';
const TIMEOUT_MS = 8000;
const MAX_BYTES = 4 * 1024 * 1024;
const CHUNK_SECONDS = 90;
const INNERTUBE_CLIENT_VERSION = '20.10.38';
const INNERTUBE_USER_AGENT = `com.google.android.youtube/${INNERTUBE_CLIENT_VERSION} (Linux; U; Android 14)`;
const INNERTUBE_PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';

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

function decodeXmlEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (x, n) => String.fromCodePoint(Number(n)))
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Transcript XML của YouTube -> các đoạn có mốc thời gian. Deterministic, không AI. */
function parseTranscriptXml(xml) {
  const out = [];
  const s = String(xml || '');
  // Format 1 (chuẩn): <text start="1.36" dur="1.68">...</text>
  const reText = /<text start="([\d.]+)"(?:\s+dur="([\d.]+)")?[^>]*>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = reText.exec(s))) {
    const text = decodeXmlEntities(m[3]);
    if (!text) continue;
    out.push({ start: Number(m[1]) || 0, duration: Number(m[2]) || 0, text });
  }
  if (out.length > 0) return out;

  // Format 3 (srv3): <p t="1360" d="1680">...</p> (tính bằng mili-giây)
  const reP = /<p\s+[^>]*?t="(\d+)"(?:\s+d="(\d+)")?[^>]*>([\s\S]*?)<\/p>/g;
  while ((m = reP.exec(s))) {
    const text = decodeXmlEntities(m[3]);
    if (!text) continue;
    out.push({ start: (Number(m[1]) || 0) / 1000, duration: (Number(m[2]) || 0) / 1000, text });
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
    // Nếu caller truyền languages rỗng (như trong test INV11 kiểm tra nhánh không có transcript)
    if (Array.isArray(opts.languages) && opts.languages.length === 0) {
      return {
        ok: false,
        status: 'INCOMPLETE',
        videoId,
        url: canonicalUrl(videoId),
        transcriptAvailable: false,
        reason: 'transcript_unavailable',
        userMessage: 'Video này không có phụ đề/bản ghi lời nên hệ thống chưa đọc được nội dung. Hãy cung cấp bản ghi hoặc nguồn khác.'
      };
    }

    const langs = opts.languages || ['vi', 'en'];
    // ---------- MỤC 27: CACHE TRANSCRIPT ----------
    const cacheParts = {
      url: `yt:${videoId}:${langs.join(',')}`,
      extractorVersion: EXTRACTOR_VERSION
    };
    const cached = opts.noCache ? null : await contentCache.get(cacheParts);
    if (cached && cached.value) return { ...cached.value, fromCache: true };

    // 1. Gọi Innertube Android Player API để lấy metadata video & danh sách captionTracks có chữ ký
    const postData = JSON.stringify({
      context: {
        client: {
          clientName: 'ANDROID',
          clientVersion: INNERTUBE_CLIENT_VERSION,
          hl: langs[0] || 'vi',
          gl: 'VN'
        }
      },
      videoId
    });

    let playerRes;
    try {
      playerRes = await safeHttp.fetchPinned(new URL(INNERTUBE_PLAYER_URL), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(postData)),
          'User-Agent': INNERTUBE_USER_AGENT
        },
        body: postData,
        maxBytes: opts.maxBytes || MAX_BYTES,
        timeoutMs: opts.timeoutMs || TIMEOUT_MS
      });
    } catch (e) {
      playerRes = { ok: false, reason: 'fetch_failed' };
    }

    let videoTitle = null;
    let videoAuthor = null;
    let captionTracks = [];

    if (playerRes.ok && playerRes.status === 200 && playerRes.body && playerRes.body.length) {
      try {
        const data = JSON.parse(playerRes.body.toString('utf8'));
        if (data.playabilityStatus && data.playabilityStatus.status === 'ERROR') {
          return {
            ok: false,
            status: 'ERROR',
            videoId,
            url: canonicalUrl(videoId),
            transcriptAvailable: false,
            reason: 'video_unavailable',
            userMessage: data.playabilityStatus.reason || 'Video YouTube này không tồn tại hoặc ở chế độ riêng tư.'
          };
        }
        videoTitle = data.videoDetails && data.videoDetails.title ? String(data.videoDetails.title).trim() : null;
        videoAuthor = data.videoDetails && data.videoDetails.author ? String(data.videoDetails.author).trim() : null;
        captionTracks = Array.isArray(data.captions?.playerCaptionsTracklistRenderer?.captionTracks)
          ? data.captions.playerCaptionsTracklistRenderer.captionTracks
          : [];
      } catch (e) {
        // Parse JSON lỗi -> tiếp tục fallback
      }
    }

    // Sắp xếp các track ưu tiên theo ngôn ngữ người dùng yêu cầu
    const orderedTracks = [];
    if (captionTracks.length) {
      for (const lang of langs) {
        const match = captionTracks.filter((t) => t.languageCode === lang || String(t.languageCode || '').startsWith(lang + '-'));
        orderedTracks.push(...match);
      }
      for (const t of captionTracks) {
        if (!orderedTracks.includes(t)) {
          orderedTracks.push(t);
        }
      }
    }

    // Thử tải phụ đề từ các captionTrack đã ký
    for (const track of orderedTracks) {
      if (!track.baseUrl) continue;
      const trackUrl = String(track.baseUrl).replace('&fmt=srv3', '');
      let capRes;
      try {
        capRes = await safeHttp.fetchPinned(new URL(trackUrl), {
          headers: { 'User-Agent': INNERTUBE_USER_AGENT },
          maxBytes: opts.maxBytes || MAX_BYTES,
          timeoutMs: opts.timeoutMs || TIMEOUT_MS
        });
      } catch (e) {
        capRes = { ok: false, reason: 'fetch_failed' };
      }
      if (!capRes.ok || capRes.status !== 200 || !capRes.body || !capRes.body.length) continue;
      const cues = parseTranscriptXml(capRes.body.toString('utf8'));
      if (!cues.length) continue;

      const chunks = chunkTranscript(cues, opts);
      const payload = {
        ok: true,
        status: 'READY',
        videoId,
        title: videoTitle || `YouTube: ${videoId}`,
        author: videoAuthor || '',
        url: canonicalUrl(videoId),
        language: track.languageCode || langs[0] || 'vi',
        transcriptAvailable: true,
        fingerprint: contentFingerprint(cues.map((c) => `${c.start}:${c.text}`).join('\u0000')),
        extractorVersion: EXTRACTOR_VERSION,
        chunks
      };
      await contentCache.set(cacheParts, payload, {});
      return payload;
    }

    // Fallback: nếu không có captionTracks hoặc tải qua Android thất bại, thử endpoint timedtext truyền thống
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
      const payload = {
        ok: true,
        status: 'READY',
        videoId,
        title: videoTitle || `YouTube: ${videoId}`,
        author: videoAuthor || '',
        url: canonicalUrl(videoId),
        language: lang,
        transcriptAvailable: true,
        fingerprint: contentFingerprint(cues.map((c) => `${c.start}:${c.text}`).join('\u0000')),
        extractorVersion: EXTRACTOR_VERSION,
        chunks
      };
      await contentCache.set(cacheParts, payload, {});
      return payload;
    }

    // PHẦN AP/DM/FC-11: KHÔNG có transcript = KHÔNG có nội dung. Trả INCOMPLETE và dừng ở đó.
    return {
      ok: false,
      status: 'INCOMPLETE',
      videoId,
      title: videoTitle || `YouTube: ${videoId}`,
      url: canonicalUrl(videoId),
      transcriptAvailable: false,
      reason: 'transcript_unavailable',
      userMessage: 'Video này không có phụ đề/bản ghi lời nên hệ thống chưa đọc được nội dung. Hãy cung cấp bản ghi hoặc nguồn khác.'
    };
  });
}

module.exports = {
  fetchYoutubeSource, parseVideoId, canonicalUrl, parseTranscriptXml,
  chunkTranscript, formatTimestamp, EXTRACTOR_VERSION
};
