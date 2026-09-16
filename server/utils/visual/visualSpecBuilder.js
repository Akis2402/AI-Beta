'use strict';

// ============================================================================================
// PHẦN 16/17 — IMAGE SPECIFICATION CÓ CẤU TRÚC (AI KHÔNG ĐƯỢC TỰ TẠO ẢNH TÙY TIỆN)
// ============================================================================================
// Không bao giờ đi thẳng từ "câu trả lời" -> "prompt ảnh dài". Luôn qua 1 SPEC có cấu trúc:
//
//   { type, purpose, title, labels[], objects[], relationships[], requiredEquations[],
//     visualConstraints[], style, language }
//
// Lợi ích: ổn định hơn, dễ cache (hash spec), dễ test, dễ sửa, token thấp hơn
// (PHẦN 17: image prompt = DELTA MINIMUM SUFFICIENT CONTEXT — chỉ spec, KHÔNG gửi cả hội thoại,
// KHÔNG gửi reasoning, KHÔNG gửi cả lời giải).
//
// Spec được trích TỪ FINAL VERIFIED FACTS (PHẦN 24): với cross-check, hàm này chỉ được gọi SAU
// reconciliation, trên văn bản cuối cùng — không phải trên candidate đầu tiên.

const MAX_LABELS = 12;
const MAX_OBJECTS = 14;
const MAX_EQUATIONS = 4;

// ============================================================================================
// VISUAL_PROMPT_VERSION — phiên bản của PROMPT ẢNH (khác PROMPT_VERSION của prompt text).
// ============================================================================================
// Bump MỖI KHI buildImagePrompt()/STYLE_PROFILES đổi nội dung. visualPipeline nhét giá trị này vào
// cache key, nên bản ảnh sinh bởi prompt cũ (vd bản còn nhét số liệu vào prompt — lỗi mục 1.2)
// KHÔNG BAO GIỜ được trả lại sau khi prompt đã sửa.
//   v1: prompt gốc (có nhét số liệu + công thức — SAI với contract cũ).
//   v2: bỏ số liệu/công thức khỏi prompt ảnh, thêm style theo môn, cắt theo hạn mức provider.
//   v3: sửa contract callGeminiImage() (responseModalities + xác thực magic bytes).
//   v4: KIẾN TRÚC AI IMAGE-FIRST — ảnh AI là đường DUY NHẤT cho hình 2D tĩnh (không còn
//       deterministic/SVG để lùi về). Prompt nay PHẢI mang dữ kiện chính xác (Exact facts,
//       Required labels, Math/measurement constraints) theo cấu trúc 16 mục, vì không còn
//       renderer nào khác chịu trách nhiệm vẽ đúng số đo. Cache cũ sinh bởi prompt v3 (cố tình
//       không có số/nhãn) KHÔNG được dùng lại.
const VISUAL_PROMPT_VERSION = 'visual-prompt-v4';

// ============================================================================================
// PHẦN 6 — STYLE THEO MÔN (không còn 1 chuỗi 'educational_scientific' dùng chung cho mọi môn)
// ============================================================================================
// Mỗi cụm cố ý viết NGẮN (1 câu): prompt ảnh có hạn mức ký tự cứng theo provider (2000 Gemini /
// 4000 OpenAI), style dài chỉ ăn chỗ của phần mô tả cảnh — thứ thực sự quyết định hình.
const STYLE_PROFILES = {
  physics: {
    id: 'physics_scientific',
    prompt: 'Clean scientific illustration, sơ đồ vật lý học đường, nét mảnh dứt khoát, mũi tên lực rõ hướng, nền trắng phẳng, không phối cảnh cầu kỳ.'
  },
  biology: {
    id: 'biology_anatomical',
    prompt: 'Polished anatomical/biological illustration, màu pastel dịu, lớp mô và bào quan tách bạch, phong cách sách giáo khoa sinh học hiện đại.'
  },
  chemistry: {
    id: 'chemistry_molecular',
    prompt: 'Molecular 3D rendering, mô hình bóng-que (ball-and-stick), màu nguyên tố theo chuẩn CPK, ánh sáng mềm, nền trắng.'
  },
  geography: {
    id: 'geography_terrain',
    prompt: 'Clean terrain map illustration, khối địa hình phân tầng màu, đường bờ và ranh giới mảnh, phong cách lược đồ địa lý sách giáo khoa.'
  },
  default: {
    id: 'educational_scientific',
    prompt: 'Clean educational scientific illustration, bố cục gọn, tương phản cao, nền trắng.'
  }
};

