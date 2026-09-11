'use strict';

// ============================================================================================
// BỘ CHUẨN (labeled corpus) CHO VISUAL DECISION ENGINE — khoá rủi ro "trọng số là heuristic"
// ============================================================================================
// Trọng số heuristic chỉ nguy hiểm khi KHÔNG CÓ CÁCH ĐO. File này là cách đo:
//
//   44 câu hỏi thật, mỗi câu có nhãn đúng (`expect: true/false`) suy ra trực tiếp từ PHẦN 13
//   (nên tạo hình) và PHẦN 14 (không nên tạo hình).
//
// Mọi lần chỉnh trọng số trong visualScoringConfig.js PHẢI chạy lại file này. Ngưỡng chấp nhận:
//   - precision >= 0.90  (hình được tạo phải thực sự đáng tạo — tạo hình vô nghĩa là tốn kém + gây nhiễu)
//   - recall    >= 0.85  (không bỏ sót quá nhiều case hình thực sự giúp ích)
//   - KHÔNG ĐƯỢC SAI câu nào trong nhóm "veto" của PHẦN 14 (đây là ràng buộc CỨNG, không phải tỉ lệ)

const assert = require('assert');
const de = require('../server/utils/visual/visualDecisionEngine');
const cfg = require('../server/utils/visual/visualScoringConfig');

// ---------- NHÓM 1: PHẦN 13 — hình thực sự giúp ích (expect: true) ----------
const SHOULD_DRAW = [
  ['physics', 'Một vật được ném xiên với vận tốc đầu 20 m/s, góc 30°. Tính tầm xa.'],
  ['physics', 'Vật trượt trên mặt phẳng nghiêng góc 30°, hệ số ma sát 0,2. Phân tích các lực tác dụng.'],
  ['physics', 'Cho mạch điện gồm R1 = 4 Ω mắc nối tiếp R2 = 6 Ω, U = 12 V. Tính cường độ dòng điện.'],
  ['physics', 'Tia sáng đi từ không khí vào nước với góc tới 45°, vẽ đường đi của tia khúc xạ.'],
  ['physics', 'Con lắc lò xo dao động điều hòa với biên độ 5 cm, chu kỳ 2 s. Viết phương trình dao động.'],
  ['physics', 'Xác định chiều của lực từ tác dụng lên dây dẫn đặt trong từ trường đều.'],
  ['math', 'Khảo sát và vẽ đồ thị hàm số y = x^3 - 3x + 2.'],
  ['math', 'Cho tam giác ABC vuông tại A, AB = 3 cm, AC = 4 cm. Tính BC và diện tích.'],
  ['math', 'Cho hình chóp S.ABCD có đáy ABCD là hình vuông cạnh a. Tính thể tích khối chóp.'],
  ['math', 'Xác định miền nghiệm của hệ bất phương trình bậc nhất hai ẩn.'],
  ['math', 'Cho đường tròn (O; R) và điểm M nằm ngoài đường tròn, kẻ tiếp tuyến MA, MB.'],
  ['math', 'Trong không gian Oxyz cho hai mặt phẳng, tính góc giữa chúng.'],
  ['math', 'Vẽ đồ thị y = x^2'],
  ['chemistry', 'Viết công thức cấu tạo của các đồng phân ứng với công thức phân tử C4H10.'],
  ['chemistry', 'Trình bày sơ đồ phản ứng điều chế axit sunfuric từ lưu huỳnh.'],
  ['chemistry', 'Mô tả mô hình nguyên tử và cấu hình electron của nguyên tố clo.'],
  ['chemistry', 'Mô tả bộ dụng cụ thí nghiệm chưng cất rượu etylic.'],
  ['biology', 'Trình bày cấu tạo của tế bào nhân thực và chức năng các bào quan.'],
  ['biology', 'Mô tả chu trình quang hợp ở thực vật C3.'],
  ['biology', 'Trình bày cấu tạo và hoạt động của hệ tuần hoàn ở người.'],
  ['geography', 'Trình bày đặc điểm địa hình và lát cắt địa hình vùng núi Tây Bắc.'],
  ['geography', 'Vẽ biểu đồ khí hậu của Hà Nội dựa trên số liệu nhiệt độ và lượng mưa.'],
  ['geography', 'Mô tả chu trình nước trong tự nhiên.'],
  ['computer-science', 'Vẽ lưu đồ thuật toán sắp xếp nổi bọt.'],
  ['computer-science', 'Mô tả kiến trúc hệ thống theo mô hình client - server ba tầng.'],
  ['computer-science', 'Giải thích cấu trúc cây nhị phân tìm kiếm và thao tác chèn nút.']
];

