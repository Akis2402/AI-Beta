'use strict';

// P6 — Cảnh báo KaTeX "Unrecognized Unicode character 'ặ'" / "No character metrics for 'ặ'".
// NGUYÊN NHÂN (đã tái hiện bằng KaTeX vendor thật): KHÔNG phải do delimiter `$` đơn. Chữ Việt có dấu xếp chồng
// (ặ ủ ừ ợ...) nằm trong \text{} hoặc chế độ math (thư viện công thức: \text{hoặc}, V_{\text{chóp}}, W_đ...) làm
// KaTeX phàn nàn vì bộ font không có metrics cho chúng. Công thức vẫn dựng được — chỉ spam console.
// FIX ở renderMath(): strict là hàm katexStrict + lọc console.warn đồng bộ withKatexViWarningsFiltered.
// Test này nạp ĐÚNG mã từ public/js/app.js (không copy logic) và KaTeX từ public/vendor/katex.
// Chạy: node test/katex-vi-warnings.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  -', name); }
  catch (e) { failed++; console.log(' FAIL -', name, '\n       ', e.message); }
}

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const block = app.match(/const KATEX_VI_IGNORED_CODES[\s\S]*?\nfunction renderMath\(/);
const seen = [];
const ctx = { window: {}, console: { warn: (...a) => seen.push(String(a[0])), log() {}, error() {} } };
ctx.self = ctx.window;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'public/vendor/katex/katex.min.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'public/js/formulas.js'), 'utf8'), ctx);

test('app.js chứa katexStrict + withKatexViWarningsFiltered và renderMath dùng cả hai', () => {
  assert.ok(block, 'không tìm thấy khối helper KaTeX trong app.js');
  const rm = app.slice(app.indexOf('function renderMath('), app.indexOf('function renderMath(') + 900);
  assert.ok(/strict:\s*katexStrict/.test(rm), 'renderMath phải truyền strict: katexStrict');
  assert.ok(/withKatexViWarningsFiltered\(/.test(rm), 'renderMath phải bọc renderMathInElement bằng withKatexViWarningsFiltered');
});

vm.runInContext(block[0].replace(/\nfunction renderMath\($/, '\n') + ';this.katexStrict=katexStrict;this.wrap=withKatexViWarningsFiltered;', ctx);
const katex = ctx.window.katex;
const render = (tex, filtered) => {
  seen.length = 0;
  const run = () => katex.renderToString(tex, { displayMode: true, throwOnError: false, strict: filtered ? ctx.katexStrict : 'warn' });
  if (filtered) ctx.wrap(run); else run();
  return seen.slice();
};

test('đối chứng: KHÔNG có bản sửa, \\text{hoặc} phát cảnh báo (tái hiện lỗi gốc)', () => {
  assert.ok(render('\\text{hoặc}', false).length > 0, 'KaTeX vendor không còn cảnh báo — giả định của test đã đổi');
});

test('có bản sửa: \\text{hoặc}, V_{\\text{chóp}}, W_đ không còn cảnh báo', () => {
  ['\\text{hoặc}', 'V_{\\text{chóp}}', 'W_đ=mgh', '\\text{Độ rượu}'].forEach((t) => {
    assert.deepStrictEqual(render(t, true), [], `còn cảnh báo với ${t}`);
  });
});

test('toàn bộ thư viện công thức render sạch cảnh báo', () => {
  const lib = ctx.window.FORMULA_LIBRARY;
  let total = 0; const dirty = [];
  Object.keys(lib).forEach((s) => Object.keys(lib[s]).forEach((g) => lib[s][g].forEach((it) => {
    total++;
    if (render(it.formula, true).length) dirty.push(`${s}/${g}: ${it.name}`);
  })));
  assert.ok(total > 50, `chỉ có ${total} công thức — thư viện nạp sai?`);
  assert.deepStrictEqual(dirty, []);
});

test('KHÔNG nuốt nhầm: chữ Hy Lạp lạ / console.warn khác / strict khác vẫn được báo', () => {
  seen.length = 0;
  ctx.wrap(() => ctx.console.warn("No character metrics for 'Ω' in style 'Main-Regular' and mode 'text'"));
  assert.strictEqual(seen.length, 1, 'ký tự ngoài dải Việt phải vẫn được báo');
  seen.length = 0;
  ctx.wrap(() => ctx.console.warn('cảnh báo khác'));
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(ctx.katexStrict('htmlExtension', 'x'), 'warn');
  assert.strictEqual(ctx.katexStrict('unknownSymbol', 'Unrecognized Unicode character "Ω"'), 'warn');
  assert.strictEqual(ctx.katexStrict('unknownSymbol', 'Unrecognized Unicode character "ặ"'), 'ignore');
});

test('console.warn luôn được khôi phục, kể cả khi hàm bên trong ném lỗi', () => {
  const before = ctx.console.warn;
  assert.throws(() => ctx.wrap(() => { throw new Error('x'); }));
  assert.strictEqual(ctx.console.warn, before);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
