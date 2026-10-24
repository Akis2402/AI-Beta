'use strict';
// ---------- Linh vật Akis (rig vector): hình · tư thế · chuyển động · hai tay mitten · thứ tự nạp script ----------
// Thay cho test cũ kiểm tra ảnh raster akisImage.js (đã bỏ khỏi mọi trang). Không cần trình duyệt.
// Chạy: node test/akis-mascot-image.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const pub = path.join(__dirname, '..', 'public');
const read = (p) => fs.readFileSync(path.join(pub, p), 'utf8');

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('  ok  - ' + msg); } else { failed++; console.log('  FAIL - ' + msg); } }

// ---- 1. rig ----
console.log('\n== Rig vector ==');
const ctx = {}; ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(read('js/mascot/akisRig.js'), ctx);
const RIG = ctx.AKIS_RIG;
ok(typeof RIG === 'string' && /^<svg[\s>]/.test(RIG.trim()) && /viewBox=/.test(RIG), 'AKIS_RIG là chuỗi SVG có viewBox');
ok(!/<image[\s>]|data:image\//i.test(RIG), 'rig thuần vector: không nhúng ảnh raster');
const rigIds = new Set((RIG.match(/ id="([^"]+)"/g) || []).map((s) => s.slice(5, -1)));

// ---- 2. engine ----
console.log('\n== Engine chuyển động ==');
const motion = read('js/mascot/akisMotion.js');
const arr = (name) => { const m = motion.match(new RegExp('var ' + name + ' = \\[([\\s\\S]*?)\\];')); return m ? (m[1].match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1)) : []; };
const PARTS = arr('PARTS'), ALL_PROPS = arr('ALL_PROPS');
const loopBlock = motion.slice(motion.indexOf('var LOOPS = {'));
const LOOPS = new Set((loopBlock.match(/^\s{6}'?([a-z0-9-]+)'?:\s*function/gm) || []).map((l) => l.replace(/[\s':]|function/g, '')));
ok(PARTS.length > 5 && PARTS.every((id) => rigIds.has(id)), `mọi PARTS (${PARTS.length}) đều có trong rig`);
ok(ALL_PROPS.length > 10 && ALL_PROPS.every((id) => rigIds.has(id)), `mọi ALL_PROPS (${ALL_PROPS.length}) đều có trong rig`);
ok(LOOPS.size > 10, `đọc được ${LOOPS.size} vòng chuyển động`);

// ---- 3. tư thế ----
console.log('\n== Tư thế ==');
const POSES = require(path.join(pub, 'js/mascot/akisPoses.js'));
const EXPECT = ['idle', 'wave', 'look', 'peek', 'type-email', 'hide-eyes', 'working', 'success', 'error', 'sleepy', 'point-left', 'point-right', 'hold-card', 'spin-3d', 'celebrate'];
ok(EXPECT.every((s) => POSES[s]), `đủ ${EXPECT.length} tư thế mà trang đăng nhập/landing dùng`);
const bad = [];
Object.keys(POSES).forEach((name) => {
  const p = POSES[name];
  (p.props || []).forEach((id) => { if (ALL_PROPS.indexOf(id) < 0) bad.push(`${name}: prop "${id}" không có trong ALL_PROPS`); });
  (p.hide || []).forEach((id) => { if (!rigIds.has(id)) bad.push(`${name}: hide "${id}" không có trong rig`); });
  Object.keys(p.parts || {}).forEach((id) => { if (!rigIds.has(id)) bad.push(`${name}: part "${id}" không có trong rig`); });
  if (p.loop && !LOOPS.has(p.loop)) bad.push(`${name}: loop "${p.loop}" chưa được định nghĩa`);
  (p.cycle || []).forEach((c) => { if (!POSES[c]) bad.push(`${name}: cycle "${c}" không phải tư thế`); });
});
ok(bad.length === 0, bad.length ? bad.join(' | ') : 'mọi tư thế chỉ tham chiếu prop/part/loop/cycle có thật');

// ---- 4. hai tay mitten ----
console.log('\n== Hai tay mitten (hide-eyes) ==');
const he = POSES['hide-eyes'];
ok(he.props.indexOf('hand-left') >= 0 && he.props.indexOf('hand-right') >= 0, 'hide-eyes dùng cả hand-left và hand-right');
ok(!he.parts || !he.parts.book, 'hide-eyes không còn nâng quyển sách che mắt');
ok(he.eyes === 'closed' && he.loop === 'hide', 'mắt nhắm + vòng chuyển động "hide"');
ok(LOOPS.has('hide') && /el\['hand-left'\]/.test(loopBlock) && /el\['hand-right'\]/.test(loopBlock), 'vòng "hide" chuyển động hai tay');
const hands = {};
['left', 'right'].forEach((side) => {
  const m = RIG.match(new RegExp(' id="hand-' + side + '" opacity="0"><g transform=\'translate\\((\\d+) (\\d+)\\)'));
  if (m) hands[side] = { x: +m[1], y: +m[2] };
});
ok(!!hands.left && !!hands.right, 'cả hai tay có trong rig, mặc định ẩn (opacity 0)');
// bbox mắt (đo từ rig): mắt trái x 519–548 · y 519–557; mắt phải x 640–671 · y 492–534. Nửa kích thước thân tay (đã trừ độ nghiêng 10°): 36 × 44.
const EYES = { left: [519, 519, 548, 557], right: [640, 492, 671, 534] };
['left', 'right'].forEach((side) => {
  const h = hands[side], e = EYES[side];
  ok(h && e[0] >= h.x - 36 && e[2] <= h.x + 36 && e[1] >= h.y - 44 && e[3] <= h.y + 44, `tay ${side === 'left' ? 'trái' : 'phải'} che trọn mắt ${side === 'left' ? 'trái' : 'phải'}`);
});
ok(hands.right && hands.left && (hands.right.x - 36) - (hands.left.x + 36) >= 10, 'hai tay không chồng lên nhau');
ok(/id="hand-g"/.test(RIG) && /url\(#hand-g\)/.test(RIG), 'tay dùng gradient riêng hand-g');

// ---- 5. thứ tự nạp script + build ----
console.log('\n== Thứ tự nạp script ở các trang ==');
const build = require('../scripts/build.js');
ok(JSON.stringify(build.MASCOT_JS) === JSON.stringify(['akisRig.js', 'akisPoses.js', 'akisMotion.js', 'mascot.js']), 'build.js dùng đúng danh sách asset mascot (không còn akisImage.js)');
['index.html', 'landing.html', 'auth.html'].forEach((page) => {
  const html = read(page);
  const srcs = (html.match(/<script[^>]+src="([^"]+)"/g) || []).map((s) => s.replace(/.*src="/, '').replace(/"$/, ''));
  const at = (re) => srcs.findIndex((s) => re.test(s));
  const order = [at(/gsap/), at(/mascot\/akisRig/), at(/mascot\/akisPoses/), at(/mascot\/akisMotion/), at(/mascot\/mascot(\.[0-9a-f]{10})?\.js/)];
  ok(order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])), `${page}: gsap -> akisRig -> akisPoses -> akisMotion -> mascot`);
  ok(!/akisImage/.test(html), `${page}: không còn tham chiếu akisImage.js`);
  ok(build.MASCOT_JS.every((n) => build.buildTagRegex('js/mascot', n).test(html)), `${page}: có đủ thẻ cho mọi asset mà build.js bắt buộc`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
