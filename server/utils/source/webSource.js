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
// MỤC 26: cache NỘI DUNG (không phải HTML thô), bền qua nhiều request — singleFlight chỉ chống
// trùng ĐỒNG THỜI, không thay thế được cache.
const contentCache = require('./sourceContentCache');

// V6: bump version -> cache miss để chunks mới có sectionAnchor + charStart (locator cho web).
const EXTRACTOR_VERSION = 'web-extract-v2-anchor';
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
  // MỤC 53: chỉ ưu tiên <article>/<main> khi vùng đó THỰC SỰ chứa nội dung. Nhiều trang khai báo
  // <main> chỉ để bọc một thanh điều hướng, hoặc nội dung thật được nạp bằng JS vào chỗ khác — khi
  // đó bản cũ gửi cho model một nguồn gần như trống rồi vẫn báo READY. So sánh độ dài trước/sau:
  // vùng "nội dung chính" mà nhỏ hơn 30% toàn thân (hoặc dưới 400 ký tự) thì không đáng tin.
  if (main) {
    const candidate = main[2];
    const bodyLen = body.length;
    if (candidate.length >= 400 && candidate.length >= bodyLen * 0.3) body = candidate;
  }

  // V6 — SECTION ANCHOR: đánh dấu heading (h1-h4) bằng sentinel §H§...§/H§ để giai đoạn strip HTML
  // dưới đây không mất — sau khi có plain-text, chunkText() sẽ đọc sentinel để gán sectionAnchor
  // cho từng chunk. Sentinel chọn ký tự Unicode PUA không xung đột với nội dung tiếng Việt/toán.
  const bodyWithAnchors = body.replace(
    /<h([1-4])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_, lvl, inner) => `\n\n\uE010H${lvl}\uE011${inner.replace(/<[^>]+>/g, ' ')}\uE012/H\uE013\n\n`
  );

  const text = decodeEntities(
    bodyWithAnchors
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|section)>/gi, '\n\n')
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
// V6 — sentinel regex cho heading marker do extractReadableText() chèn.
const HEADING_MARKER_RE = /\uE010H([1-4])\uE011([\s\S]*?)\uE012\/H\uE013/g;