// ============================================================================================
// MỤC (đợt audit 6) — ASPECT RATIO INTELLIGENCE (mục XI yêu cầu audit).
// ============================================================================================
// ROOT CAUSE: pipeline TRƯỚC ĐÂY luôn gửi '1024x1024' (vuông) cho MỌI loại hình, kể cả sơ đồ
// mạch điện ngang, lược đồ dọc, cảnh landscape... khiến ảnh AI bị crop/bóp méo bố cục. Chọn tỉ lệ
// THEO LOẠI HÌNH (spec.type) — đây là quyết định CHỈ PHỤ THUỘC cấu trúc câu hỏi, không phụ thuộc
// provider, nên đặt ở spec builder (1 nguồn sự thật), imageGenerationClient chỉ ĐỌC giá trị này.
const ASPECT_RATIO_BY_TYPE = {
  circuit_diagram: '4:3',
  optics_diagram: '16:9',
  physics_diagram: '4:3',
  mathematical_plot: '4:3',
  geometry_diagram: '1:1',
  geometry_3d: '4:3',
  chemistry_structure: '1:1',
  apparatus_diagram: '4:3',
  biology_diagram: '3:4',
  flowchart: '9:16',
  architecture_diagram: '16:9',
  data_structure_diagram: '16:9',
  network_diagram: '16:9',
  map_diagram: '4:3',
  chart: '4:3',
  concept_illustration: '1:1'
};
const VALID_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'];

/**
 * aspectRatioFor() — PHẦN XI: tự chọn tỉ lệ khung hình theo loại hình, không luôn dùng 1:1.
 * @param {string} type spec.type (vd 'circuit_diagram', 'flowchart'...)
 * @returns {string} một trong VALID_ASPECT_RATIOS
 */
function aspectRatioFor(type) {
  return ASPECT_RATIO_BY_TYPE[type] || '1:1';
}

/**
 * styleProfileFor() — chọn cụm phong cách theo MÔN (PHẦN 6).
 * @param {string} subject
 * @returns {{id:string, prompt:string}}
 */
function styleProfileFor(subject) {
  const key = String(subject || '').toLowerCase();
  if (STYLE_PROFILES[key]) return STYLE_PROFILES[key];
  if (/physic|vật ?l[ýy]/.test(key)) return STYLE_PROFILES.physics;
  if (/bio|sinh/.test(key)) return STYLE_PROFILES.biology;
  if (/chem|h[oó]a/.test(key)) return STYLE_PROFILES.chemistry;
  if (/geo|địa/.test(key)) return STYLE_PROFILES.geography;
  return STYLE_PROFILES.default;
}

