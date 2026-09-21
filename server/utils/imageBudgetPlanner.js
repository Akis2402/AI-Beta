'use strict';

// ============================================================================================
// PHẦN T + U + V + X + ET — NGÂN SÁCH ẢNH ĐA NGUỒN
// ============================================================================================
// "Hỗ trợ 8 ảnh" không có nghĩa là gửi 8 ảnh full-res. Ảnh là loại token đắt nhất trong request, và
// phần lớn chi phí đó thường vô ích: ảnh trùng nhau, ảnh trang trí, ảnh để nguyên 4000px trong khi
// model chỉ cần đọc mấy dòng chữ.
//
// Ba việc module này làm, theo đúng thứ tự giá trị:
//   1. DEDUPE theo fingerprint — ảnh trùng có chi phí 0 (PHẦN V). Đây là khoản tiết kiệm chắc chắn
//      nhất và không đánh đổi gì cả.
//   2. XẾP HẠNG nội dung: ảnh nhiều chữ/bảng/công thức giữ độ phân giải cao, ảnh minh hoạ hạ xuống
//      (PHẦN U). Giảm đều tay mọi ảnh là cách nhanh nhất để model đọc sai đề.
//   3. Nếu vẫn vượt trần: bỏ ảnh ƯU TIÊN THẤP NHẤT và GHI LẠI LÝ DO (PHẦN CX: không bao giờ âm thầm
//      bỏ ảnh của người dùng).

const { contentFingerprint } = require('./queryFingerprint');

const TIER = { A: 'A', B: 'B', C: 'C', D: 'D' };

const ROLE_PRIORITY = {
  required_reference: 1,
  subject: 2,
  character: 3,
  diagram: 4,
  source_evidence: 5,
  style_reference: 6,
  context: 7,
  decorative: 8
};

/**
 * getImageInputCapability() — Section 18: Khả năng tiếp nhận ảnh đầu vào theo từng provider/model.
 */
function getImageInputCapability(provider, model) {
  const p = String(provider || '').toLowerCase();
  const m = String(model || '').toLowerCase();
  if (p === 'gemini' || p === 'gemini-image' || p === 'gemini-interactions-image' || m.includes('gemini')) {
    return {
      provider: 'gemini',
      maxReferenceImages: 14,
      maxHighFidelityObjects: 10,
      maxCharacters: 4,
      supportedSizes: ['0.5K', '1K', '2K', '4K']
    };
  }
  if (p === 'openai' || p === 'openai-image' || m.includes('gpt') || m.includes('dall-e')) {
    return {
      provider: 'openai',
      maxReferenceImages: 4,
      maxHighFidelityObjects: 4,
      maxCharacters: 2,
      supportedSizes: ['1024x1024', '1024x1792', '1792x1024']
    };
  }
  return {
    provider: p || 'default',
    maxReferenceImages: 8,
    maxHighFidelityObjects: 6,
    maxCharacters: 2,
    supportedSizes: ['1K']
  };
}

/** Trần cạnh dài theo tier — ảnh chữ giữ nét, ảnh minh hoạ không cần. */
const TIER_MAX_EDGE = { A: 2000, B: 1400, C: 1024, D: 640 };
/** Ước lượng token thị giác: xấp xỉ theo diện tích ô 28px (đủ tốt để LẬP KẾ HOẠCH, không phải để tính tiền). */
const ASSUMED_EDGE = 1024; // khi client không gửi kích thước: giả định VỪA PHẢI, không giả định xấu nhất
function estimateImageTokens({ width, height, maxEdge }) {
  const w = Math.max(1, Math.min(width || ASSUMED_EDGE, maxEdge));
  const h = Math.max(1, Math.min(height || ASSUMED_EDGE, maxEdge));
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  return Math.ceil(((w * scale) / 28) * ((h * scale) / 28));
}

/**
 * Xếp tier bằng TÍN HIỆU CÓ SẴN, không gọi model (PHẦN CJ/S).
 * `textHint` do client cung cấp khi đã biết (vd trang PDF rasterize luôn là tài liệu chữ).
 */
function classifyImageTier(img = {}) {
  if (img.tier && TIER[img.tier]) return img.tier;
  if (img.role === 'source_page' || img.textHeavy === true) return TIER.A;
  if (img.role === 'diagram') return TIER.B;
  if (img.role === 'decorative') return TIER.D;
  // Ảnh chụp đề bài thường hẹp và dày chữ; ảnh nền/minh hoạ thường tỉ lệ rộng.
  const ratio = (img.width && img.height) ? img.width / img.height : 1;
  if (ratio > 0 && ratio < 1.2) return TIER.A;
  return TIER.C;
}

/**
 * planImages() — thuần hàm, 0 I/O.
 * @param {Array} images  [{id, base64, mediaType, width, height, role, textHeavy}]
 * @param {{maxImages?:number, tokenBudget?:number, provider?:string, model?:string}} [opts]
 * @returns {{
 *   selected:Array, dropped:Array<{id:string, reason:string}>, duplicates:Array<{id:string, sameAs:string}>,
 *   estimatedTokens:number, estimatedImageInputTokens:number, plan:Array
 * }}
 */
