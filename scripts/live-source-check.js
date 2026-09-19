#!/usr/bin/env node
'use strict';

/* ============================================================================================
 * scripts/live-source-check.js — kiểm chứng ĐƯỜNG ĐỌC NGUỒN với model THẬT
 * ============================================================================================
 * Unit test dựng pdf.js giả và API vision giả, nên nó chứng minh được LOGIC đúng nhưng KHÔNG chứng
 * minh được model thật đọc nổi một trang scan thật. Đó là hai câu hỏi khác nhau, và chỉ script này
 * trả lời được câu thứ hai.
 *
 * Cách dùng:
 *   1. Chạy server:  npm start
 *   2. Chuẩn bị ảnh trang scan (PNG/JPEG). Nhiều ảnh = nhiều trang.
 *   3. node scripts/live-source-check.js trang1.jpg trang2.jpg
 *
 * Biến môi trường:
 *   BASE_URL   (mặc định http://localhost:3000)
 *   MIN_CHARS  (mặc định 40) — số ký tự tối thiểu coi là "đọc được trang này"
 *
 * Script TỐN TIỀN API thật (mỗi trang là 1 lượt gọi vision) nên không nằm trong `npm test`.
 * Nó cố tình KHÔNG tự tạo dữ liệu giả: không có ảnh đầu vào thì báo lỗi và dừng, vì một kết quả
 * "pass" dựng trên ảnh tự sinh cũng vô nghĩa như mock.
 */

const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const MIN_CHARS = Number(process.env.MIN_CHARS) || 40;

const MEDIA_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif'
};

function usage(msg) {
  if (msg) console.error('\n' + msg);
  console.error(`
Cách dùng: node scripts/live-source-check.js <ảnh-trang-1> [ảnh-trang-2 ...]

  Gửi từng ảnh trang tới /api/source/vision-extract của server đang chạy và kiểm tra:
    - mỗi trang trả về ok:true
    - extractedText đủ dài (>= ${MIN_CHARS} ký tự) để thật sự dùng được làm evidence
    - confidence được model khai báo
    - số trang trả về khớp số trang gửi đi (đây là điều kiện verify ở client)
`);
  process.exit(2);
}

async function main() {
  const files = process.argv.slice(2);
  if (!files.length) usage('Thiếu ảnh đầu vào.');

  const pages = files.map((f, i) => {
    if (!fs.existsSync(f)) usage(`Không tìm thấy file: ${f}`);
    const ext = path.extname(f).toLowerCase();
    const mediaType = MEDIA_BY_EXT[ext];
    if (!mediaType) usage(`Định dạng không hỗ trợ: ${ext} (chỉ PNG/JPEG/WEBP/GIF)`);
    return { page: i + 1, mediaType, base64: fs.readFileSync(f).toString('base64') };
  });

  console.log(`\nGửi ${pages.length} trang tới ${BASE_URL}/api/source/vision-extract …`);
  const started = Date.now();

  let res;
  try {
    res = await fetch(`${BASE_URL}/api/source/vision-extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pages })
    });
  } catch (e) {
    console.error(`\nKhông kết nối được ${BASE_URL} — server đã chạy chưa? (npm start)`);
    console.error(String(e.message || e));
    process.exit(1);
  }

  if (!res.ok) {
    console.error(`\nHTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
    process.exit(1);
  }

  const data = await res.json();
  const results = Array.isArray(data.results) ? data.results : [];
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  let failures = 0;
  console.log(`\nNhận kết quả sau ${elapsed}s:\n`);
  pages.forEach((p) => {
    const r = results.find((x) => Number(x.page) === p.page);
    if (!r) { failures++; console.log(`  ✗ trang ${p.page}: KHÔNG có kết quả trả về`); return; }
    if (!r.ok) { failures++; console.log(`  ✗ trang ${p.page}: ok=false (${r.reason || 'không rõ'})`); return; }
    const text = String(r.extractedText || '');
    const len = text.trim().length;
    const conf = r.confidence != null ? r.confidence : '?';
    if (len < MIN_CHARS) {
      failures++;
      console.log(`  ✗ trang ${p.page}: chỉ đọc được ${len} ký tự (< ${MIN_CHARS}), confidence=${conf}`);
      console.log(`      trích: ${JSON.stringify(text.slice(0, 120))}`);
      return;
    }
    console.log(`  ✓ trang ${p.page}: ${len} ký tự, confidence=${conf}, công thức=${(r.equations || []).length}, hình=${(r.diagrams || []).length}`);
    console.log(`      trích: ${JSON.stringify(text.slice(0, 120))}…`);
  });

  console.log(`\n${pages.length - failures}/${pages.length} trang đọc được.`);
  if (failures) {
    console.log('KẾT QUẢ: FAIL — với đúng bộ ảnh này, client sẽ đánh source là INCOMPLETE (đúng như thiết kế).');
    process.exit(1);
  }
  console.log('KẾT QUẢ: PASS — đủ điều kiện để client verify và chuyển source sang READY.');
}

main().catch((e) => { console.error(e); process.exit(1); });
