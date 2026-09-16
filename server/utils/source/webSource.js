'use strict';

// ============================================================================================
// PHẦN AK + AL + AM + AN + CN — NGUỒN WEB
// ============================================================================================
// Hai sai lầm phải tránh cùng lúc:
//   1. Bảo mật: fetch một URL do người dùng đưa là mở cửa SSRF. Dùng lại safeHttp (DNS -> chặn dải
//      nội bộ -> GHIM IP -> trần byte trên luồng). Không có whitelist domain ở đây (web là web), nên
//      lớp chặn địa chỉ nội bộ là thứ duy nhất đứng giữa — nó phải áp cho CẢ redirect.
//   2. Token: nhét HTML thô vào model là cách đốt tiền nhanh nhất — nav/footer/script/ads chiếm phần
//      lớn byte và không mang thông tin nào. HTML -> text sạch -> chunk -> chỉ gửi chunk liên quan.

const safeHttp = require('../safeHttp');
const { normalizeUrl, contentFingerprint } = require('../queryFingerprint');
const singleFlight = require('../singleFlight');

const EXTRACTOR_VERSION = 'web-extract-v1';
const MAX_BYTES = 2 * 1024 * 1024;   // trang tin bình thường < 500KB; đây là trần chống bomb
const TIMEOUT_MS = 8000;
const CHUNK_CHARS = 1200;

/** Thẻ có nội dung KHÔNG BAO GIỜ là nội dung bài viết — xoá cả phần bên trong. */
const DROP_BLOCKS = /<(script|style|noscript|svg|canvas|iframe|form|nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };

function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code) => {
    const key = code.toLowerCase();
    if (ENTITIES[key] !== undefined) return ENTITIES[key];
    if (key[0] === '#') {
      const n = key[1] === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return m;
  });
}

/** @returns {{title:string, text:string}} văn bản sạch, giữ ranh giới đoạn (để chunk theo đoạn). */
function extractReadableText(html) {
  const raw = String(html || '');
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim().slice(0, 200) : '';

  let body = raw.replace(DROP_BLOCKS, ' ');
  const main = /<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(body);
  if (main) body = main[2]; // ưu tiên vùng nội dung thật nếu trang khai báo rõ

  const text = decodeEntities(
    body
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr|section)>/gi, '\n\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim();

  return { title, text };
}

/** Chunk theo ĐOẠN (deterministic — PHẦN BG: không dùng AI để cắt đoạn). */
function chunkText(text, { chunkChars = CHUNK_CHARS } = {}) {
  const paragraphs = String(text || '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let buf = '';
  paragraphs.forEach((p) => {
    if (buf && (buf.length + p.length + 2) > chunkChars) { chunks.push(buf); buf = ''; }
    buf = buf ? `${buf}\n\n${p}` : p;
    while (buf.length > chunkChars * 1.6) { chunks.push(buf.slice(0, chunkChars)); buf = buf.slice(chunkChars); }
  });
  if (buf) chunks.push(buf);
  return chunks.map((text2, i) => ({ chunkIndex: i + 1, totalChunks: chunks.length, text: text2 }));
}

/**
 * fetchWebSource() — trả evidence đã sạch, KHÔNG trả HTML.
 * @returns {Promise<{ok:boolean, status:string, url?:string, title?:string, fingerprint?:string,
 *   chunks?:Array, extractorVersion?:string, reason?:string}>}
 */
async function fetchWebSource(rawUrl, opts = {}) {
  const url = normalizeUrl(rawUrl);
  if (!url) return { ok: false, status: 'ERROR', reason: 'invalid_url' };
  let parsed;
  try { parsed = new URL(url); } catch (e) { return { ok: false, status: 'ERROR', reason: 'invalid_url' }; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return { ok: false, status: 'ERROR', reason: 'unsupported_protocol' };
  if (parsed.protocol !== 'https:') return { ok: false, status: 'ERROR', reason: 'https_required' };

  // PHẦN BH/CC: hai code path (hoặc hai request đồng thời) cùng một URL -> đúng MỘT lần fetch.
  return singleFlight.run(`web::${url}`, async () => {
    let current = parsed;
    for (let hop = 0; hop < 3; hop++) {
      const res = await safeHttp.fetchPinned(current, { maxBytes: opts.maxBytes || MAX_BYTES, timeoutMs: opts.timeoutMs || TIMEOUT_MS });
      if (!res.ok) return { ok: false, status: 'ERROR', reason: res.reason || 'fetch_failed', url };
      if (res.location) {
        let next;
        try { next = new URL(res.location, current); } catch (e) { return { ok: false, status: 'ERROR', reason: 'bad_redirect', url }; }
        if (next.protocol !== 'https:') return { ok: false, status: 'ERROR', reason: 'redirect_not_https', url };
        current = next; // vòng sau lại kiểm DNS + dải nội bộ cho chính địa chỉ mới này
        continue;
      }
      if (res.status < 200 || res.status >= 300) return { ok: false, status: 'ERROR', reason: `http_${res.status}`, url };
      const ctype = String(res.headers['content-type'] || '');
      if (ctype && !/text\/html|application\/xhtml|text\/plain/i.test(ctype)) {
        return { ok: false, status: 'ERROR', reason: 'unsupported_content_type', url };
      }
      const html = res.body.toString('utf8');
      const { title, text } = extractReadableText(html);
      if (!text || text.length < 80) return { ok: false, status: 'INCOMPLETE', reason: 'no_readable_text', url, title };
      return {
        ok: true,
        status: 'READY',
        url: normalizeUrl(current.toString()),
        title,
        // PHẦN AN/CA: fingerprint theo NỘI DUNG đã trích, không theo byte HTML — quảng cáo đổi mỗi
        // lần tải không được tính là "nội dung đã thay đổi".
        fingerprint: contentFingerprint(text),
        extractorVersion: EXTRACTOR_VERSION,
        chunks: chunkText(text, opts)
      };
    }
    return { ok: false, status: 'ERROR', reason: 'too_many_redirects', url };
  });
}

module.exports = { fetchWebSource, extractReadableText, chunkText, decodeEntities, EXTRACTOR_VERSION, MAX_BYTES };
