'use strict';

// ============================================================================================
// PHẦN AK + AL + AM + AN + CN — NGUỒN WEB (v6.23: Readability + jsdom, Firecrawl dự phòng)
// ============================================================================================
// Hai sai lầm phải tránh cùng lúc:
//   1. Bảo mật: fetch một URL do người dùng đưa là mở cửa SSRF. Dùng lại safeHttp (DNS -> chặn dải
//      nội bộ -> GHIM IP -> trần byte trên luồng). Không có whitelist domain ở đây (web là web), nên
//      lớp chặn địa chỉ nội bộ là thứ duy nhất đứng giữa — nó phải áp cho CẢ redirect.
//      Firecrawl CHỈ được gọi cho URL đã qua lớp này (không bao giờ cho URL bị chặn nội bộ).
//   2. Token: nhét HTML thô vào model là cách đốt tiền nhanh nhất — nav/footer/script/ads chiếm phần
//      lớn byte và không mang thông tin nào. HTML -> Readability -> text sạch -> chunk -> chỉ gửi chunk liên quan.
//
// jsdom ở đây CHỈ để parse DOM: không chạy script, không tải tài nguyên con (mặc định của jsdom) —
// nên không tạo thêm đường ra mạng nào ngoài safeHttp.

const safeHttp = require('../safeHttp');
const { normalizeUrl, contentFingerprint } = require('../queryFingerprint');
const singleFlight = require('../singleFlight');
// MỤC 26: cache NỘI DUNG (không phải HTML thô), bền qua nhiều request — singleFlight chỉ chống
// trùng ĐỒNG THỜI, không thay thế được cache.
const contentCache = require('./sourceContentCache');

// v6.23: bump -> cache miss, chunk mới mang extractionMethod + nội dung do Readability lọc.
const EXTRACTOR_VERSION = 'web-extract-v3-readability';
const MAX_BYTES = 2 * 1024 * 1024;   // trang tin bình thường < 500KB; đây là trần chống bomb
const TIMEOUT_MS = 8000;
const CHUNK_CHARS = 1200;
const MIN_TEXT_CHARS = 80;
const FIRECRAWL_TIMEOUT_MS = 12000;
// Trần số phần tử DOM Readability chịu parse (chống trang khổng lồ đốt CPU) — vượt là throw -> coi như không đọc được.
const MAX_ELEMS_TO_PARSE = 30000;
// Trang chặn bot (Cloudflare...) trả các status này khi tải thẳng — Firecrawl (trình duyệt thật) có thể vượt được.
const ANTIBOT_STATUS = new Set([403, 429, 503]);

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


/** HTML (đã lọc rác) -> text sạch, heading h1-h4 thành sentinel để chunkText() gán sectionAnchor. */
function htmlToAnchoredText(html) {
  // V6 — SECTION ANCHOR: đánh dấu heading (h1-h4) bằng sentinel §H§...§/H§ để giai đoạn strip HTML
  // dưới đây không mất — sau khi có plain-text, chunkText() sẽ đọc sentinel để gán sectionAnchor
  // cho từng chunk. Sentinel chọn ký tự Unicode PUA không xung đột với nội dung tiếng Việt/toán.
  const bodyWithAnchors = String(html || '').replace(
    /<h([1-4])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_, lvl, inner) => `\n\n\uE010H${lvl}\uE011${inner.replace(/<[^>]+>/g, ' ')}\uE012/H\uE013\n\n`
  );
  return normalizeText(decodeEntities(
    bodyWithAnchors
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|section)>/gi, '\n\n')
      .replace(/<[^>]+>/g, ' ')
  ));
}

function normalizeText(s) {
  return s
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim();
}

/** Markdown của Firecrawl -> cùng dạng text + sentinel như nhánh HTML (dòng `#`..`####`, bỏ qua trong code fence). */
function markdownToAnchoredText(md) {
  let inFence = false;
  const lines = String(md || '').split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return line; }
    if (inFence) return line;
    const h = /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!h) return line;
    return `\n\n\uE010H${h[1].length}\uE011${h[2]}\uE012/H\uE013\n\n`;
  });
  return normalizeText(
    lines.join('\n')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')            // ảnh: không mang chữ
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')          // link -> chỉ giữ chữ hiển thị
  );
}

/** Readability trên DOM jsdom. @returns {{title:string, content:string}|null} — null nếu không bóc được. */
function readabilityParse(html, url) {
  let dom = null;
  try {
    // Nạp lười: jsdom nặng, không trả phí nạp cho route/test không dùng tới.
    const { JSDOM, VirtualConsole } = require('jsdom');
    const { Readability } = require('@mozilla/readability');
    dom = new JSDOM(html, { url: url || undefined, virtualConsole: new VirtualConsole() }); // không script, không tải tài nguyên
    const article = new Readability(dom.window.document, { maxElemsToParse: MAX_ELEMS_TO_PARSE }).parse();
    if (!article || !article.content) return null;
    return { title: String(article.title || '').replace(/\s+/g, ' ').trim().slice(0, 200), content: article.content };
  } catch (e) {
    return null;
  } finally {
    if (dom) { try { dom.window.close(); } catch (e) { /* đã đóng */ } }
  }
}