function planImages(images, opts = {}) {
  const maxImages = opts.maxImages || (opts.provider ? getImageInputCapability(opts.provider, opts.model).maxReferenceImages : 8);
  const tokenBudget = opts.tokenBudget || 6000;

  const seen = new Map(); // fingerprint -> id đầu tiên
  const duplicates = [];
  const dropped = [];
  const candidates = [];

  (Array.isArray(images) ? images : []).forEach((img, index) => {
    const fp = img.fingerprint || contentFingerprint(img.base64 || `${img.id || index}`);
    if (seen.has(fp)) {
      // PHẦN V/FC-8: ảnh trùng KHÔNG được gửi hai lần. Vẫn giữ tham chiếu để provenance không mất.
      duplicates.push({ id: img.id || `img${index + 1}`, sameAs: seen.get(fp) });
      return;
    }
    seen.set(fp, img.id || `img${index + 1}`);
    const tier = classifyImageTier(img);
    const rolePriority = ROLE_PRIORITY[img.role] || 7;
    const maxEdge = TIER_MAX_EDGE[tier];
    candidates.push({
      ...img,
      id: img.id || `img${index + 1}`,
      order: index + 1,          // PHẦN X: thứ tự người dùng gửi là thứ tự model thấy
      fingerprint: fp,
      tier,
      rolePriority,
      maxEdge,
      estimatedTokens: estimateImageTokens({ width: img.width, height: img.height, maxEdge })
    });
  });

  // Vượt số lượng: bỏ từ cuối (ảnh gửi sau thường là phụ), có lý do rõ ràng.
  const withinCount = candidates.slice(0, maxImages);
  candidates.slice(maxImages).forEach((c) => dropped.push({ id: c.id, reason: 'max_images_exceeded' }));

  // Vượt ngân sách token: bỏ tier thấp nhất trước, giữ nguyên thứ tự hiển thị của phần còn lại.
  const selected = [...withinCount];
  const tierRank = { A: 0, B: 1, C: 2, D: 3 };
  const recount = () => selected.reduce((a, c) => a + c.estimatedTokens, 0);
  let total = recount();

  // Bước 1: HẠ ĐỘ PHÂN GIẢI trước khi nghĩ tới việc bỏ ảnh. Người dùng gửi ảnh vì ảnh đó cần thiết;
  // một bức 2000px hạ xuống 1400px vẫn đọc được, còn bị bỏ hẳn thì thông tin mất sạch.
  const EDGE_LADDER = [2000, 1400, 1024, 768, 640];
  let step = 0;
  while (total > tokenBudget && step < EDGE_LADDER.length) {
    const cap = EDGE_LADDER[step];
    selected.forEach((c) => {
      if (c.maxEdge > cap) {
        c.maxEdge = cap;
        c.downscaled = true;
        c.estimatedTokens = estimateImageTokens({ width: c.width, height: c.height, maxEdge: cap });
      }
    });
    total = recount();
    step += 1;
  }

  // Bước 2: vẫn vượt -> mới bỏ ảnh, ưu tiên role & tier thấp nhất trước, luôn kèm lý do.
  while (total > tokenBudget && selected.length > 1) {
    let worstIdx = 0;
    selected.forEach((c, i) => {
      const w = selected[worstIdx];
      const cScore = (c.rolePriority || 7) * 10 + tierRank[c.tier];
      const wScore = (w.rolePriority || 7) * 10 + tierRank[w.tier];
      if (cScore > wScore || (cScore === wScore && c.order > w.order)) worstIdx = i;
    });
    const [removed] = selected.splice(worstIdx, 1);
    dropped.push({ id: removed.id, reason: 'image_token_budget_exceeded' });
    total = recount();
  }

  selected.sort((a, b) => a.order - b.order);
  return {
    selected,
    dropped,
    duplicates,
    estimatedTokens: total,
    // Section 53: canonical alias rõ nghĩa: planning estimate only
    estimatedImageInputTokens: total,
    // Một ảnh duy nhất vẫn vượt trần: KHÔNG bỏ (bỏ là mất hết yêu cầu của người dùng) nhưng phải
    // khai báo để tầng trên quyết định — im lặng vượt trần là cách token đội lên mà không ai biết.
    overBudget: total > tokenBudget,
    plan: selected.map((c) => ({ id: c.id, order: c.order, tier: c.tier, maxEdge: c.maxEdge, estimatedTokens: c.estimatedTokens }))
  };
}

/** PHẦN X: marker cực ngắn, KHÔNG mô tả dài dòng (mô tả dài chính là token vô ích). */
function imageMarker(order) { return `[IMG${order}]`; }

module.exports = {
  planImages,
  classifyImageTier,
  estimateImageTokens,
  getImageInputCapability,
  imageMarker,
  TIER,
  TIER_MAX_EDGE,
  ROLE_PRIORITY
};