// ---------- NHÓM 2: PHẦN 14 — KHÔNG nên tạo hình (expect: false) ----------
// Các câu đánh dấu `veto: true` là ràng buộc CỨNG: sai 1 câu = fail toàn bộ, không tính theo tỉ lệ.
const SHOULD_NOT_DRAW = [
  ['math', '2 + 3 bằng bao nhiêu?', true],
  ['math', 'Tính 125 * 8', true],
  ['math', '45 % 7 = ?', true],
  ['math', 'Định nghĩa đạo hàm là gì?', true],
  ['math', 'Thế nào là số nguyên tố?', true],
  ['physics', 'Phát biểu định luật II Newton.', true],
  ['english', 'Dịch câu "I go to school" sang tiếng Việt.', true],
  ['literature', 'Phân tích khổ thơ đầu bài thơ Tây Tiến.', true],
  ['english', 'Chia động từ trong ngoặc ở thì hiện tại hoàn thành.', true],
  ['history', 'Trình bày nguyên nhân của Cách mạng tháng Tám năm 1945.', false],
  ['math', 'Giải phương trình bậc hai x^2 - 5x + 6 = 0.', false],
  ['math', 'Tính đạo hàm của hàm số y = sin x + cos x.', false],
  ['math', 'Rút gọn biểu thức căn bậc hai của 50 cộng căn bậc hai của 18.', false],
  ['chemistry', 'Tính khối lượng mol của hợp chất NaCl.', false],
  ['economics-civics', 'Nêu vai trò của pháp luật trong đời sống xã hội.', false],
  ['general', 'Nước sôi ở bao nhiêu độ C?', false],
  ['math', 'Một lớp có 40 học sinh, 60% là nữ. Hỏi có bao nhiêu bạn nam?', false],
  ['physics', 'Đổi 72 km/h sang đơn vị m/s.', false]
];

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, pass: true }); }
  catch (e) { results.push({ name, pass: false, error: e.message }); }
}

function decide(subject, question, pref) {
  return de.evaluateVisualNeed({ question, subject, userPreference: pref || 'auto' });
}

// ---------- Đo precision / recall ----------
let tp = 0, fn_ = 0, fp = 0, tn = 0;
const misses = [];
SHOULD_DRAW.forEach(([subject, q]) => {
  const d = decide(subject, q);
  if (d.shouldGenerateImage) tp++; else { fn_++; misses.push(['MISS (nên vẽ mà không vẽ)', q, d.score]); }
});
SHOULD_NOT_DRAW.forEach(([subject, q]) => {
  const d = decide(subject, q);
  if (d.shouldGenerateImage) { fp++; misses.push(['FALSE POSITIVE (vẽ thừa)', q, d.score]); } else tn++;
});

const precision = tp / Math.max(1, tp + fp);
const recall = tp / Math.max(1, tp + fn_);
const accuracy = (tp + tn) / (SHOULD_DRAW.length + SHOULD_NOT_DRAW.length);

test(`1. precision >= 0.90 (đo được ${precision.toFixed(3)}) — không tạo hình vô nghĩa`, () => {
  assert.ok(precision >= 0.9, `precision=${precision.toFixed(3)}; các case sai:\n` + misses.map((m) => '   ' + m.join(' | ')).join('\n'));
});

test(`2. recall >= 0.85 (đo được ${recall.toFixed(3)}) — không bỏ sót case hình thực sự giúp ích`, () => {
  assert.ok(recall >= 0.85, `recall=${recall.toFixed(3)}; các case sai:\n` + misses.map((m) => '   ' + m.join(' | ')).join('\n'));
});

test(`3. accuracy tổng >= 0.90 (đo được ${accuracy.toFixed(3)})`, () => {
  assert.ok(accuracy >= 0.9, `accuracy=${accuracy.toFixed(3)}`);
});