/** Trích các nhãn điểm hình học viết hoa (A, B, C, M, O, A', H...) — giữ đúng thứ tự xuất hiện. */
function extractPointLabels(text) {
  const out = [];
  const seen = new Set();
  const re = /(?:^|[\s(,;.])([A-Z][’']?)(?=[\s),;.]|$)/g;
  let m;
  while ((m = re.exec(text)) && out.length < MAX_LABELS) {
    const label = m[1];
    if (seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out;
}

/** Trích đại lượng có ĐƠN VỊ — đây là dữ liệu hình PHẢI hiển thị đúng (PHẦN 18). */
function extractQuantities(text) {
  const out = [];
  const seen = new Set();
  const re = /([A-Za-zΑ-Ωα-ω][A-Za-z0-9_]{0,6})\s*=\s*(-?\d+(?:[.,]\d+)?)\s*(m\/s²|m\/s2|km\/h|m\/s|cm|mm|km|kg|g|N|J|W|V|A|Ω|°C|°|s|m|%)?/g;
  let m;
  while ((m = re.exec(text)) && out.length < MAX_OBJECTS) {
    const key = m[1] + '=' + m[2];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ symbol: m[1], value: Number(String(m[2]).replace(',', '.')), unit: m[3] || '' });
  }
  return out;
}

/** Trích công thức LaTeX/ASCII quan trọng — hình chỉ được hiển thị công thức CÓ TRONG lời giải. */
function extractEquations(text) {
  const eqs = [];
  const latex = text.match(/\$\$([^$]{3,120})\$\$|\$([^$\n]{3,80})\$/g) || [];
  latex.forEach((raw) => {
    const clean = raw.replace(/^\$+|\$+$/g, '').trim();
    if (clean && eqs.length < MAX_EQUATIONS && !eqs.includes(clean)) eqs.push(clean);
  });
  if (eqs.length < MAX_EQUATIONS) {
    const plain = text.match(/^[^\n]{0,60}?[A-Za-z]\s*=\s*[^\n=]{2,60}$/gm) || [];
    plain.forEach((raw) => {
      const clean = raw.trim();
      if (clean && eqs.length < MAX_EQUATIONS && !eqs.includes(clean)) eqs.push(clean);
    });
  }
  return eqs;
}

/**
 * Trích hàm số f(x) của đồ thị. Chỉ chấp nhận biểu thức ĐƠN GIẢN, an toàn (không eval chuỗi tuỳ
 * ý): giá trị này đi THẲNG vào mục "Math/measurement constraints" của prompt ảnh.
 */
function extractPlottableFunction(text) {
  const m = text.match(/y\s*=\s*([-+0-9x^*/.\s()]{3,60})(?:[\s,;.]|$)/i)
    || text.match(/f\s*\(\s*x\s*\)\s*=\s*([-+0-9x^*/.\s()]{3,60})(?:[\s,;.]|$)/i);
  if (!m) return null;
  const expr = m[1].trim().replace(/\s+/g, '');
  if (!/^[-+0-9x^*/.()]+$/.test(expr)) return null;
  return expr;
}

/** Trích các bước/giai đoạn cho flowchart — tối đa 8 nút để hình còn đọc được. */
function extractSteps(text) {
  const steps = [];
  const re = /^\s*(?:Bước\s*(\d+)|(\d+)[).])\s*[:.\-–]?\s*(.{4,70})$/gim;
  let m;
  while ((m = re.exec(text)) && steps.length < 8) {
    const label = (m[3] || '').replace(/\*\*/g, '').replace(/[.:;]+$/, '').trim();
    if (label) steps.push(label.slice(0, 60));
  }
  return steps;
}


/**
 * extractNamedParts() — trích TÊN THÀNH PHẦN (không phải nhãn điểm hình học) cho hình sinh học/
 * hoá học/địa lý: "**Ti thể**: ...", "- Lục lạp: ...", "1. Nhân tế bào — ...".
 *
 * Khác extractPointLabels() ở chỗ: hình học dùng nhãn 1 chữ cái viết hoa (A, B, C), còn sơ đồ sinh/
 * hoá/địa cần cụm từ có nghĩa. Chỉ lấy tên THỰC SỰ xuất hiện trong lời giải — không bao giờ bịa.
 * @returns {Array<{name:string, note:string}>}
 */
function extractNamedParts(text, limit = 8) {
  const out = [];
  const seen = new Set();
  const push = (name, note) => {
    const clean = String(name || '').replace(/\*\*/g, '').trim().replace(/[.:;,]+$/, '');
    if (!clean || clean.length < 2 || clean.length > 42) return;
    const key = clean.toLowerCase();
    if (seen.has(key) || out.length >= limit) return;
    seen.add(key);
    out.push({ name: clean, note: String(note || '').trim().slice(0, 60) });
  };
  const patterns = [
    /^\s*[-*+]\s*\*\*([^*]{2,40})\*\*\s*[::\-–]?\s*(.{0,80})$/gim,
    /^\s*[-*+]\s*([^:\n]{2,40})\s*[::]\s*(.{0,80})$/gim,
    /^\s*\d+[).]\s*([^:\n]{2,40})\s*[::]\s*(.{0,80})$/gim
  ];
  patterns.forEach((re) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) && out.length < limit) push(m[1], m[2]);
  });
  return out;
}

/**
 * extractMolecularFormula() — trích công thức phân tử (C4H10, H2SO4, NaCl...) để prompt ảnh mô tả
 * đúng mô hình liên kết. Chỉ nhận công thức CÓ TRONG lời giải.
 * @returns {{formula:string, atoms:Array<{symbol:string,count:number}>}|null}
 */
function extractMolecularFormula(text) {
  const m = String(text).match(/\b((?:[A-Z][a-z]?\d{0,2}){2,6})\b/g);
  if (!m) return null;
  // Bỏ các chuỗi viết hoa vô nghĩa (vd "ABC", "SGK") — công thức thật phải có ít nhất 1 chữ số
  // HOẶC là một hợp chất 2 nguyên tố quen thuộc.
  const candidate = m.find((x) => /\d/.test(x) && /^[A-Z]/.test(x) && x.length <= 12);
  if (!candidate) return null;
  const atoms = [];
  const re = /([A-Z][a-z]?)(\d{0,2})/g;
  let a;
  while ((a = re.exec(candidate))) {
    if (!a[1]) continue;
    atoms.push({ symbol: a[1], count: a[2] ? Number(a[2]) : 1 });
  }
  if (atoms.length < 2) return null;
  return { formula: candidate, atoms };
}

/**
 * extractRegions() — trích tên vùng/khu vực cho lược đồ địa lý, kèm số liệu nếu có.
 */
