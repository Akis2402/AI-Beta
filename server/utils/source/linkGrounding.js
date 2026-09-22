'use strict';

// ============================================================================================
// V6.16.2/26/31 — URL GROUNDING cho tính năng "Đề xuất ôn tập" (server/routes/recommend.js)
// ============================================================================================
// Tách khỏi recommend.js (module đó cần 'express') để module này 0 dependency, test được trực
// tiếp mà không cần `npm install` — cùng quy ước với citationValidator.js/sourceProvenance.js.
//
// GAP audit phát hiện: anthropicClient.callClaudeWebSearch() (hàm DUY NHẤT trong codebase trả về
// URL thật từ web_search_tool_result) được export nhưng KHÔNG nơi nào gọi. recommend.js tin thẳng
// URL model tự viết ra trong JSON — đúng vi phạm "model says 'Nguồn: url' không đủ, phải có tool
// result chứa URL đó" (V6.16.26) và "RAW MODEL OUTPUT không được pass thẳng UI" (V6.16.31).
//
// Hai đường xử lý URL sau khi vá:
//   - GROUNDED (Claude, có `results` thật): sanitizeGroundedLinks() chỉ giữ URL khớp đúng 1 phần
//     tử trong registry — registry đó CHÍNH LÀ verifiedSourceRegistry của lượt gọi này.
//   - UNGROUNDED (OpenAI/Gemini qua callWithFailover — codebase hiện chưa parse được tool-result
//     URL thật của 2 provider này): domainOnlySearchLinks() hạ URL model viết thành 1 link
//     "site:domain" trên Google — Google tự resolve kết quả thật, không có rủi ro link chết/bịa.

const MAX_LINKS = 6;

/** So khớp 2 URL bỏ qua khác biệt vô hại (www., trailing slash) — KHÔNG xoá query có ý nghĩa. */
function normalizeUrlForMatch(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return `${host}${path}${u.search}`;
  } catch (e) { return null; }
}

/** Lọc + chuẩn hoá danh sách link: chỉ giữ url http(s) hợp lệ, bỏ trùng domain, trần MAX_LINKS. */
function sanitizeAiLinks(rawLinks) {
  if (!Array.isArray(rawLinks)) return [];
  const seenDomains = new Set();
  const out = [];
  for (const item of rawLinks) {
    if (!item || typeof item.url !== 'string') continue;
    let url;
    try { url = new URL(item.url); } catch (e) { continue; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    const domain = url.hostname.replace(/^www\./, '');
    if (seenDomains.has(domain)) continue;
    seenDomains.add(domain);
    out.push({
      url: url.toString(),
      title: String(item.title || domain).trim().slice(0, 120),
      note: String(item.note || '').trim().slice(0, 200),
      domain
    });
    if (out.length >= MAX_LINKS) break;
  }
  return out;
}

/**
 * Như sanitizeAiLinks(), NHƯNG mỗi item chỉ được giữ khi URL của nó khớp CHÍNH XÁC một URL trong
 * `verifiedUrls` (kết quả web_search_tool_result thật). "FINAL RESPONSE SANITIZER" cho tính năng
 * đề xuất — strip mọi URL không có trong registry, không đoán/sửa hộ URL "gần đúng".
 */
function sanitizeGroundedLinks(rawLinks, verifiedUrls) {
  const verified = new Set((verifiedUrls || []).map(normalizeUrlForMatch).filter(Boolean));
  if (!verified.size) return [];
  const candidates = sanitizeAiLinks(rawLinks);
  return candidates.filter((c) => verified.has(normalizeUrlForMatch(c.url)));
}

/** Hạ URL model tự viết (chưa xác minh) thành 1 link Google "site:domain" — luôn sống, không bịa. */
function domainOnlySearchLinks(rawLinks, query) {
  if (!Array.isArray(rawLinks)) return [];
  const seenDomains = new Set();
  const out = [];
  const q = encodeURIComponent(String(query || '').slice(0, 120));
  for (const item of rawLinks) {
    if (!item || typeof item.url !== 'string') continue;
    let url;
    try { url = new URL(item.url); } catch (e) { continue; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    const domain = url.hostname.replace(/^www\./, '');
    if (seenDomains.has(domain)) continue;
    seenDomains.add(domain);
    out.push({
      url: `https://www.google.com/search?q=${encodeURIComponent('site:' + domain)}+${q}`,
      title: String(item.title || domain).trim().slice(0, 120),
      note: String(item.note || '').trim().slice(0, 200),
      domain
    });
    if (out.length >= MAX_LINKS) break;
  }
  return out;
}

module.exports = { MAX_LINKS, normalizeUrlForMatch, sanitizeAiLinks, sanitizeGroundedLinks, domainOnlySearchLinks };
