'use strict';

// ============================================================================================
// MỤC 14 — MỞ RỘNG AI HỖ TRỢ ĐA MÔN HỌC
// ============================================================================================
// Kiến trúc: Subject -> Detection -> Configuration -> Prompt Strategy -> (client) Renderer/Badge.
// THIẾT KẾ (14.8): thay vì 1 file riêng mỗi môn (math.js/physics.js/...), dùng 1 REGISTRY khai báo
// (data-driven) — thêm môn mới = thêm 1 object vào mảng SUBJECTS, KHÔNG cần sửa logic detect/prompt/
// route. Tương đương về khả năng mở rộng (14.17: không hard-code giới hạn số môn) nhưng tránh 12 file
// gần như trùng cấu trúc, dễ audit/đồng bộ hơn cho 1 hệ thống nhỏ như dự án này. server/utils/subjects.js
// là SOURCE OF TRUTH (prompt strategy, chỉ AI backend cần); public/js/subjects.js chỉ giữ phần hiển thị
// (id/name/icon) cho UI, KHÔNG lặp lại systemPrompt (client không tự dựng prompt — xem validators.js).
//
// (14.18) KHÔNG đụng tới pipeline giải Toán hiện có: subject 'math' chỉ thêm 1 đoạn NHẤN MẠNH ngắn,
// mọi hướng dẫn công thức/KaTeX/hình vẽ/bảng gốc trong promptBuilder.js giữ nguyên 100%.

