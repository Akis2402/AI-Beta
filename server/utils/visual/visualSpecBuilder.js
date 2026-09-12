'use strict';

// ============================================================================================
// PHẦN 16/17 — IMAGE SPECIFICATION CÓ CẤU TRÚC (AI KHÔNG ĐƯỢC TỰ TẠO ẢNH TÙY TIỆN)
// ============================================================================================
// Không bao giờ đi thẳng từ "câu trả lời" -> "prompt ảnh dài". Luôn qua 1 SPEC có cấu trúc:
//
//   { type, purpose, title, labels[], objects[], relationships[], requiredEquations[],
//     visualConstraints[], style, language }
//
// Lợi ích (đúng PHẦN 16): deterministic hơn, dễ cache (hash spec), dễ test, dễ sửa, token thấp hơn
// (PHẦN 17: image prompt = DELTA MINIMUM SUFFICIENT CONTEXT — chỉ spec, KHÔNG gửi cả hội thoại,
// KHÔNG gửi reasoning, KHÔNG gửi cả lời giải).
//
// Spec được trích TỪ FINAL VERIFIED FACTS (PHẦN 24): với cross-check, hàm này chỉ được gọi SAU
// reconciliation, trên văn bản cuối cùng — không phải trên candidate đầu tiên.

const MAX_LABELS = 12;
const MAX_OBJECTS = 14;
const MAX_EQUATIONS = 4;

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
 * Trích hàm số f(x) để vẽ đồ thị deterministic. Chỉ chấp nhận biểu thức ĐƠN GIẢN, an toàn —
 * KHÔNG eval chuỗi tuỳ ý (xem deterministicRenderer.evalPolynomial).
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
 * extractMolecularFormula() — trích công thức phân tử (C4H10, H2SO4, NaCl...) để dựng mô hình liên
 * kết deterministic. Chỉ nhận công thức CÓ TRONG lời giải.
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
// RỦI RO #3 — RENDERER SINH HỌC/ĐỊA LÝ CHỈ Ở MỨC SƠ ĐỒ
// ============================================================================================
// deterministicRenderer dựng sơ đồ khối có nhãn — đủ cho "kể tên các bào quan", KHÔNG đủ cho "nhận
// dạng cấu trúc lá cắt ngang" hay "đọc lát cắt địa hình thật". Hướng xử lý ĐÚNG là thừa nhận giới
// hạn và định tuyến, KHÔNG phải làm renderer đoán hình giải phẫu (hình sai còn tệ hơn không hình —
// PHẦN 26).
//
// `realismRequired` là tín hiệu đó: đề cần hình THẬT, không phải sơ đồ khái niệm.
//   - Có image provider  -> ưu tiên image generation (router).
//   - Không có           -> vẫn dựng sơ đồ, nhưng caption nói THẲNG đây là sơ đồ khái niệm, và
//                           telemetry ghi `visualFidelity='schematic'` để người vận hành thấy nhu
//                           cầu cấu hình image provider thay vì tưởng hệ thống đang chạy tốt.
const REALISM_REQUIRED_RE = /(cắt ngang|lát cắt|giải phẫu|tiêu bản|vi thể|kính hiển vi|hình thái|nhận dạng|quan sát thực tế|ảnh chụp|ảnh vệ tinh|bản đồ (địa hình|tự nhiên|hành chính)|micrograph|cross[- ]section|anatomy|histolog)/i;

/** @returns {boolean} đề đòi hình THẬT chứ không phải sơ đồ khái niệm. */
function needsRealism(text, subject) {
  if (!REALISM_REQUIRED_RE.test(String(text || ''))) return false;
  // Chỉ có nghĩa với các môn mà renderer deterministic vốn chỉ đạt mức sơ đồ.
  return ['biology', 'geography', 'chemistry', 'general'].includes(subject);
}

function buildVisualSpec({ decision, finalAnswer = '', question = '', subject = 'general', language = 'vi', grade = '' }) {
  const type = (decision && decision.visualType) || 'concept_illustration';
  // Chỉ đọc phần đầu của lời giải: dữ kiện/hình luôn được thiết lập ở đầu, phần sau là tính toán.
  const head = String(finalAnswer).slice(0, 3500);
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

  return {
    type,
    purpose: (decision && decision.visualPurpose) || '',
    title: buildTitle({ type, question, language }),
    labels: labels.slice(0, MAX_LABELS),
    objects: quantities,
    relationships,
    requiredEquations,
    visualConstraints,
    style: 'educational_scientific',
    // Rủi ro #3: đánh dấu tường minh những đề mà sơ đồ SVG không đủ trung thực.
    realismRequired: needsRealism(source, subject),
    language: language === 'English' || language === 'en' ? 'en' : 'vi',
    grade: grade || '',
    subject,
    data: { steps, plotExpr, parts: extractNamedParts(head), molecule: extractMolecularFormula(source), regions: extractRegions(head) }
  };
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

/**
 * PHẦN 17 — IMAGE PROMPT = DELTA MINIMUM SUFFICIENT CONTEXT.
 * Chỉ serialize những gì hình cần. KHÔNG kèm hội thoại, KHÔNG kèm reasoning, KHÔNG kèm cả lời giải.
 * @returns {string} prompt ngắn (thường < 180 token) cho image model.
 */
function buildImagePrompt(spec) {
  const lines = [
    `${spec.title} — ${spec.purpose}`,
    `Kiểu hình: ${spec.type}. Phong cách: ${spec.style}. Ngôn ngữ nhãn: ${spec.language}.`
  ];
  if (spec.labels.length) lines.push(`Nhãn: ${spec.labels.join(', ')}.`);
  if (spec.objects.length) {
    lines.push('Đại lượng: ' + spec.objects.map((o) => `${o.symbol}=${o.value}${o.unit}`).join('; ') + '.');
  }
  if (spec.relationships.length) lines.push(`Quan hệ: ${spec.relationships.join(', ')}.`);
  if (spec.requiredEquations.length) lines.push(`Công thức phải hiển thị đúng: ${spec.requiredEquations.join(' ; ')}.`);
  lines.push(spec.visualConstraints.join(' '));
  lines.push('Nền trắng, nét sạch, không chữ thừa, không watermark.');
  return lines.join('\n');
}

/** Fingerprint ổn định của spec — dùng làm cache key (PHẦN 22). */
function specFingerprint(spec) {
  const crypto = require('crypto');
  const canonical = JSON.stringify({
    t: spec.type, l: spec.labels, o: spec.objects, r: spec.relationships,
    e: spec.requiredEquations, s: spec.style, lang: spec.language, d: spec.data
  });
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 24);
}

module.exports = {
  needsRealism,
  REALISM_REQUIRED_RE,
  buildVisualSpec, buildImagePrompt, specFingerprint,
  extractPointLabels, extractQuantities, extractEquations, extractSteps, extractPlottableFunction,
  extractNamedParts, extractMolecularFormula, extractRegions
};