function extractRegions(text, limit = 6) {
  const out = [];
  const seen = new Set();
  const re = /\b([Vv]ùng|[Kk]hu vực|[Mm]iền|[Tt]ỉnh|[ĐđDd]ồng bằng|[Cc]ao nguyên|[Dd]ãy núi)\s+([A-ZĐÂÊÔƯĂÁÀẢÃẠ][^\s,.;:]{1,20}(?:\s+[A-ZĐÂÊÔƯĂ][^\s,.;:]{1,20})?)/g;
  let m;
  while ((m = re.exec(text)) && out.length < limit) {
    const name = (m[1] + ' ' + m[2]).trim();
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * buildVisualSpec() — dựng SPEC từ FINAL ANSWER + decision. Thuần hàm, không gọi network.
 *
 * @param {object} args
 * @param {object} args.decision Kết quả visualDecisionEngine.evaluateVisualNeed().
 * @param {string} args.finalAnswer Văn bản CUỐI CÙNG (đã reconcile nếu cross-check).
 * @param {string} args.question
 * @param {string} [args.subject]
 * @param {string} [args.language='vi']
 * @param {string} [args.grade]
 * @returns {{type:string, purpose:string, title:string, labels:string[], objects:Array,
 *   relationships:string[], requiredEquations:string[], visualConstraints:string[],
 *   style:string, language:string, data:object}}
 */
// ============================================================================================
// REALISM REQUIRED — ĐỀ CẦN HÌNH THẬT, KHÔNG PHẢI SƠ ĐỒ KHÁI NIỆM
// ============================================================================================
// "Nhận dạng lát cắt ngang của lá", "đọc lát cắt địa hình", "quan sát tiêu bản" cần một hình
// THỰC TẾ. Cờ này đi thẳng vào prompt ảnh (mục Style/Purpose) để image model dựng hình ở mức
// tả thực thay vì sơ đồ khối. Không có image provider = KHÔNG có hình (router trả
// blocked='no_image_provider') — hệ thống KHÔNG dựng sơ đồ SVG thay thế nữa.
const REALISM_REQUIRED_RE = /(cắt ngang|lát cắt|giải phẫu|tiêu bản|vi thể|kính hiển vi|hình thái|nhận dạng|quan sát thực tế|ảnh chụp|ảnh vệ tinh|bản đồ (địa hình|tự nhiên|hành chính)|micrograph|cross[- ]section|anatomy|histolog)/i;

/** @returns {boolean} đề đòi hình THẬT chứ không phải sơ đồ khái niệm. */
function needsRealism(text, subject) {
  if (!REALISM_REQUIRED_RE.test(String(text || ''))) return false;
  // Chỉ có nghĩa với các môn mà hình tả thực khác hẳn sơ đồ khối.
  return ['biology', 'geography', 'chemistry', 'general'].includes(subject);
}

// ============================================================================================
// needsPreciseGeometry: HÌNH NÀY CÓ PHẢI VẼ ĐÚNG SỐ ĐO KHÔNG?
// ============================================================================================
// Cờ này KHÔNG còn dùng để chọn renderer (renderer luôn là ảnh AI). Nó quyết định ĐỘ SIẾT của
// prompt ảnh và độ soi của validator:
//   true  -> prompt bắt buộc kèm Exact facts + Math/measurement constraints; validator soi số/nhãn.
//   false -> chỉ mô tả tình huống định tính, prompt gọn hơn.
const PRECISE_RELATIONSHIPS = ['perpendicular', 'parallel', 'tangent', 'midpoint', 'series', 'parallel_circuit'];
const PRECISE_TEXT_RE = /(toạ độ|tọa độ|đúng tỉ lệ|đúng tỷ lệ|theo tỉ lệ|theo tỷ lệ|vẽ đúng|đồ thị|trục [Oo]xy|hệ trục|vector\s*[A-Za-z→]|thang đo)/i;
const ANGLE_RE = /(góc|angle|θ|α|β|γ|φ)\s*[A-Za-z0-9]{0,4}\s*(=|bằng|là)?\s*\d+(?:[.,]\d+)?\s*°?/i;

/**
 * computeNeedsPreciseGeometry() — cờ độ chính xác hình học của một spec.
 * @param {{objects?:Array, relationships?:string[], labels?:string[], data?:object}} spec
 * @param {string} source question + phần đầu lời giải.
 * @returns {boolean}
 */
function computeNeedsPreciseGeometry(spec, source = '') {
  const s = String(source || '');
  if (spec && spec.data && spec.data.plotExpr) return true;
  if (Array.isArray(spec && spec.objects) && spec.objects.some((o) => o && (o.unit === '°' || /^(x|y|θ|alpha|beta|phi)$/i.test(String(o.symbol))))) return true;
  if (Array.isArray(spec && spec.relationships) && spec.relationships.some((r) => PRECISE_RELATIONSHIPS.includes(r))) return true;
  if (/\(\s*-?\d+(?:[.,]\d+)?\s*[;,]\s*-?\d+(?:[.,]\d+)?\s*\)/.test(s)) return true; // cặp toạ độ (x; y)
  if (ANGLE_RE.test(s)) return true;
  if (PRECISE_TEXT_RE.test(s)) return true;
  return false;
}

function buildVisualSpec({ decision, finalAnswer = '', question = '', subject = 'general', language = 'vi', grade = '', approachText = '' }) {
  const type = (decision && decision.visualType) || 'concept_illustration';
  // ---------- ROOT CAUSE B: spec builder phải thấy ĐỦ ngữ cảnh, không chỉ stage 'detail' ----------
  // `finalAnswer` ở stage 'detail' là output của LƯỢT GỌI THỨ HAI. Với câu hỏi tổng quan khái niệm
  // ("cấu tạo cơ thể người"), danh sách thực thể (Da, Hệ xương, Hệ tuần hoàn…) đã được liệt kê ở
  // stage 'approach' (Hướng giải), còn phần chi tiết chỉ mở bài bằng 1-2 câu dẫn nhập. Khi đó
  // extractNamedParts() không tìm thấy gì -> spec.data.parts = [] -> renderBiology() null ->
  // concept card null -> pipeline 'failed' -> UI hiện "Không thể tạo hình minh họa".
  //
  // `approachText` là tham số TUỲ CHỌN (mặc định '') nên mọi call-site/test cũ giữ nguyên hành vi.
  // Nó CHỈ được dùng làm NGUỒN TRÍCH XUẤT cho spec — không đụng gì tới finalAnswer dùng để hiển
  // thị/cache, nên không vi phạm nguyên tắc "chỉ có MỘT final answer duy nhất".
  const approachHead = String(approachText || '').slice(0, 2000);
  const head = (approachHead ? approachHead + '\n' : '') + String(finalAnswer).slice(0, 3500);
  const source = question + '\n' + head;

  const labels = extractPointLabels(source);
  const quantities = extractQuantities(source);
  const requiredEquations = extractEquations(head);
  const steps = extractSteps(head);
  const plotExpr = extractPlottableFunction(source);

  const relationships = [];
  if (/vuông góc/i.test(source)) relationships.push('perpendicular');
  if (/song song/i.test(source)) relationships.push('parallel');
  if (/tiếp tuyến/i.test(source)) relationships.push('tangent');
  if (/(trung điểm|trung tuyến)/i.test(source)) relationships.push('midpoint');
  if (/(nối tiếp)/i.test(source)) relationships.push('series');
  if (/(song song.*mắc|mắc.*song song)/i.test(source)) relationships.push('parallel_circuit');

  const visualConstraints = [
    'Chỉ dùng đúng số liệu và ký hiệu có trong lời giải.',
    'Không thêm dữ kiện, không tự đặt tên điểm mới.',
    'Nhãn phải đọc được, không chồng lên nhau.'
  ];
  if (quantities.length) visualConstraints.push('Giữ nguyên đơn vị của mọi đại lượng.');

  const styleProfile = styleProfileFor(subject);
  const spec = {
    type,
    purpose: (decision && decision.visualPurpose) || '',
    title: buildTitle({ type, question, language }),
    labels: labels.slice(0, MAX_LABELS),
    objects: quantities,
    relationships,
    requiredEquations,
    visualConstraints,
    // PHẦN 6: style theo môn. `style` (id) đi vào cache key nên đổi môn = key khác, không trả nhầm.
    style: styleProfile.id,
    stylePrompt: styleProfile.prompt,
    // PHẦN XI: tỉ lệ khung hình theo LOẠI hình, đi vào cache key (aspectRatio khác nhau -> ảnh
    // khác nhau) và được imageGenerationClient dùng để chọn size/response_format thật.
    aspectRatio: aspectRatioFor(type),
    // Rủi ro #3: đánh dấu tường minh những đề mà sơ đồ SVG không đủ trung thực.
    realismRequired: needsRealism(source, subject),
    language: language === 'English' || language === 'en' ? 'en' : 'vi',
    grade: grade || '',
    subject,
    data: { steps, plotExpr, parts: extractNamedParts(head), molecule: extractMolecularFormula(source), regions: extractRegions(head), points: extractPointCoordinates(source) }
  };
  // MỤC 1.1: cờ do spec tính, router KHÔNG suy từ `type` nữa.
  spec.needsPreciseGeometry = computeNeedsPreciseGeometry(spec, source);
  // MỤC 1.3: dữ liệu ĐÃ XÁC THỰC dành cho overlay phía client. Lấy nguyên từ spec (không trích
  // lại lần nữa) — số/công thức KHÔNG còn được gửi cho image model (mục 1.2) nên đây là nguồn DUY
  // NHẤT hiển thị số cho người học, và nó đến thẳng từ lời giải đã verify.
  spec.verifiedNumbers = quantities.map((o) => ({ symbol: o.symbol, value: o.value, unit: o.unit || '' }));
  spec.verifiedLabels = spec.labels.slice();
  spec.verifiedEquations = requiredEquations.slice();
  return spec;
}

/**
 * extractPointCoordinates() — trích các điểm CÓ TOẠ ĐỘ THẬT trong đề/lời giải: "A(2; 3)", "M(-1,5)".
 * Đây là nguồn DUY NHẤT để overlay neo nhãn theo %; KHÔNG bao giờ đoán vị trí — không có toạ độ
 * thì overlay lùi về dạng bảng chú thích dưới hình.
 * @returns {Array<{label:string, x:number, y:number}>}
 */
function extractPointCoordinates(text, limit = 8) {
  const out = [];
  const seen = new Set();
  const re = /\b([A-Z][’']?)\s*\(\s*(-?\d+(?:[.,]\d+)?)\s*[;,]\s*(-?\d+(?:[.,]\d+)?)\s*\)/g;
  let m;
  while ((m = re.exec(String(text || ''))) && out.length < limit) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ label: m[1], x: Number(m[2].replace(',', '.')), y: Number(m[3].replace(',', '.')) });
  }
  return out;
}

/**
 * anchorsFromPoints() — quy toạ độ THẬT về % khung hình (10%..90%, trục y lật vì màn hình chạy
 * xuống). Không có toạ độ / tất cả điểm trùng nhau -> trả [] (client tự dùng bảng chú thích).
 * @returns {Array<{label:string, xPct:number, yPct:number}>}
 */
function anchorsFromPoints(points) {
  if (!Array.isArray(points) || points.length < 2) return [];
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs); const maxX = Math.max(...xs);
  const minY = Math.min(...ys); const maxY = Math.max(...ys);
  if (maxX === minX || maxY === minY) return [];
  const map = (v, lo, hi) => 10 + ((v - lo) / (hi - lo)) * 80;
  return points.map((p) => ({
    label: p.label,
    xPct: Math.round(map(p.x, minX, maxX) * 10) / 10,
    yPct: Math.round((100 - map(p.y, minY, maxY)) * 10) / 10
  }));
}