const SUBJECTS = [
  {
    id: 'math', name: 'Toán học', icon: '📐', color: '#2F3AB8',
    detectionHints: [
      'phương trình', 'bất phương trình', 'đạo hàm', 'tích phân', 'giới hạn', 'hàm số', 'ma trận',
      'xác suất', 'thống kê', 'hình học', 'lượng giác', 'số phức', 'tổ hợp', 'dãy số', 'bất đẳng thức',
      'solve', 'equation', 'derivative', 'integral', 'calculate', '=', '∫', '√',
      'tốc độ tăng trưởng', 'tỉ lệ phần trăm', 'tỷ lệ phần trăm'
    ],
    tableRule: 'Cách giải | Công thức | Kết quả (khi có nhiều cách giải/trường hợp cần đối chiếu).',
    priorities: 'Công thức, biến đổi từng bước, kiểm tra kết quả, điều kiện xác định, đơn vị, phương pháp giải, kết luận.'
  },
  {
    id: 'physics', name: 'Vật lý', icon: '⚛️', color: '#1E88E5',
    detectionHints: [
      'vận tốc', 'gia tốc', 'lực', 'khối lượng', 'công suất', 'điện trở', 'dòng điện', 'từ trường',
      'quang học', 'dao động', 'sóng', 'niutơn', 'định luật', 'm/s', 'n/kg', 'velocity', 'newton', 'ohm'
    ],
    tableRule: 'Đại lượng | Ký hiệu | Giá trị | Đơn vị.',
    priorities: '1) Tóm tắt dữ kiện 2) Đổi đơn vị 3) Xác định đại lượng cần tìm 4) Chọn định luật/công thức 5) Thay số 6) Tính toán 7) Kiểm tra đơn vị 8) Kết luận.'
  },
  {
    id: 'chemistry', name: 'Hóa học', icon: '🧪', color: '#00897B',
    detectionHints: [
      'phản ứng', 'phương trình hóa học', 'dung dịch', 'nồng độ mol', 'khối lượng mol', 'hóa trị',
      'kết tủa', 'cân bằng phương trình', 'oxi hóa', 'khử', 'hcl', 'naoh', 'h2so4', 'mol', 'ph'
    ],
    tableRule: 'Chất | Công thức | Số mol | Khối lượng | Vai trò.',
    priorities: 'Công thức hóa học chính xác, cân bằng phương trình, mol, khối lượng mol, nồng độ, điều kiện phản ứng, chuỗi phản ứng, nhận biết chất. KHÔNG tự bịa phương trình hóa học.'
  },
  {
    id: 'biology', name: 'Sinh học', icon: '🧬', color: '#43A047',
    detectionHints: [
      'tế bào', 'nhiễm sắc thể', 'adn', 'dna', 'gen', 'nguyên phân', 'giảm phân', 'quang hợp',
      'hô hấp tế bào', 'enzyme', 'ty thể', 'di truyền', 'đột biến', 'hệ sinh thái'
    ],
    tableRule: 'Đặc điểm | Đối tượng A | Đối tượng B (khi so sánh 2 quá trình/cấu trúc).',
    priorities: 'Khái niệm, cơ chế, quá trình, cấu trúc, so sánh, sơ đồ hóa kiến thức.'
  },
  {
    id: 'literature', name: 'Ngữ văn', icon: '📖', color: '#8E24AA',
    detectionHints: [
      'phân tích tác phẩm', 'phân tích nhân vật', 'nghị luận văn học', 'nghị luận xã hội', 'lập dàn ý',
      'đoạn thơ', 'bài thơ', 'tác giả', 'hình tượng', 'nghệ thuật', 'tóm tắt tác phẩm', 'mở bài', 'kết bài'
    ],
    tableRule: 'Tiêu chí | Tác phẩm A | Tác phẩm B (khi so sánh 2 tác phẩm/nhân vật).',
    priorities: 'Nhận định, dẫn chứng, phân tích, ý nghĩa, đánh giá. KHÔNG trả lời máy móc kiểu công thức, KHÔNG bịa dẫn chứng.'
  },
  {
    id: 'english', name: 'Tiếng Anh', icon: '🇬🇧', color: '#D81B60',
    detectionHints: [
      'choose the correct', 'fill in the blank', 'grammar', 'vocabulary', 'translate', 'tense',
      'pronunciation', 'error correction', 'sentence transformation', 'reading comprehension'
    ],
    tableRule: 'Đáp án | Đúng/Sai | Giải thích.',
    priorities: 'Đáp án, giải thích, công thức/ngữ pháp liên quan, vì sao các đáp án khác sai. Kiểm tra grammar/spelling/tense/agreement trước khi kết luận.'
  },
  {
    id: 'history', name: 'Lịch sử', icon: '🏛️', color: '#6D4C41',
    detectionHints: [
      'chiến thắng', 'chiến tranh', 'khởi nghĩa', 'triều đại', 'cách mạng', 'hiệp định', 'diễn biến',
      'nguyên nhân', 'kết quả', 'ý nghĩa lịch sử', 'thực dân', 'kháng chiến'
    ],
    tableRule: 'Thời gian | Sự kiện | Ý nghĩa.',
    priorities: 'Nguyên nhân, diễn biến, kết quả, ý nghĩa, nhân vật, mốc thời gian chính xác — không bịa mốc/nhân vật/sự kiện.'
  },
  {
    id: 'geography', name: 'Địa lý', icon: '🌍', color: '#00ACC1',
    detectionHints: [
      'đồng bằng', 'khí hậu', 'dân số', 'mật độ dân số', 'kinh tế vùng', 'tài nguyên thiên nhiên',
      'bản đồ', 'lưu vực sông', 'địa hình', 'gdp', 'đô thị hóa'
    ],
    tableRule: 'Khu vực | Dân số | Diện tích | Mật độ (khi có số liệu để so sánh).',
    priorities: 'Vị trí, điều kiện tự nhiên, dân cư, kinh tế, so sánh vùng; ưu tiên bảng khi có số liệu.'
  },
  {
    id: 'computer-science', name: 'Tin học', icon: '💻', color: '#5E35B1',
    detectionHints: [
      'viết chương trình', 'thuật toán', 'python', 'javascript', 'html', 'css', 'sql', 'debug',
      'hàm số' /* trùng math, nhưng có 'code'/'function' đi kèm nên ưu tiên đúng ngữ cảnh */,
      'code', 'function', 'array', 'loop', 'compile', 'syntax error'
    ],
    tableRule: 'KHÔNG đưa code vào bảng trừ khi thực sự cần — luôn dùng code block (```lang).',
    priorities: 'Đọc hiểu yêu cầu, thuật toán/cấu trúc dữ liệu phù hợp, code đúng cú pháp trong code block, giải thích, kiểm tra edge case/logic.'
  },
  {
    id: 'natural-science', name: 'Khoa học tự nhiên', icon: '🔬', color: '#7CB342',
    detectionHints: ['khoa học tự nhiên', 'thí nghiệm', 'hiện tượng tự nhiên'],
    tableRule: 'Tuỳ nội dung cụ thể (Lý/Hóa/Sinh) mà chọn cột phù hợp.',
    priorities: 'Môn tích hợp Lý/Hóa/Sinh (THCS) — xác định đúng khía cạnh chính của câu hỏi rồi áp dụng ưu tiên tương ứng.'
  },
  {
    id: 'economics-civics', name: 'Kinh tế / Công dân', icon: '⚖️', color: '#F4511E',
    detectionHints: ['pháp luật', 'quyền công dân', 'kinh tế thị trường', 'cung cầu', 'đạo đức', 'gdcd'],
    tableRule: 'Tiêu chí | Trường hợp A | Trường hợp B.',
    priorities: 'Khái niệm đúng, ví dụ thực tế, liên hệ pháp luật/đạo đức hiện hành, tránh khẳng định pháp lý sai.'
  },
  {
    id: 'general', name: 'Môn học khác', icon: '📚', color: '#757575',
    detectionHints: [],
    tableRule: 'Chỉ dùng bảng khi thực sự có ≥2 nhóm cần so sánh.',
    priorities: 'Trả lời đúng trọng tâm câu hỏi, có cấu trúc rõ ràng, không suy diễn ngoài kiến thức chuẩn.'
  }
];

