'use strict';

// ============================================================================================
// PHẦN E + F — ĐỊNH TUYẾN Ý ĐỊNH BẰNG LUẬT, TRƯỚC KHI CHẠM TỚI MODEL
// ============================================================================================
// Nguyên tắc: KHÔNG gọi model chỉ để hỏi "người dùng muốn tạo ảnh hay giải bài". Câu hỏi đó trả lời
// được bằng luật với độ chính xác đủ cao, và mỗi lần gọi model để phân loại là một lần trả tiền cho
// thứ code làm được.
//
// Giá trị thật của module này nằm ở EARLY EXIT: biết sớm ý định giúp BỎ HẲN các giai đoạn không liên
// quan (source retrieval, source vision, citation, completeness, continuation) thay vì chạy hết rồi
// mới phát hiện không cần — đó mới là chỗ token bị đốt, không phải ở câu prompt dài hay ngắn.

const { detectImageOnlyRequest } = require('./visual/visualDecisionEngine');
const { normalizeUrl } = require('./queryFingerprint');

const INTENT = {
  IMAGE_ONLY: 'IMAGE_ONLY',
  SOURCE_QUERY: 'SOURCE_QUERY',
  WEB_QUERY: 'WEB_QUERY',
  YOUTUBE_QUERY: 'YOUTUBE_QUERY',
  IMAGE_REFERENCE: 'IMAGE_REFERENCE',
  PLAIN_TEXT: 'PLAIN_TEXT'
};

const URL_RE = /https?:\/\/[^\s<>"']+/gi;
const YOUTUBE_HOST_RE = /^(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)$/i;

/** Câu hỏi có trỏ đích danh vào tài liệu/trang không? Dùng để biết image-only CÓ cần source hay không. */
const SOURCE_REFERENCE_RE = /\b(trang|page|tài liệu|tai lieu|pdf|sách|sach|giáo trình|giao trinh|file|đề cương|de cuong|bài\s*\d|bai\s*\d|câu\s*\d|cau\s*\d)\b/i;

function extractUrls(text) {
  const out = [];
  const seen = new Set();
  (String(text || '').match(URL_RE) || []).forEach((raw) => {
    const url = normalizeUrl(raw.replace(/[),.;]+$/, ''));
    if (!url || seen.has(url)) return; // PHẦN BH: cùng một URL nhắc 2 lần vẫn chỉ là MỘT nguồn
    seen.add(url);
    out.push(url);
  });
  return out;
}

function isYoutubeUrl(url) {
  try { return YOUTUBE_HOST_RE.test(new URL(url).hostname); } catch (e) { return false; }
}

/**
 * routeIntent() — thuần hàm, 0 token, 0 I/O.
 * @param {{query:string, images?:Array, activeSources?:Array, stage?:string, approachText?:string}} input
 * @returns {{
 *   intent:string, imageOnly:boolean, topic:string, usesSource:boolean, usesWeb:boolean,
 *   usesYoutube:boolean, urls:string[], youtubeUrls:string[], webUrls:string[],
 *   hasUserImages:boolean, needs:{sourceRetrieval:boolean, sourceVision:boolean, citation:boolean,
 *   completeness:boolean, continuation:boolean, academicAnswer:boolean, visual:boolean}, reason:string
 * }}
 */
function routeIntent(input = {}) {
  const query = String(input.query || '');
  const images = Array.isArray(input.images) ? input.images : [];
  const activeSources = Array.isArray(input.activeSources) ? input.activeSources : [];
  const urls = extractUrls(query);
  const youtubeUrls = urls.filter(isYoutubeUrl);
  const webUrls = urls.filter((u) => !isYoutubeUrl(u));

  const img = detectImageOnlyRequest(query);
  const referencesSource = SOURCE_REFERENCE_RE.test(query);
  const hasActiveSource = activeSources.length > 0;

  // PHẦN AD/AH/AI: "tạo hình" + KHÔNG nhắc tới tài liệu -> image-only THẬT SỰ, kể cả khi người dùng
  // đang có 1 PDF 134 trang mở sẵn. Việc có nguồn active KHÔNG phải là lý do để đọc nguồn đó.
  if (img.imageOnly && !referencesSource) {
    return {
      intent: INTENT.IMAGE_ONLY,
      imageOnly: true,
      topic: img.topic,
      usesSource: false, usesWeb: false, usesYoutube: false,
      urls: [], youtubeUrls: [], webUrls: [],
      hasUserImages: images.length > 0,
      needs: {
        sourceRetrieval: false, sourceVision: false, citation: false,
        completeness: false, continuation: false, academicAnswer: false, visual: true
      },
      reason: images.length ? 'image_only_with_reference_images' : 'image_only'
    };
  }

  // Image-only NHƯNG có trỏ tới tài liệu ("cắt lại hình theo trang 21") -> vẫn cần evidence, nhưng
  // chỉ đúng phần được trỏ tới (PHẦN AI/DG).
  if (img.imageOnly && referencesSource && hasActiveSource) {
    return {
      intent: INTENT.IMAGE_ONLY,
      imageOnly: true,
      topic: img.topic,
      usesSource: true, usesWeb: webUrls.length > 0, usesYoutube: youtubeUrls.length > 0,
      urls, youtubeUrls, webUrls,
      hasUserImages: images.length > 0,
      needs: {
        sourceRetrieval: true, sourceVision: false, citation: false,
        completeness: false, continuation: false, academicAnswer: false, visual: true
      },
      reason: 'image_only_with_source_reference'
    };
  }

  const usesSource = hasActiveSource && (referencesSource || activeSources.some((s) => s && s.forced) || true);
  let intent = INTENT.PLAIN_TEXT;
  if (youtubeUrls.length) intent = INTENT.YOUTUBE_QUERY;
  else if (webUrls.length) intent = INTENT.WEB_QUERY;
  else if (hasActiveSource) intent = INTENT.SOURCE_QUERY;
  else if (images.length) intent = INTENT.IMAGE_REFERENCE;

  return {
    intent,
    imageOnly: false,
    topic: '',
    usesSource: hasActiveSource ? usesSource : false,
    usesWeb: webUrls.length > 0,
    usesYoutube: youtubeUrls.length > 0,
    urls, youtubeUrls, webUrls,
    hasUserImages: images.length > 0,
    needs: {
      // PHẦN F/FC-13: KHÔNG có nguồn active -> mọi giai đoạn liên quan tới nguồn có chi phí = 0.
      sourceRetrieval: hasActiveSource || webUrls.length > 0 || youtubeUrls.length > 0,
      sourceVision: hasActiveSource,
      citation: hasActiveSource || webUrls.length > 0 || youtubeUrls.length > 0,
      completeness: true,
      continuation: true,
      academicAnswer: true,
      visual: false
    },
    reason: intent.toLowerCase()
  };
}

module.exports = { routeIntent, extractUrls, isYoutubeUrl, INTENT, SOURCE_REFERENCE_RE };