/**
 * buildVisualOverlay() — payload overlay gửi kèm response visual (MỤC 1.3).
 * Thuần dữ liệu, KHÔNG gọi thêm bất kỳ text/image API nào (mục 2.5).
 * `anchors` chỉ có khi lời giải CÓ toạ độ thật -> client neo nhãn theo % lên ảnh; không có thì
 * client hiển thị bảng chú thích dưới caption. Không bao giờ để AI/renderer đoán vị trí pixel.
 * @returns {{numbers:Array, labels:string[], equations:string[], anchors:Array}|null}
 */
function buildVisualOverlay(spec) {
  if (!spec) return null;
  const numbers = Array.isArray(spec.verifiedNumbers) ? spec.verifiedNumbers : [];
  const labels = Array.isArray(spec.verifiedLabels) ? spec.verifiedLabels : [];
  const equations = Array.isArray(spec.verifiedEquations) ? spec.verifiedEquations : [];
  const anchors = anchorsFromPoints(spec.data && spec.data.points);
  if (!numbers.length && !labels.length && !equations.length && !anchors.length) return null;
  return { numbers, labels, equations, anchors };
}

function buildTitle({ type, question, language }) {
  const vi = language !== 'en' && language !== 'English';
  const map = {
    physics_diagram: vi ? 'Sơ đồ lực và chuyển động' : 'Force and motion diagram',
    circuit_diagram: vi ? 'Sơ đồ mạch điện' : 'Circuit diagram',
    optics_diagram: vi ? 'Đường đi của tia sáng' : 'Ray diagram',
    mathematical_plot: vi ? 'Đồ thị minh hoạ' : 'Graph',
    geometry_diagram: vi ? 'Hình minh hoạ' : 'Geometry figure',
    geometry_3d: vi ? 'Hình không gian' : '3D figure',
    chemistry_structure: vi ? 'Cấu trúc phân tử' : 'Molecular structure',
    apparatus_diagram: vi ? 'Bố trí thí nghiệm' : 'Apparatus setup',
    biology_diagram: vi ? 'Sơ đồ cấu trúc sinh học' : 'Biology diagram',
    flowchart: vi ? 'Sơ đồ các bước' : 'Process flowchart',
    architecture_diagram: vi ? 'Sơ đồ hệ thống' : 'System architecture',
    data_structure_diagram: vi ? 'Sơ đồ cấu trúc dữ liệu' : 'Data structure',
    network_diagram: vi ? 'Sơ đồ mạng' : 'Network topology',
    map_diagram: vi ? 'Lược đồ' : 'Map',
    chart: vi ? 'Biểu đồ' : 'Chart'
  };
  return map[type] || (vi ? 'Hình minh hoạ' : 'Illustration');
}