const SUBJECT_MAP = new Map(SUBJECTS.map((s) => [s.id, s]));
const ALLOWED_SUBJECT_IDS = SUBJECTS.map((s) => s.id).concat(['auto']);

function getSubject(id) {
  return SUBJECT_MAP.get(id) || SUBJECT_MAP.get('general');
}

// ---------- 14.2 Tự động nhận diện môn (+ 14.7: phát hiện câu hỏi liên quan nhiều môn) ----------
// Heuristic từ khóa (không tốn thêm 1 lượt gọi AI riêng — giữ đúng tinh thần 14.19 hiệu năng/không
// tăng chi phí). Không hoàn hảo bằng phân loại bằng AI nhưng đủ tin cậy cho badge + định hướng prompt,
// và AI vẫn TỰ đọc toàn bộ đề bài nên dù heuristic đoán sai môn, model vẫn trả lời đúng nội dung —
// heuristic sai chỉ ảnh hưởng phần NHẤN MẠNH ưu tiên trong prompt, không chặn hay bóp méo câu trả lời.
function scoreSubjects(text) {
  const t = String(text || '').toLowerCase();
  const scores = [];
  if (!t.trim()) return scores;
  for (const subj of SUBJECTS) {
    if (subj.id === 'general' || subj.id === 'natural-science') continue;
    let score = 0;
    for (const hint of subj.detectionHints) {
      if (t.includes(hint)) score += hint.length >= 4 ? 2 : 1; // từ khóa dài đặc trưng hơn, trọng số cao hơn
    }
    if (score > 0) scores.push({ id: subj.id, score });
  }
  return scores.sort((a, b) => b.score - a.score);
}

function detectSubject(text) {
  const scores = scoreSubjects(text);
  if (!scores.length) return { id: 'general', confidence: 0 };
  const totalHits = scores.reduce((s, x) => s + x.score, 0);
  const raw = scores[0].score / totalHits;
  const confidence = Math.max(0.5, Math.min(0.98, raw));
  return { id: scores[0].id, confidence: Math.round(confidence * 100) / 100 };
}

// 14.7: nếu môn thứ 2 có điểm đủ mạnh so với môn dẫn đầu (>=45% điểm của môn 1, và bản thân đạt
// tối thiểu 2 điểm — tức khớp ít nhất 1 từ khóa "đặc trưng dài"), coi câu hỏi thuộc CẢ HAI môn —
// vd "Phân tích số liệu dân số và tính tốc độ tăng trưởng" -> Địa lý + Toán. Ngưỡng cố ý đặt cao để
// tránh gán bừa môn phụ chỉ vì trùng 1 từ khóa ngắn/hiếm gặp.
const SECONDARY_MIN_SCORE = 2;
const SECONDARY_MIN_RATIO = 0.45;
function detectSubjects(text) {
  const scores = scoreSubjects(text);
  if (!scores.length) return { primary: { id: 'general', confidence: 0 }, secondary: null };
  const totalHits = scores.reduce((s, x) => s + x.score, 0);
  const toConf = (s) => Math.round(Math.max(0.5, Math.min(0.98, s / totalHits)) * 100) / 100;
  const primary = { id: scores[0].id, confidence: toConf(scores[0].score) };
  let secondary = null;
  if (scores.length > 1 && scores[1].score >= SECONDARY_MIN_SCORE && scores[1].score >= scores[0].score * SECONDARY_MIN_RATIO) {
    secondary = { id: scores[1].id, confidence: toConf(scores[1].score) };
  }
  return { primary, secondary };
}

