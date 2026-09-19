'use strict';

// ============================================================================================
// VISUAL SCORING CONFIG — bảng trọng số TÁCH RIÊNG khỏi thuật toán quyết định
// ============================================================================================
// Lý do tách (rủi ro #1 trong báo cáo trước): trọng số là thứ DUY NHẤT trong visualDecisionEngine
// cần tinh chỉnh theo dữ liệu thật. Khi nó nằm lẫn trong thuật toán, mỗi lần tinh chỉnh lại phải
// sửa file logic -> dễ vô tình phá luật (đặc biệt là HARD_VETO của PHẦN 14).
//
// Nay:
//   - Toàn bộ con số nằm ở đây, có thể override bằng ENV mà KHÔNG sửa code
//     (VISUAL_THRESHOLD_AUTO, VISUAL_THRESHOLD_ALWAYS, VISUAL_BORDERLINE_BAND,
//      VISUAL_SIGNAL_WEIGHTS='math.geometry=0.6,physics.forces=0.5').
//   - test/visual-decision-corpus.test.js là BỘ CHUẨN: 40 câu hỏi có nhãn đúng/sai, đo
//     precision/recall. Mọi lần chỉnh trọng số PHẢI chạy lại bộ này.
//   - HARD_VETO không bao giờ override được bằng env (PHẦN 14 là tuyệt đối).

const SETTING = Object.freeze({ AUTO: 'auto', ALWAYS: 'always', NEVER: 'never' });

