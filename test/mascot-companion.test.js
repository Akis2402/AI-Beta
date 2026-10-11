'use strict';
// ---------- Akis đồng hành trong app (mascotCompanion.js): hiện đúng lúc, tour lần đầu, nhớ trạng thái, không gọi mạng ----------
require('./_depGuard').requireDeps(['jsdom'], 'mascot-companion.test.js');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ok  - ' + msg); } else { failed++; console.log('  FAIL - ' + msg); }
}
const pub = path.join(__dirname, '..', 'public');
const read = (p) => fs.readFileSync(path.join(pub, p), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sb = { window: {} };
require('vm').runInNewContext(read('js/i18n/translations.js'), sb);
const TR = sb.window.TRANSLATIONS;

function load(status, store) {
  const dom = new JSDOM(`<!doctype html><body>
    <button id="addSourceBtn">+</button><textarea id="qInput"></textarea><button id="subjectBtn">m</button>
    <button id="flashcardTopBtn">f</button><button id="sendBtn">go</button><div id="thread"></div></body>`,
  { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const calls = [];
  w.fetch = (...a) => { calls.push(a); return Promise.reject(new Error('mạng bị cấm trong test')); };
  w.XMLHttpRequest = function () { calls.push(['xhr']); };
  w.Element.prototype.getClientRects = function () { return [{}]; };
  Object.keys(store || {}).forEach((k) => w.localStorage.setItem(k, store[k]));
  w.TRANSLATIONS = TR;
  w.t = (k, vars) => { let s = (TR.vi[k] || k); Object.keys(vars || {}).forEach((x) => { s = s.replace('{{' + x + '}}', vars[x]); }); return s; };
  w.languageStore = { subscribe() {}, getUILanguage: () => 'vi' };
  w.TGAuth = { getState: () => ({ status }) };
  w.eval(read('js/mascot/akisImage.js'));
  w.eval(read('js/mascot/mascot.js'));
  w.eval(read('js/ui/mascotCompanion.js'));
  return { w, d: w.document, calls };
}

(async () => {
  console.log('\n== chưa đăng nhập: Akis không xuất hiện trong app ==');
  let s = load('unauthenticated');
  await sleep(500);
  ok(!s.d.getElementById('tgAkis'), 'status=unauthenticated -> không dựng widget, không tour');

  console.log('\n== đã đăng nhập, lần đầu: widget + tour ==');
  s = load('authenticated');
  const host = s.d.getElementById('tgAkis');
  ok(!!host, 'status=authenticated -> dựng #tgAkis');
  const btn = host.querySelector('button.tg-akis-btn');
  ok(btn && btn.getAttribute('aria-label') === TR.vi['ak.hide'] && btn.getAttribute('aria-expanded') === 'true', 'nút Akis có aria-label + aria-expanded');
  ok(btn.querySelector('img.ak-img') && btn.querySelector('img').getAttribute('src') === s.w.AKIS_IMG, 'widget dùng đúng ảnh Akis gốc');
  await sleep(1100);
  const dlg = host.querySelector('.tg-akis-tour');
  ok(dlg && dlg.getAttribute('role') === 'dialog' && !!dlg.getAttribute('aria-label'), 'tour mở sau ~1 giây, role=dialog + aria-label');
  ok(dlg.querySelector('.tg-tour-t').textContent === TR.vi['ak.t1'] && dlg.querySelector('.tg-tour-n').textContent === 'Bước 1/4', 'bước 1/4 hiện đúng nội dung (có thay {{n}}/{{total}})');
  ok(s.d.getElementById('addSourceBtn').classList.contains('tg-akis-hl'), 'bước 1 tô sáng #addSourceBtn');
  ok(s.d.activeElement && s.d.activeElement.getAttribute('data-a') === 'next', 'focus chuyển vào nút "Tiếp"');
  ok(dlg.querySelector('[data-a="prev"]').hidden === true, 'bước đầu ẩn nút "Quay lại"');
  const next = () => host.querySelector('[data-a="next"]').click();
  next();
  ok(host.querySelector('.tg-tour-n').textContent === 'Bước 2/4' && s.d.getElementById('qInput').classList.contains('tg-akis-hl') && !s.d.getElementById('addSourceBtn').classList.contains('tg-akis-hl'), 'Tiếp -> bước 2, tô sáng #qInput, gỡ tô sáng bước cũ');
  host.querySelector('[data-a="prev"]').click();
  ok(host.querySelector('.tg-tour-n').textContent === 'Bước 1/4', 'Quay lại -> bước 1');
  next(); next(); next();
  ok(host.querySelector('[data-a="next"]').textContent === TR.vi['ak.done'], 'bước cuối đổi nút thành "Xong rồi"');
  next();
  ok(!host.querySelector('.tg-akis-tour') && s.w.localStorage.getItem('tg.akis.tour.v1') === '1', 'kết thúc: đóng tour + nhớ đã xem (localStorage)');
  ok(!s.d.querySelector('.tg-akis-hl'), 'không còn phần tử nào bị tô sáng');
  ok(s.calls.length === 0, 'companion KHÔNG gọi fetch/XHR nào (0 request, 0 token AI)');

  console.log('\n== Esc đóng tour; lần sau không hiện lại ==');
  s = load('authenticated');
  await sleep(1100);
  s.d.dispatchEvent(new s.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  ok(!s.d.querySelector('.tg-akis-tour') && s.w.localStorage.getItem('tg.akis.tour.v1') === '1', 'Esc đóng tour và đánh dấu đã xem');
  s = load('authenticated', { 'tg.akis.tour.v1': '1' });
  await sleep(1100);
  ok(s.d.getElementById('tgAkis') && !s.d.querySelector('.tg-akis-tour'), 'đã xem tour -> widget có, tour không tự mở lại');

  console.log('\n== thu nhỏ / mở lại + nhớ ==');
  const host2 = s.d.getElementById('tgAkis');
  const b2 = host2.querySelector('button.tg-akis-btn');
  b2.click();
  ok(host2.classList.contains('is-min') && s.w.localStorage.getItem('tg.akis.min') === '1' && b2.getAttribute('aria-expanded') === 'false' && b2.getAttribute('aria-label') === TR.vi['ak.show'], 'bấm -> thu nhỏ, lưu lại, cập nhật aria');
  b2.click();
  ok(!host2.classList.contains('is-min') && s.w.localStorage.getItem('tg.akis.min') === '0', 'bấm lại -> mở ra');
  s = load('disabled', { 'tg.akis.tour.v1': '1', 'tg.akis.min': '1' });
  ok(s.d.getElementById('tgAkis').classList.contains('is-min'), 'tải lại nhớ trạng thái thu nhỏ; status=disabled (server tắt bắt buộc đăng nhập) vẫn dựng widget');

  console.log('\n== phản ứng khi học ==');
  s = load('authenticated', { 'tg.akis.tour.v1': '1' });
  const svg = () => s.d.querySelector('#tgAkis .ak').getAttribute('data-state');
  s.d.getElementById('sendBtn').click();
  ok(svg() === 'idle', 'gửi khi ô nhập trống -> không làm gì');
  s.d.getElementById('qInput').value = '2x+1=5';
  s.d.getElementById('sendBtn').click();
  ok(svg() === 'working', 'gửi câu hỏi -> Akis "working"');
  ok(s.d.querySelector('#tgAkis .ak-bubble').textContent === TR.vi['ak.say.working'], 'bong bóng nói "đang suy nghĩ"');
  s.d.getElementById('thread').appendChild(s.d.createElement('div'));
  await sleep(2000);
  ok(svg() === 'success' && s.d.querySelector('#tgAkis .ak-bubble').textContent === TR.vi['ak.say.done'], 'có nội dung mới trong #thread -> "success" + "Xong rồi"');
  ok(s.calls.length === 0, 'vẫn 0 request mạng');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