// Kết quả cuối cùng dùng cho cả prompt lẫn payload trả về client: nếu người dùng CHỌN THỦ CÔNG 1
// môn cụ thể (khác 'auto'/rỗng) thì ưu tiên tuyệt đối (14.3), KHÔNG chạy detectSubject; auto thì mới
// tự nhận diện từ nội dung đề bài (+ gợi ý có ảnh, vì ảnh thường không có text để detect qua keyword).
// 14.7: khi chọn thủ công, KHÔNG suy ra secondary (người dùng đã chỉ định rõ đúng 1 môn muốn dùng —
// tự thêm môn phụ lúc này sẽ đi ngược lựa chọn tường minh của họ); secondary chỉ áp dụng ở chế độ auto.
function resolveSubject({ manualSubjectId, problemText, hasImage }) {
  if (manualSubjectId && manualSubjectId !== 'auto' && SUBJECT_MAP.has(manualSubjectId)) {
    return { subjectId: manualSubjectId, subjectConfidence: 1, subjectSource: 'manual', secondarySubjectId: null, secondarySubjectConfidence: 0 };
  }
  const { primary, secondary } = detectSubjects(problemText);
  // Ảnh không kèm text rõ ràng để detect (OCR do chính model đọc trong lúc giải, không phải ở bước
  // này) — 14.6: vẫn để AI tự nhận diện qua system prompt khi đọc ảnh, badge phía client tạm hiển thị
  // 'general' với confidence thấp cho tới khi có câu trả lời (không đoán bừa — 14.9).
  if (hasImage && primary.id === 'general') {
    return { subjectId: 'general', subjectConfidence: 0, subjectSource: 'auto', secondarySubjectId: null, secondarySubjectConfidence: 0 };
  }
  return {
    subjectId: primary.id, subjectConfidence: primary.confidence, subjectSource: 'auto',
    secondarySubjectId: secondary ? secondary.id : null,
    secondarySubjectConfidence: secondary ? secondary.confidence : 0
  };
}

// ---------- 14.5/14.10/14.14 Subject-aware prompt strategy ----------
// Khối chỉ dẫn NGẮN GỌN chèn vào system prompt hiện có (promptBuilder.js) — KHÔNG thay thế cấu trúc
// "## Tóm tắt đề bài / ## Lời giải / ..." đã có, chỉ NHẤN MẠNH ưu tiên/kiểm tra riêng theo môn và gợi
// ý cột bảng phù hợp (phối hợp với cơ chế bảng ở mục 13). Với 'math', khối này CHỦ Ý ngắn để không
// chồng chéo/mâu thuẫn với phần hướng dẫn Toán chi tiết đã có sẵn trong promptBuilder.js (14.18).
// secondarySubjectId (14.7): khi có, yêu cầu AI áp dụng REASONING KẾT HỢP của cả 2 môn thay vì chỉ 1.
function buildSubjectDirective(subjectId, secondarySubjectId) {
  const subj = getSubject(subjectId);
  const secondary = secondarySubjectId ? getSubject(secondarySubjectId) : null;
  const secondaryLine = secondary
    ? `\n- Câu hỏi này LIÊN QUAN CẢ MÔN PHỤ ${secondary.icon} ${secondary.name} — kết hợp reasoning của cả 2 môn (vd: dùng kiến thức ${secondary.name} để xác định/diễn giải dữ kiện, rồi áp dụng phương pháp ${subj.name} để tính toán/kết luận), KHÔNG bỏ sót khía cạnh nào; nếu tạo bảng, có thể cần thêm cột từ cả 2 phía (vd: ${secondary.tableRule}).`
    : '';
  if (subj.id === 'math') {
    return `\n\nMôn học đã nhận diện: ${subj.icon} ${subj.name}. Giữ nguyên toàn bộ quy tắc trình bày Toán học đã nêu ở trên.${secondaryLine}`;
  }
  return `\n\nMÔN HỌC ĐÃ NHẬN DIỆN: ${subj.icon} ${subj.name}. Điều chỉnh cách giải/trình bày cho ĐÚNG đặc thù môn này:
- Ưu tiên nội dung: ${subj.priorities}
- Gợi ý cột bảng nếu câu trả lời có phần cần so sánh/đối chiếu: ${subj.tableRule}
- Câu hỏi đơn giản (khái niệm/định nghĩa ngắn) -> trả lời NGẮN GỌN, không biến thành bài giảng dài dòng; chỉ trình bày đầy đủ cấu trúc khi bài THỰC SỰ cần giải/phân tích nhiều bước.
- Tự kiểm tra lại câu trả lời theo đúng tiêu chuẩn của môn ${subj.name} trước khi kết luận (vd: đơn vị/công thức nếu là môn tự nhiên; mốc thời gian/sự kiện nếu là Lịch sử; ngữ pháp nếu là Tiếng Anh; không bịa dẫn chứng nếu là Ngữ văn).${secondaryLine}`;
}

module.exports = {
  SUBJECTS, ALLOWED_SUBJECT_IDS, getSubject, detectSubject, detectSubjects, resolveSubject, buildSubjectDirective
};