// ============================================================================================
// IMAGE PROMPT — CẤU TRÚC 16 MỤC, DELTA MINIMUM SUFFICIENT CONTEXT
// ============================================================================================
// Ảnh AI nay là ĐƯỜNG DUY NHẤT cho hình 2D tĩnh, nên prompt PHẢI mang đủ dữ kiện để hình đúng:
// tên điểm, cạnh, góc, độ dài, quan hệ vuông góc/song song, biểu thức đồ thị, nhãn bắt buộc.
// Nhưng vẫn là DELTA: chỉ serialize SPEC — KHÔNG kèm hội thoại, KHÔNG kèm reasoning, KHÔNG kèm
// cả lời giải, KHÔNG BAO GIỜ kèm chain-of-thought.
//
// Thứ tự 16 mục (cố định, để model đọc ổn định và để test kiểm chứng được):
//   1 Purpose · 2 Subject · 3 Exact facts · 4 Required objects · 5 Required labels ·
//   6 Spatial relationships · 7 Math/measurement constraints · 8 Style · 9 Aspect ratio ·
//   10 Language · 11 No invented data · 12 Educational clarity · 13 High quality ·
//   14 No watermark · 15 No UI screenshot · 16 Do not replace or omit required labels.

// Khối RÀNG BUỘC CỐ ĐỊNH (mục 11-16) — NGẮN và QUAN TRỌNG, không bao giờ bị cắt khi rút gọn prompt.
const IMAGE_SAFETY_CONSTRAINT = 'No invented data: chỉ vẽ đúng dữ kiện đã liệt kê, không thêm đối '
  + 'tượng/số đo/nhãn nào khác. Educational clarity: bố cục sách giáo khoa, nhãn đọc được, không '
  + 'chồng chữ. No watermark, no signature. No UI screenshot, không khung cửa sổ/con trỏ. '
  + 'Do not replace or omit required labels.';