function chunkText(text, { chunkChars = CHUNK_CHARS } = {}) {
  // V6 — Tách heading ra bảng riêng (level, position, text) TRƯỚC KHI xoá sentinel khỏi paragraph.
  const rawText = String(text || '');
  const headings = [];
  {
    let m;
    HEADING_MARKER_RE.lastIndex = 0;
    while ((m = HEADING_MARKER_RE.exec(rawText)) !== null) {
      const hTxt = m[2].replace(/\s+/g, ' ').trim();
      if (hTxt) headings.push({ pos: m.index, level: Number(m[1]), text: hTxt.slice(0, 160) });
    }
  }
  // Cleaned text KHÔNG còn sentinel (để không lộ ký tự PUA cho model).
  const cleanText = rawText.replace(HEADING_MARKER_RE, (_, __, inner) => inner.replace(/\s+/g, ' ').trim());

  const paragraphs = cleanText.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let buf = '';
  let bufStart = 0;
  let scanCursor = 0;
  paragraphs.forEach((p) => {
    const idx = cleanText.indexOf(p, scanCursor);
    if (idx >= 0) scanCursor = idx + p.length;
    if (buf && (buf.length + p.length + 2) > chunkChars) {
      chunks.push({ text: buf, charStart: bufStart });
      buf = '';
    }
    if (!buf) bufStart = idx >= 0 ? idx : scanCursor;
    buf = buf ? `${buf}\n\n${p}` : p;
    while (buf.length > chunkChars * 1.6) {
      chunks.push({ text: buf.slice(0, chunkChars), charStart: bufStart });
      buf = buf.slice(chunkChars);
      bufStart += chunkChars;
    }
  });
  if (buf) chunks.push({ text: buf, charStart: bufStart });

  // V6 — Gán sectionAnchor cho từng chunk: heading gần nhất ĐỨNG TRƯỚC vị trí charStart của chunk
  // trong TEXT GỐC (vị trí sentinel — không phải cleanText). Vì cleanText đã xoá sentinel, ta phải
  // dùng offset khác: đếm delta ký tự do sentinel gây ra. Đơn giản hoá: nếu số heading nhỏ (< 200),
  // duyệt tuần tự và ước lượng bằng số ký tự cleanText đã sinh ra tính đến pos đó trong rawText.
  const anchorAt = (cleanPos) => {
    // Ước lượng vị trí tương ứng trong rawText: chạy tăng dần dến khi rawPos - (accumulated sentinel
    // chars đã bỏ) >= cleanPos.
    let raw = 0;
    let clean = 0;
    HEADING_MARKER_RE.lastIndex = 0;
    let lastAnchor = null;
    let m;
    while ((m = HEADING_MARKER_RE.exec(rawText)) !== null) {
      const before = rawText.slice(raw, m.index);
      clean += before.length;
      if (clean > cleanPos) break;
      const innerClean = m[2].replace(/\s+/g, ' ').trim();
      lastAnchor = { level: Number(m[1]), text: innerClean.slice(0, 160) };
      clean += innerClean.length;
      raw = m.index + m[0].length;
    }
    return lastAnchor;
  };

  return chunks.map((c, i) => {
    const anchor = headings.length ? anchorAt(c.charStart) : null;
    return {
      chunkIndex: i + 1,
      totalChunks: chunks.length,
      text: c.text,
      charStart: c.charStart,
      // sectionAnchor: heading (h1-h4) gần nhất ĐỨNG TRƯỚC chunk trong tài liệu gốc — dùng cho
      // trích nguồn kiểu "đoạn <title>" bên phía client + promptBuilder.
      sectionAnchor: anchor ? anchor.text : null,
      sectionLevel: anchor ? anchor.level : null
    };
  });
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
    // ---------- MỤC 26: CACHE TRƯỚC, MẠNG SAU ----------
    const cacheParts = { url, extractorVersion: EXTRACTOR_VERSION };
    const cached = opts.noCache ? null : await contentCache.get(cacheParts);
    if (cached && cached.value) {
      return { ...cached.value, fromCache: true, cacheLayer: contentCache.hasPersistentLayer() ? 'L1/L2' : 'L1' };
    }

    let current = parsed;
    for (let hop = 0; hop < 3; hop++) {
      const res = await safeHttp.fetchPinned(current, {
        maxBytes: opts.maxBytes || MAX_BYTES,
        timeoutMs: opts.timeoutMs || TIMEOUT_MS,
        // Revalidate nếu lần trước server có trả ETag/Last-Modified (bản cache đã hết TTL nhưng
        // nội dung có thể chưa đổi -> 304, không tốn băng thông lẫn thời gian phân tích lại).
        headers: contentCache.conditionalHeaders(cached)
      });
      if (!res.ok) return { ok: false, status: 'ERROR', reason: res.reason || 'fetch_failed', url };
      // 304 Not Modified: bản đã trích trước đó vẫn đúng.
      if (res.status === 304 && cached && cached.value) {
        await contentCache.set(cacheParts, cached.value, { etag: cached.etag, lastModified: cached.lastModified });
        return { ...cached.value, fromCache: true, revalidated: true };
      }
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
      const payload = {
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
      await contentCache.set(cacheParts, payload, {
        etag: res.headers && res.headers.etag,
        lastModified: res.headers && res.headers['last-modified']
      });
      return payload;
    }
    return { ok: false, status: 'ERROR', reason: 'too_many_redirects', url };
  });
}

module.exports = { fetchWebSource, extractReadableText, chunkText, decodeEntities, EXTRACTOR_VERSION, MAX_BYTES, contentCache };