/**
 * @returns {{title:string, text:string}} văn bản sạch, giữ ranh giới đoạn (để chunk theo đoạn).
 * text rỗng khi Readability không bóc được gì (SPA render bằng JS) — caller quyết định fallback.
 */
function extractReadableText(html, url) {
  const article = readabilityParse(String(html || ''), url);
  if (!article) return { title: '', text: '' };
  return { title: article.title, text: htmlToAnchoredText(article.content) };
}

/** Firecrawl (tuỳ chọn). @returns {Promise<{title:string, text:string}|null>} */
async function extractViaFirecrawl(url, opts = {}) {
  const key = String(process.env.FIRECRAWL_API_KEY || '').trim();
  if (!opts.firecrawlClient && !key) return null;
  const timeoutMs = Number(opts.firecrawlTimeoutMs) || Number(process.env.FIRECRAWL_TIMEOUT_MS) || FIRECRAWL_TIMEOUT_MS;
  let timer;
  try {
    const client = opts.firecrawlClient || new (require('@mendable/firecrawl-js').Firecrawl)({ apiKey: key, timeoutMs, maxRetries: 0 });
    const doc = await Promise.race([
      client.scrape(url, { formats: ['markdown'], timeout: timeoutMs }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('firecrawl_timeout')), timeoutMs + 1000); })
    ]);
    const text = markdownToAnchoredText(doc && doc.markdown);
    if (!text || text.length < MIN_TEXT_CHARS) return null;
    return { title: String((doc.metadata && doc.metadata.title) || '').replace(/\s+/g, ' ').trim().slice(0, 200), text };
  } catch (e) {
    return null; // lỗi/hết quota/timeout -> caller trả kết quả trung thực, không bịa
  } finally {
    clearTimeout(timer);
  }
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
 * opts (chủ yếu cho test): noCache, maxBytes, timeoutMs, chunkChars, firecrawlClient, firecrawlTimeoutMs.
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

    // Dựng + cache payload READY. `method` stamp lên MỌI chunk để client/citation biết nguồn trích xuất.
    const ready = async (finalUrl, title, text, method, headers) => {
      const payload = {
        ok: true,
        status: 'READY',
        url: normalizeUrl(finalUrl),
        title,
        // PHẦN AN/CA: fingerprint theo NỘI DUNG đã trích, không theo byte HTML — quảng cáo đổi mỗi
        // lần tải không được tính là "nội dung đã thay đổi".
        fingerprint: contentFingerprint(text),
        extractorVersion: EXTRACTOR_VERSION,
        chunks: chunkText(text, opts).map((c) => ({ ...c, extractionMethod: method }))
      };
      await contentCache.set(cacheParts, payload, {
        etag: headers && headers.etag,
        lastModified: headers && headers['last-modified']
      });
      return payload;
    };

    let current = parsed;
    for (let hop = 0; hop < 3; hop++) {
      const res = await safeHttp.fetchPinned(current, {
        maxBytes: opts.maxBytes || MAX_BYTES,
        timeoutMs: opts.timeoutMs || TIMEOUT_MS,
        // Revalidate nếu lần trước server có trả ETag/Last-Modified (bản cache đã hết TTL nhưng
        // nội dung có thể chưa đổi -> 304, không tốn băng thông lẫn thời gian phân tích lại).
        headers: contentCache.conditionalHeaders(cached)
      });
      // Lỗi tầng mạng/SSRF (blocked_ip, dns_failed, too_large...) -> DỪNG. Không đưa URL này cho bên thứ ba.
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
      if (res.status < 200 || res.status >= 300) {
        if (ANTIBOT_STATUS.has(res.status)) {
          const fc = await extractViaFirecrawl(current.toString(), opts);
          if (fc) return ready(current.toString(), fc.title, fc.text, 'text-firecrawl');
        }
        return { ok: false, status: 'ERROR', reason: `http_${res.status}`, url };
      }
      const ctype = String(res.headers['content-type'] || '');
      if (ctype && !/text\/html|application\/xhtml|text\/plain/i.test(ctype)) {
        return { ok: false, status: 'ERROR', reason: 'unsupported_content_type', url };
      }
      const { title, text } = extractReadableText(res.body.toString('utf8'), current.toString());
      if (text && text.length >= MIN_TEXT_CHARS) return ready(current.toString(), title, text, 'text-readability', res.headers);

      // Readability không bóc được (SPA render bằng JS...) -> Firecrawl nếu có key.
      const fc = await extractViaFirecrawl(current.toString(), opts);
      if (fc) return ready(current.toString(), fc.title || title, fc.text, 'text-firecrawl');
      return { ok: false, status: 'INCOMPLETE', reason: 'no_readable_text', url, title };
    }
    return { ok: false, status: 'ERROR', reason: 'too_many_redirects', url };
  });
}

module.exports = { fetchWebSource, extractReadableText, chunkText, decodeEntities, EXTRACTOR_VERSION, MAX_BYTES, contentCache };