// Cụm chỉ dẫn CHẤT LƯỢNG THUẦN TRỰC QUAN (mục 13) — tách hẳn khỏi ràng buộc dữ kiện ở trên.
const IMAGE_QUALITY_BOOST = 'High quality: độ chi tiết rõ, bố cục cân đối, ánh sáng đều dịu, '
  + 'không nhiễu hạt, không méo hình, đường nét sắc nét như minh hoạ sách giáo khoa cao cấp.';
// Chỉ thị THÊM cho hình học/sơ đồ khoa học — nơi sai một quan hệ là sai cả bài.
const GEOMETRY_STRICT_DIRECTIVES = 'Exact topology, exact point relationships, exact number of '
  + 'entities, preserve orientation, preserve measurements, preserve symbols, no decorative '
  + 'objects that alter meaning.';
// Các loại hình áp dụng chỉ thị siết trên.
const STRICT_TYPES = new Set([
  'geometry_diagram', 'geometry_3d', 'mathematical_plot', 'circuit_diagram', 'optics_diagram',
  'physics_diagram', 'chart', 'flowchart', 'architecture_diagram', 'data_structure_diagram',
  'network_diagram', 'chemistry_structure', 'apparatus_diagram'
]);
// Ngưỡng mặc định khi không biết provider nào đang chạy — lấy mức CHẶT nhất (Gemini 2000).
const DEFAULT_PROMPT_CHAR_LIMIT = 2000;

/** Dữ kiện số đã trích từ lời giải -> "v0 = 20 m/s; α = 30°" */
function factsLine(spec) {
  return (spec.objects || [])
    .map((o) => `${o.symbol} = ${o.value}${o.unit ? ' ' + o.unit : ''}`)
    .join('; ');
}

/** Quan hệ hình học + toạ độ điểm thật -> mô tả không mơ hồ cho image model. */
function relationshipsLine(spec) {
  const parts = [];
  const rel = spec.relationships || [];
  const viRel = {
    perpendicular: 'có cặp đoạn vuông góc (ký hiệu góc vuông)',
    parallel: 'có cặp đoạn song song (ký hiệu mũi tên song song)',
    tangent: 'có đường tiếp tuyến chạm đúng 1 điểm với đường tròn',
    midpoint: 'có trung điểm/trung tuyến được đánh dấu bằng 2 vạch bằng nhau',
    series: 'các phần tử mắc NỐI TIẾP trên cùng một nhánh',
    parallel_circuit: 'các phần tử mắc SONG SONG giữa hai nút'
  };
  rel.forEach((r) => parts.push(viRel[r] || r));
  const pts = (spec.data && spec.data.points) || [];
  if (pts.length) parts.push('toạ độ điểm: ' + pts.map((p) => `${p.label}(${p.x}; ${p.y})`).join(', '));
  return parts.join('; ');
}

/** Ràng buộc toán/số đo: biểu thức đồ thị, phương trình, bước, phân tử, vùng. */
function mathConstraintsLine(spec) {
  const d = spec.data || {};
  const parts = [];
  if (d.plotExpr) {
    parts.push(`vẽ đúng đồ thị y = ${d.plotExpr} trên hệ trục Oxy có chia vạch, gốc O rõ ràng, `
      + 'trục x nằm ngang và trục y thẳng đứng, đánh dấu giao điểm với hai trục');
  }
  if ((spec.requiredEquations || []).length) parts.push('công thức phải hiện đúng: ' + spec.requiredEquations.join(' | '));
  if (d.molecule) parts.push(`công thức phân tử: ${d.molecule.formula} (đúng số nguyên tử mỗi loại)`);
  if ((d.steps || []).length) parts.push('các bước theo đúng thứ tự: ' + d.steps.join(' -> '));
  if ((d.regions || []).length) parts.push('các vùng phải có: ' + d.regions.join(', '));
  return parts.join('; ');
}

