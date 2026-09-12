#!/usr/bin/env node
'use strict';

// ============================================================================================
// visual-corpus-report.js — ĐÓNG rủi ro #2: bộ chuẩn phải LỚN LÊN theo traffic thật
// ============================================================================================
// Bộ chuẩn trong test/visual-decision-corpus.test.js do người viết ra, nên nó chỉ phủ những gì
// người viết NGHĨ RA. Phân phối thật luôn có vùng không ai nghĩ tới — đúng như lần mở rộng vừa rồi
// đã lộ ra 3 lỗ hổng thật (không có tín hiệu tiếng Anh, thiếu biến thể yêu cầu tường minh, và câu
// hỏi "... là gì?" không đứng đầu câu thì lọt veto).
//
// Script này khép vòng phản hồi: đọc log production (logger.js xuất JSON mỗi dòng), lọc ra đúng
// những lượt mà decision engine KHÔNG CHẮC CHẮN, rồi in ra dạng đã sẵn sàng dán vào bộ chuẩn sau
// khi người vận hành gán nhãn.
//
// Dùng:
//   npm run visual-corpus-report -- /var/log/app.jsonl
//   cat logs/*.jsonl | npm run visual-corpus-report
//
// Ưu tiên gán nhãn theo thứ tự script in ra: BORDERLINE trước (đây là vùng engine sai nhiều nhất
// và cũng là vùng duy nhất tốn token cho model judge — TẦNG 3).

const fs = require('fs');

const BORDERLINE_BAND = Number(process.env.VISUAL_BORDERLINE_BAND) || 0.1;
const LOW_CONFIDENCE = Number(process.env.VISUAL_REPORT_LOW_CONFIDENCE) || 0.6;

function readInput() {
  const file = process.argv[2];
  if (file) return fs.readFileSync(file, 'utf8');
  if (!process.stdin.isTTY) return fs.readFileSync(0, 'utf8');
  return '';
}

function parseLines(raw) {
  return raw.split('\n').map((l) => {
    const t = l.trim();
    if (!t || t[0] !== '{') return null;
    try { return JSON.parse(t); } catch (e) { return null; }
  }).filter(Boolean);
}

/** Chỉ giữ dòng telemetry của hệ thống hình. */
function isVisualRecord(r) {
  return r && (r.stage === 'visual_pipeline' || 'visualDecision' in r || 'visualNecessity' in r);
}

function classify(r) {
  const conf = Number(r.visualConfidence);
  if (r.visualError && r.visualError !== 'deferred_deadline') return 'LỖI RENDER';
  if (r.visualJudgeUsed) return 'BORDERLINE (đã phải hỏi model — tốn token)';
  if (Number.isFinite(conf) && conf > 0 && conf < LOW_CONFIDENCE) return 'CONFIDENCE THẤP';
  return null; // engine đã chắc chắn -> không cần gán nhãn thủ công
}

const raw = readInput();
if (!raw.trim()) {
  console.log('Không có dữ liệu log nào trên stdin hoặc đường dẫn file.');
  console.log('Dùng: npm run visual-corpus-report -- /đường/dẫn/app.jsonl');
  process.exit(0);
}

const records = parseLines(raw).filter(isVisualRecord);
if (!records.length) {
  console.log(`Đọc được ${parseLines(raw).length} dòng JSON nhưng không có dòng telemetry hình nào.`);
  console.log('Kiểm tra lại: log phải chứa stage="visual_pipeline" hoặc field visualDecision/visualNecessity.');
  process.exit(0);
}

// ---------- Thống kê tổng quan ----------
const total = records.length;
const drew = records.filter((r) => r.visualDecision === true).length;
const byType = {};
const byNecessity = {};
const byRenderer = {};
records.forEach((r) => {
  if (r.visualType) byType[r.visualType] = (byType[r.visualType] || 0) + 1;
  if (r.visualNecessity) byNecessity[r.visualNecessity] = (byNecessity[r.visualNecessity] || 0) + 1;
  if (r.visualRenderer) byRenderer[r.visualRenderer] = (byRenderer[r.visualRenderer] || 0) + 1;
});

const pct = (n) => `${((n / total) * 100).toFixed(1)}%`;
console.log('== Báo cáo visual decision từ traffic thật ==\n');
console.log(`Tổng lượt có telemetry hình : ${total}`);
console.log(`Quyết định TẠO hình         : ${drew} (${pct(drew)})`);
console.log(`Cache hit                   : ${records.filter((r) => r.visualCacheHit).length}`);
console.log(`Bị bỏ vì deadline           : ${records.filter((r) => r.visualError === 'deferred_deadline').length}`);
console.log(`Bị chặn vì cost gate        : ${records.filter((r) => r.visualError === 'cost_gate_low_benefit').length}`);

const table = (title, obj) => {
  const entries = Object.entries(obj).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return;
  console.log(`\n${title}`);
  entries.forEach(([k, v]) => console.log(`  ${String(k).padEnd(28)} ${String(v).padStart(5)}  ${pct(v)}`));
};
table('Theo visualType:', byType);
table('Theo imageNecessity:', byNecessity);
table('Theo renderer:', byRenderer);

// ---------- Ứng viên bổ sung vào bộ chuẩn ----------
const candidates = records.map((r) => ({ r, why: classify(r) })).filter((x) => x.why);

console.log(`\n== Ứng viên gán nhãn để bổ sung bộ chuẩn: ${candidates.length} lượt ==`);
if (!candidates.length) {
  console.log('Không có lượt nào ở vùng không chắc chắn — bộ chuẩn hiện tại đang phủ tốt traffic này.');
} else {
  console.log('Gán nhãn expect đúng/sai rồi dán vào SHOULD_DRAW_EXTENDED / NHÓM 4 trong');
  console.log('test/visual-decision-corpus.test.js, sau đó chạy lại `node test/visual-decision-corpus.test.js`.\n');
  console.log('LƯU Ý RIÊNG TƯ: log KHÔNG chứa đề bài của người dùng (logger.js cố ý không ghi nội dung).');
  console.log('Phải lấy đề bài từ nguồn đã được phép dùng, không trích ngược từ log production.\n');
  const groups = {};
  candidates.forEach((c) => { (groups[c.why] = groups[c.why] || []).push(c.r); });
  Object.entries(groups).forEach(([why, list]) => {
    console.log(`--- ${why}: ${list.length} lượt ---`);
    list.slice(0, 20).forEach((r) => {
      console.log(`  ['${r.subject || 'general'}', '<ĐỀ BÀI>'],  // type=${r.visualType} `
        + `conf=${r.visualConfidence} necessity=${r.visualNecessity || '-'} renderer=${r.visualRenderer || '-'}`
        + (r.visualError ? ` error=${r.visualError}` : ''));
    });
    if (list.length > 20) console.log(`  … còn ${list.length - 20} lượt nữa`);
  });
}

console.log(`\nNgưỡng đang dùng: borderline band=${BORDERLINE_BAND}, confidence thấp < ${LOW_CONFIDENCE}`);