function envNum(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

// ---------- NGƯỠNG ĐÃ HIỆU CHỈNH BẰNG BỘ CHUẨN (test/visual-decision-corpus.test.js) ----------
// Bản đầu đặt AUTO = 0.55 hoàn toàn theo cảm tính và recall chỉ đạt 0.65: một tín hiệu môn học
// MẠNH (vd "mạch điện", "cấu tạo tế bào", "lát cắt địa hình") chỉ đạt ~0.42-0.50 nên bị chặn, dù
// PHẦN 13 liệt kê đúng những trường hợp đó là "ưu tiên tạo hình".
//
// Đo trên bộ chuẩn 44 câu: điểm CAO NHẤT của nhóm "không nên vẽ" là 0.18, điểm THẤP NHẤT của nhóm
// "nên vẽ" là 0.42 — hai phân phối tách bạch hoàn toàn. Ngưỡng 0.40 nằm giữa khoảng trống đó, cho
// biên an toàn ~0.22 ở phía false-positive và ~0.02 ở phía false-negative.
const THRESHOLD = {
  [SETTING.AUTO]: envNum('VISUAL_THRESHOLD_AUTO', 0.4),
  [SETTING.ALWAYS]: envNum('VISUAL_THRESHOLD_ALWAYS', 0.28),
  [SETTING.NEVER]: Infinity
};
const BORDERLINE_BAND = envNum('VISUAL_BORDERLINE_BAND', 0.1);

// ---------- PHẦN 13: tín hiệu theo môn ----------
// `id` dùng để override trọng số qua env mà không phải đụng regex.
const SUBJECT_SIGNALS = {
  physics: [
    { id: 'physics.forces', re: /(lực|trọng lực|ma sát|phản lực|hợp lực|momen|mô men)/i, type: 'physics_diagram', w: 0.46 },
    { id: 'physics.motion', re: /(ném xiên|ném ngang|quỹ đạo|chuyển động (tròn|thẳng|biến đổi)|rơi tự do)/i, type: 'physics_diagram', w: 0.5 },
    { id: 'physics.circuit', re: /(mạch điện|điện trở|tụ điện|cuộn cảm|nguồn điện|mắc (nối tiếp|song song))/i, type: 'circuit_diagram', w: 0.5 },
    { id: 'physics.field', re: /(điện trường|từ trường|đường sức|cảm ứng từ)/i, type: 'physics_diagram', w: 0.46 },
    { id: 'physics.optics', re: /(tia sáng|khúc xạ|phản xạ|thấu kính|gương (cầu|phẳng)|quang học)/i, type: 'optics_diagram', w: 0.5 },
    { id: 'physics.wave', re: /(sóng|dao động|con lắc|biên độ|bước sóng|giao thoa)/i, type: 'mathematical_plot', w: 0.4 },
    { id: 'physics.machine', re: /(mặt phẳng nghiêng|ròng rọc|đòn bẩy)/i, type: 'physics_diagram', w: 0.48 }
  ],
  math: [
    { id: 'math.plot', re: /(đồ thị|vẽ đồ thị|khảo sát hàm|parabol|hyperbol|đường cong)/i, type: 'mathematical_plot', w: 0.56 },
    { id: 'math.geometry', re: /(tam giác|tứ giác|hình (vuông|chữ nhật|thang|bình hành|thoi)|đường tròn|tiếp tuyến)/i, type: 'geometry_diagram', w: 0.52 },
    { id: 'math.solid', re: /(hình (chóp|lăng trụ|hộp|cầu|nón|trụ)|khối đa diện|không gian Oxyz)/i, type: 'geometry_3d', w: 0.54 },
    { id: 'math.vector', re: /(vector|vecto|véc tơ|toạ độ|tọa độ|hệ trục)/i, type: 'geometry_diagram', w: 0.36 },
    { id: 'math.region', re: /(miền nghiệm|bất phương trình bậc nhất hai ẩn|quy hoạch tuyến tính)/i, type: 'mathematical_plot', w: 0.5 },
    { id: 'math.function', re: /(hàm số|y\s*=\s*f\s*\(\s*x\s*\)|f\s*\(\s*x\s*\)\s*=)/i, type: 'mathematical_plot', w: 0.24 }
  ],
  chemistry: [
    { id: 'chem.structure', re: /(cấu (trúc|tạo) phân tử|công thức cấu tạo|đồng phân|liên kết (đơn|đôi|ba|hoá học|hóa học))/i, type: 'chemistry_structure', w: 0.5 },
    { id: 'chem.process', re: /(sơ đồ phản ứng|chuỗi phản ứng|điều chế|quy trình sản xuất)/i, type: 'flowchart', w: 0.48 },
    { id: 'chem.atom', re: /(mô hình nguyên tử|cấu hình electron|orbital|lớp electron)/i, type: 'chemistry_structure', w: 0.48 },
    { id: 'chem.apparatus', re: /(bộ (dụng cụ|thiết bị) thí nghiệm|bình cầu|ống nghiệm|chưng cất|điện phân)/i, type: 'apparatus_diagram', w: 0.48 }
  ],
  biology: [
    { id: 'bio.cell', re: /(tế bào|màng tế bào|ti thể|lục lạp|nhân tế bào|bào quan)/i, type: 'biology_diagram', w: 0.5 },
    { id: 'bio.organ', re: /(hệ (tuần hoàn|hô hấp|tiêu hoá|tiêu hóa|thần kinh|bài tiết)|cơ quan)/i, type: 'biology_diagram', w: 0.48 },
    { id: 'bio.cycle', re: /(chu trình|quang hợp|hô hấp tế bào|nguyên phân|giảm phân|ADN|ARN|nhân đôi)/i, type: 'flowchart', w: 0.48 }
  ],
  geography: [
    { id: 'geo.map', re: /(bản đồ|lược đồ|vị trí địa lý|khu vực|vùng kinh tế)/i, type: 'map_diagram', w: 0.48 },
    { id: 'geo.chart', re: /(biểu đồ (khí hậu|nhiệt độ|lượng mưa)|địa hình|lát cắt)/i, type: 'chart', w: 0.5 },
    { id: 'geo.cycle', re: /(chu trình (nước|đá|sinh địa hoá|sinh địa hóa)|vòng tuần hoàn)/i, type: 'flowchart', w: 0.48 }
  ],
  'computer-science': [
    { id: 'cs.flowchart', re: /(lưu đồ|flowchart|sơ đồ khối|thuật toán)/i, type: 'flowchart', w: 0.5 },
    { id: 'cs.architecture', re: /(kiến trúc|architecture|sơ đồ hệ thống|mô hình client|server)/i, type: 'architecture_diagram', w: 0.48 },
    { id: 'cs.datastructure', re: /(cây nhị phân|danh sách liên kết|đồ thị|stack|queue|hash table)/i, type: 'data_structure_diagram', w: 0.5 },
    { id: 'cs.network', re: /(topology|mạng (LAN|WAN)|sơ đồ mạng)/i, type: 'network_diagram', w: 0.5 }
  ]
};

// ============================================================================================
// RỦI RO #2 — MỞ RỘNG PHÂN PHỐI: tín hiệu TIẾNG ANH và tín hiệu ĐẠI HỌC
// ============================================================================================
// Bộ chuẩn cũ 100% tiếng Việt phổ thông, nên toàn bộ bảng tín hiệu cũng chỉ có regex tiếng Việt —
// một đề bài tiếng Anh ("Draw a free body diagram...") ghi 0 điểm và bị bỏ qua hoàn toàn, dù
// LANG=auto là chế độ được hỗ trợ chính thức của sản phẩm. Đây là lỗ hổng THẬT, chỉ lộ ra khi bộ
// chuẩn được mở rộng sang vùng phân phối đó.
//
// Trọng số đặt NGANG BẰNG bản tiếng Việt tương ứng: cùng một khái niệm thì cùng một mức tín hiệu,
// không thiên vị ngôn ngữ.
const ENGLISH_SIGNALS = [
  { id: 'en.plot', re: /\b(graph of|sketch the graph|plot the|asymptote|parabola|hyperbola)\b/i, type: 'mathematical_plot', w: 0.56 },
  { id: 'en.geometry', re: /\b(triangle|quadrilateral|rectangle|rhombus|trapezoid|circle|tangent line)\b/i, type: 'geometry_diagram', w: 0.52 },
  { id: 'en.solid', re: /\b(pyramid|prism|cuboid|sphere|cone|cylinder|polyhedron)\b/i, type: 'geometry_3d', w: 0.54 },
  { id: 'en.forces', re: /\b(free[- ]body diagram|friction|normal force|resultant force|torque|inclined plane)\b/i, type: 'physics_diagram', w: 0.5 },
  { id: 'en.circuit', re: /\b(circuit|resistor|capacitor|inductor|in series|in parallel)\b/i, type: 'circuit_diagram', w: 0.5 },
  { id: 'en.optics', re: /\b(ray of light|refraction|reflection|lens|mirror)\b/i, type: 'optics_diagram', w: 0.5 },
  { id: 'en.biology', re: /\b(cell|chloroplast|mitochondri(?:on|a)|membrane|organelle|anatomy)\b/i, type: 'biology_diagram', w: 0.5 },
  { id: 'en.chemistry', re: /\b(molecular structure|structural formula|isomer|orbital|reaction mechanism)\b/i, type: 'chemistry_structure', w: 0.5 },
  { id: 'en.flowchart', re: /\b(flowchart|state machine|state diagram|pipeline|workflow)\b/i, type: 'flowchart', w: 0.5 },
  { id: 'en.architecture', re: /\b(architecture diagram|system diagram|client[- ]server|topology)\b/i, type: 'architecture_diagram', w: 0.48 },
  { id: 'en.datastructure', re: /\b(binary (search )?tree|linked list|hash table|adjacency (list|matrix))\b/i, type: 'data_structure_diagram', w: 0.5 },
  { id: 'en.map', re: /\b(map of|region|terrain|cross[- ]section)\b/i, type: 'map_diagram', w: 0.46 }
];

// Tín hiệu bậc ĐẠI HỌC/sau phổ thông — bộ chuẩn cũ không có mẫu nào nên các khái niệm này chưa từng
// được tính điểm, dù chúng hiển nhiên cần hình.
const ADVANCED_SIGNALS = [
  { id: 'adv.phasor', re: /(giản đồ (fresnel|vector|véc ?tơ)|phasor|giản đồ pha)/i, type: 'physics_diagram', w: 0.52 },
  { id: 'adv.linalg', re: /(không gian vector|hệ phương trình tuyến tính|ánh xạ tuyến tính|không gian con)/i, type: 'geometry_diagram', w: 0.44 },
  { id: 'adv.mechanism', re: /(cơ chế phản ứng|s_?n1|s_?n2|đảo cấu hình|chuyển vị)/i, type: 'chemistry_structure', w: 0.5 },
  { id: 'adv.state', re: /(chuyển trạng thái|máy trạng thái|sơ đồ trạng thái|vòng đời (tiến trình|tiến trình|đối tượng))/i, type: 'flowchart', w: 0.5 },
  { id: 'adv.transform', re: /(chuyển ho[áa] giữa|chuỗi chuyển ho[áa]|sơ đồ chuyển ho[áa])/i, type: 'flowchart', w: 0.48 }
];

const GENERIC_SIGNALS = [
  // "vẽ ..." / "đồ thị" là YÊU CẦU TƯỜNG MINH của người dùng — bộ chuẩn
  // (test/visual-decision-corpus.test.js) phát hiện bản đầu bỏ sót "Vẽ đồ thị y=x^2" vì câu quá
  // ngắn nên bị phạt ambiguity. Yêu cầu tường minh luôn miễn phạt ambiguity (xem decision engine).
  // B9.10: bổ sung các biến thể diễn đạt mà bộ chuẩn mở rộng phát hiện bị bỏ sót — "tạo infographic",
  // "cho tôi hình trực quan", "tạo hình ảnh mô phỏng", và toàn bộ nhánh TIẾNG ANH ("draw", "sketch",
  // "generate an educational image", "illustrate", "label the..."). Thiếu chúng thì một yêu cầu
  // tường minh hiển nhiên của người dùng vẫn bị chấm 0 điểm.
  {
    id: 'generic.explicit',
    re: /(minh hoạ|minh họa|vẽ\s+\S|vẽ lại|hình vẽ|sơ đồ|biểu đồ|đồ thị|mô tả bằng hình|infographic|hình trực quan|hình ảnh mô phỏng|tạo hình|hình minh)|\b(draw|sketch|illustrate|diagram|plot|visuali[sz]e|generate an? (educational )?image|label the)\b/i,
    type: 'auto', w: 0.45, explicit: true
  },
  { id: 'generic.process', re: /(so sánh .{0,40}(giữa|với)|các giai đoạn|các bước .{0,20}(quá trình|quy trình))/i, type: 'flowchart', w: 0.2 }
];

// ---------- PHẦN 14: veto — KHÔNG override được bằng env ----------
// A3.2 (làm rõ sau khi bộ chuẩn mở rộng lộ ra mâu thuẫn): "veto tuyệt đối" và "yêu cầu tường minh
// của người dùng luôn thắng" xung đột nhau ở đúng một điểm. Tách làm 2 hạng:
//
//   absolute:true  — KHÔNG CÓ GÌ ĐỂ VẼ. Phép tính tầm thường, câu hỏi định nghĩa. Người dùng có nhờ
//                    cách mấy thì một hình cho "2+2" vẫn vô nghĩa. Explicit request KHÔNG phá được.
//   absolute:false — giá trị THẤP chứ không phải bằng không (đề văn/ngoại ngữ). Ở đây người dùng
//                    hiểu rõ bài của mình hơn heuristic: "vẽ sơ đồ tư duy cho bài thơ này" là yêu
//                    cầu chính đáng, nên explicit request được phép override.
const HARD_VETO = [
  { re: /^\s*[-+(]?\s*\d[\d\s.,+\-*/^%():=]*\s*(bằng bao nhiêu|bằng mấy|là bao nhiêu|=)?\s*\?*\s*$/i, reason: 'pure_arithmetic', absolute: true },
  { re: /^\s*(tính|tinh)\s+[\d\s.,+\-*/^%():=]+\s*$/i, reason: 'pure_arithmetic', absolute: true },
  // Phép tính tầm thường KÈM một lời nhờ vẽ hình ("2+2 bằng mấy, vẽ hình minh hoạ giúp tôi") — bản
  // cũ chỉ khớp khi TOÀN BỘ câu là số, nên mệnh đề phụ phía sau làm veto trượt. Veto phải bám vào
  // MỆNH ĐỀ CHÍNH: không có gì để vẽ cho 2+2, dù người dùng có nhờ cách mấy.
  { re: /^\s*[-+(]?\s*\d[\d\s.,+\-*/^%():=]{0,24}(bằng bao nhiêu|bằng mấy|là bao nhiêu|=)?\s*\??\s*[,;.]/i, reason: 'pure_arithmetic', absolute: true },
  { re: /^\s*(định nghĩa|khái niệm|thế nào là|là gì)\b/i, reason: 'definition_only', absolute: true },
  // Bộ chuẩn mở rộng phát hiện: "Big-O của quicksort trung bình LÀ GÌ?" không khớp regex trên (vì
  // "là gì" không đứng đầu câu) nên lọt xuống scoring và trúng tín hiệu "thuật toán" -> vẽ thừa.
  // Câu hỏi định nghĩa/giá trị đơn lẻ kết thúc bằng "là gì?" KHÔNG có gì để vẽ, bất kể môn.
  { re: /\blà\s+(gì|bao nhiêu)\s*\??\s*$/i, reason: 'definition_only', absolute: true },
  { re: /^\s*(what is|what are|define)\b/i, reason: 'definition_only', absolute: true },
  { re: /\b(nêu|trình bày|phát biểu)\s+(định nghĩa|khái niệm|định luật|quy tắc)\b/i, reason: 'definition_only', absolute: true },
  { re: /\b(dịch|translate|chia động từ|thì hiện tại|phân tích (câu|khổ thơ|bài thơ)|nghị luận)\b/i, reason: 'language_or_literature' }
];

const LOW_VALUE_SUBJECTS = new Set(['literature', 'english', 'history', 'economics-civics']);

// ---------- Hệ số điều chỉnh (modifier) ----------
const MODIFIERS = {
  spatialRelationship: envNum('VISUAL_W_SPATIAL', 0.18),
  processVisibility: envNum('VISUAL_W_PROCESS', 0.14),
  complexityLarge: envNum('VISUAL_W_COMPLEX_LARGE', 0.06),
  complexityVeryLarge: envNum('VISUAL_W_COMPLEX_VERY_LARGE', 0.1),
  ambiguityPenalty: envNum('VISUAL_W_AMBIGUITY', 0.15),
  costPenalty: envNum('VISUAL_W_COST', 0.06),
  redundancyDrawing: envNum('VISUAL_W_REDUNDANCY_DRAWING', 0.9),
  redundancyTable: envNum('VISUAL_W_REDUNDANCY_TABLE', 0.25)
};

const SPATIAL_RE = /(vuông góc|vuông tại|song song|nội tiếp|ngoại tiếp|trung điểm|nằm giữa|phía (trên|dưới|trái|phải)|hướng|góc\s*\d|toạ độ|tọa độ|trục)/i;
const PROCESS_RE = /(bước\s*\d[\s\S]{0,200}bước\s*\d|giai đoạn\s*\d|quy trình|chu trình|sơ đồ)/i;

/**
 * applyEnvWeightOverrides() — cho phép tinh chỉnh trọng số trên production mà không deploy lại code.
 * Định dạng: VISUAL_SIGNAL_WEIGHTS="math.geometry=0.6,physics.forces=0.5"
 * Giá trị ngoài khoảng (0, 1] bị bỏ qua (fail-safe, không cho vô hiệu hoá 1 tín hiệu bằng số âm).
 */
function applyEnvWeightOverrides(raw) {
  const src = raw === undefined ? process.env.VISUAL_SIGNAL_WEIGHTS : raw;
  if (!src) return [];
  const applied = [];
  String(src).split(',').forEach((pair) => {
    const [id, val] = pair.split('=').map((x) => String(x || '').trim());
    const w = Number(val);
    if (!id || !Number.isFinite(w) || w <= 0 || w > 1) return;
    const all = [].concat(...Object.values(SUBJECT_SIGNALS), GENERIC_SIGNALS);
    const sig = all.find((s) => s.id === id);
    if (sig) { sig.w = w; applied.push({ id, w }); }
  });
  return applied;
}
applyEnvWeightOverrides();

module.exports = {
  SETTING, THRESHOLD, BORDERLINE_BAND,
  SUBJECT_SIGNALS, GENERIC_SIGNALS, ENGLISH_SIGNALS, ADVANCED_SIGNALS, HARD_VETO, LOW_VALUE_SUBJECTS,
  MODIFIERS, SPATIAL_RE, PROCESS_RE,
  applyEnvWeightOverrides
};