// ---------- Ràng buộc CỨNG: nhóm veto PHẦN 14 không được sai câu nào ----------
test('4. PHẦN 14 (veto tuyệt đối): KHÔNG SAI câu nào — ở cả 3 chế độ auto/always/never', () => {
  const vetoCases = SHOULD_NOT_DRAW.filter((c) => c[2]);
  ['auto', 'always', 'never'].forEach((pref) => {
    vetoCases.forEach(([subject, q]) => {
      const d = decide(subject, q, pref);
      assert.strictEqual(d.shouldGenerateImage, false, `[${pref}] không được vẽ: "${q}"`);
    });
  });
});

test('5. setting "never" chặn TOÀN BỘ bộ chuẩn, không ngoại lệ', () => {
  SHOULD_DRAW.concat(SHOULD_NOT_DRAW.map((c) => [c[0], c[1]])).forEach(([subject, q]) => {
    assert.strictEqual(decide(subject, q, 'never').shouldGenerateImage, false, q);
  });
});

test('6. setting "always" KHÔNG làm giảm recall (chỉ hạ ngưỡng, không đảo chiều)', () => {
  SHOULD_DRAW.forEach(([subject, q]) => {
    const auto = decide(subject, q, 'auto');
    const always = decide(subject, q, 'always');
    if (auto.shouldGenerateImage) {
      assert.strictEqual(always.shouldGenerateImage, true, `"always" phải bao trùm "auto": ${q}`);
    }
  });
});

test('7. visualType suy ra đúng nhóm renderer cho từng môn', () => {
  const expectType = {
    'Khảo sát và vẽ đồ thị hàm số y = x^3 - 3x + 2.': 'mathematical_plot',
    'Cho tam giác ABC vuông tại A, AB = 3 cm, AC = 4 cm. Tính BC và diện tích.': 'geometry_diagram',
    'Cho mạch điện gồm R1 = 4 Ω mắc nối tiếp R2 = 6 Ω, U = 12 V. Tính cường độ dòng điện.': 'circuit_diagram',
    'Vẽ lưu đồ thuật toán sắp xếp nổi bọt.': 'flowchart'
  };
  Object.entries(expectType).forEach(([q, type]) => {
    const row = SHOULD_DRAW.find((r) => r[1] === q);
    const d = decide(row[0], q);
    assert.strictEqual(d.visualType, type, `"${q}" -> mong đợi ${type}, nhận ${d.visualType}`);
  });
});

// ---------- Khả năng tinh chỉnh bằng ENV (không cần deploy lại code) ----------
test('8. VISUAL_SIGNAL_WEIGHTS override được trọng số, và bị kẹp trong khoảng hợp lệ', () => {
  const applied = cfg.applyEnvWeightOverrides('math.geometry=0.9,math.plot=-5,khong-ton-tai=0.5');
  assert.strictEqual(applied.length, 1, 'chỉ id hợp lệ + giá trị trong (0,1] mới được áp dụng');
  assert.strictEqual(applied[0].id, 'math.geometry');
  cfg.applyEnvWeightOverrides('math.geometry=0.52'); // trả về giá trị mặc định cho các test sau
});

test('9. Ngưỡng đọc được từ ENV (tinh chỉnh production không cần sửa code)', () => {
  assert.ok(cfg.THRESHOLD.auto > cfg.THRESHOLD.always, '"always" phải dễ vẽ hơn "auto"');
  assert.strictEqual(cfg.THRESHOLD.never, Infinity);
});

let passed = 0, failed = 0;
console.log('\n== Bộ chuẩn visual decision (44 câu có nhãn) ==');
console.log(`   precision=${precision.toFixed(3)}  recall=${recall.toFixed(3)}  accuracy=${accuracy.toFixed(3)}`
  + `  (TP=${tp} FP=${fp} FN=${fn_} TN=${tn})`);
if (misses.length) {
  console.log('   Các case chưa khớp nhãn:');
  misses.forEach((m) => console.log('     - ' + m[0] + ' :: ' + m[1] + ' (score=' + m[2] + ')'));
}
results.forEach((r) => {
  if (r.pass) { passed++; console.log('  ok  - ' + r.name); }
  else { failed++; console.log(' FAIL - ' + r.name + '\n        ' + r.error); }
});
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