/** Đối tượng bắt buộc xuất hiện (thành phần có tên, không phải nhãn điểm). */
function requiredObjectsLine(spec) {
  const parts = (spec.data && spec.data.parts) || [];
  return parts.map((p) => p.name).join(', ');
}

/**
 * buildImagePrompt() — prompt ảnh theo cấu trúc 16 mục.
 *
 * Cắt cứng theo hạn mức ký tự của provider đang dùng: cắt phần MÔ TẢ (mục 1-10) trước, KHÔNG bao
 * giờ cắt khối ràng buộc cuối (mục 11-16).
 *
 * @param {object} spec
 * @param {{maxChars?:number, degrade?:string, repairNote?:string}} [opts]
 * @returns {string}
 */
function buildImagePrompt(spec, opts = {}) {
  const maxChars = Number(opts.maxChars) > 0 ? Number(opts.maxChars) : DEFAULT_PROMPT_CHAR_LIMIT;
  const stylePrompt = spec.stylePrompt || styleProfileFor(spec.subject).prompt;
  const vi = spec.language !== 'en';
  const lines = [];

  lines.push(`Purpose: ${spec.title}${spec.purpose ? ' — ' + spec.purpose : ''}`);
  lines.push(`Subject: ${spec.subject || 'general'} (kiểu hình: ${spec.type})`);

  const facts = factsLine(spec);
  if (facts) lines.push(`Exact facts: ${facts}`);

  const objects = requiredObjectsLine(spec);
  if (objects) lines.push(`Required objects: ${objects}`);

  if ((spec.labels || []).length) {
    lines.push(`Required labels: ${spec.labels.join(', ')} — ghi đúng các nhãn này lên hình, `
      + 'đúng chính tả, không đổi tên, không thêm nhãn khác.');
  }

  const rels = relationshipsLine(spec);
  if (rels) lines.push(`Spatial relationships: ${rels}`);

  const maths = mathConstraintsLine(spec);
  if (maths) lines.push(`Math/measurement constraints: ${maths}`);

  lines.push(`Style: ${stylePrompt}${spec.realismRequired ? ' Hình tả thực đúng cấu trúc thật, không phải sơ đồ khối.' : ''}`);
  lines.push(`Aspect ratio: ${spec.aspectRatio || '1:1'}`);
  lines.push(`Language: ${vi ? 'tiếng Việt' : 'English'} — mọi nhãn văn bản trên hình dùng đúng ngôn ngữ này.`);

  // Mức MEDIUM: cắt bớt phần mô tả phụ (giữ nguyên dữ kiện + nhãn — đó là thứ validator soi).
  let body = lines.join('\n');
  const strict = STRICT_TYPES.has(spec.type) || !!spec.needsPreciseGeometry;
  const tailParts = [];
  if (strict) tailParts.push(GEOMETRY_STRICT_DIRECTIVES);
  if (opts.degrade !== 'low') tailParts.push(IMAGE_QUALITY_BOOST);
  tailParts.push(IMAGE_SAFETY_CONSTRAINT);
  const tail = tailParts.join(' ');

  const budgetForBody = maxChars - tail.length - 1;
  if (budgetForBody > 0 && body.length > budgetForBody) body = body.slice(0, budgetForBody).trimEnd();
  return `${body}\n${tail}`;
}

/** Fingerprint ổn định của spec — dùng làm cache key (PHẦN 22). */
function specFingerprint(spec) {
  const crypto = require('crypto');
  const canonical = JSON.stringify({
    t: spec.type, l: spec.labels, o: spec.objects, r: spec.relationships,
    e: spec.requiredEquations, s: spec.style, lang: spec.language, d: spec.data,
    // Cùng một spec nhưng khác cờ chính xác hình học -> đi renderer khác -> KHÔNG được dùng chung
    // bản cache của nhau.
    ng: spec.needsPreciseGeometry
  });
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 24);
}

module.exports = {
  needsRealism,
  REALISM_REQUIRED_RE,
  VISUAL_PROMPT_VERSION, STYLE_PROFILES, styleProfileFor,
  ASPECT_RATIO_BY_TYPE, VALID_ASPECT_RATIOS, aspectRatioFor,
  computeNeedsPreciseGeometry, buildVisualOverlay,
  IMAGE_SAFETY_CONSTRAINT, IMAGE_QUALITY_BOOST, GEOMETRY_STRICT_DIRECTIVES, STRICT_TYPES,
  DEFAULT_PROMPT_CHAR_LIMIT,
  buildVisualSpec, buildImagePrompt, specFingerprint,
  extractPointLabels, extractQuantities, extractEquations, extractSteps, extractPlottableFunction,
  extractNamedParts, extractMolecularFormula, extractRegions,
  extractPointCoordinates, anchorsFromPoints
};
