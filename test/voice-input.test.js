'use strict';

// ============================================================================================
// PHẦN G mục 27 — TEST VOICE INPUT
// ============================================================================================
// Hai nhóm:
//   (a) STATIC — đọc chính file nguồn/asset thật: #micBtn tồn tại, module được nạp, i18n có key,
//       Permissions-Policy cho phép microphone cho CHÍNH origin này (và chỉ origin này).
//   (b) MOCK   — nạp public/js/voiceInput.js trong một window giả có SpeechRecognition giả, rồi
//       diễn lại đủ vòng đời start/result/end/error/abort. Không cần trình duyệt thật.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  - ${name}`); passed += 1; }
  catch (e) { console.log(` FAIL - ${name}\n        ${e.message}`); failed += 1; }
}

const root = path.join(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
const voiceSrc = fs.readFileSync(path.join(root, 'public', 'js', 'voiceInput.js'), 'utf8');
const cssSrc = fs.readFileSync(path.join(root, 'public', 'css', 'styles.css'), 'utf8');
const securitySrc = fs.readFileSync(path.join(root, 'server', 'middleware', 'security.js'), 'utf8');
const vercelJson = fs.readFileSync(path.join(root, 'vercel.json'), 'utf8');
const buildSrc = fs.readFileSync(path.join(root, 'scripts', 'build.js'), 'utf8');

console.log('\n== (a) STATIC: nút, asset, header ==');

test('V1. #micBtn tồn tại trong composer, cạnh #qInput', () => {
  assert.ok(/id="micBtn"/.test(indexHtml), 'thiếu #micBtn');
  const bar = indexHtml.slice(indexHtml.indexOf('id="chatBar"'), indexHtml.indexOf('id="hint"'));
  assert.ok(/id="micBtn"/.test(bar), '#micBtn phải nằm trong thanh nhập, không phải chỗ khác');
  assert.ok(/id="qInput"/.test(bar) && /id="sendBtn"/.test(bar));
});

test('V2. nút dùng icon SVG, KHÔNG dùng emoji', () => {
  assert.ok(/ICONS\.microphone/.test(appJs), 'phải gán icon microphone từ bộ ICONS SVG');
  assert.ok(/microphone:\s*'<svg/.test(appJs), 'icon microphone phải là SVG');
  const btn = indexHtml.match(/<button id="micBtn"[\s\S]*?<\/button>/);
  assert.ok(btn, 'không tìm thấy thẻ button');
  assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(btn[0]), 'nút microphone chứa emoji');
});

test('V3. nút có aria-label + title đi qua i18n (không hard-code UI text)', () => {
  const btn = indexHtml.match(/<button id="micBtn"[\s\S]*?<\/button>/)[0];
  assert.ok(/data-i18n-aria-label="voice\.micAria"/.test(btn));
  assert.ok(/data-i18n-title="voice\.micTitle"/.test(btn));
  assert.ok(/aria-pressed=/.test(btn), 'trạng thái bật/tắt phải đọc được bằng screen reader');
});

test('V4. voiceInput.js được nạp bằng <script src> và có trong danh sách build', () => {
  assert.ok(/<script src="\/js\/voiceInput\.js"><\/script>/.test(indexHtml), 'thiếu thẻ script');
  // So sánh theo THỨ TỰ THẺ <script> thật, không phải theo lần xuất hiện đầu tiên của chuỗi đường
  // dẫn — index.html có nhiều comment nhắc tới "public/js/app.js" nằm phía trên phần script.
  const scriptSrcs = [...indexHtml.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  const iVoice = scriptSrcs.indexOf('/js/voiceInput.js');
  const iApp = scriptSrcs.indexOf('/js/app.js');
  assert.ok(iVoice >= 0, 'không tìm thấy thẻ script voiceInput.js');
  assert.ok(iApp >= 0, 'không tìm thấy thẻ script app.js');
  assert.ok(iVoice < iApp,
    `voiceInput.js phải nạp TRƯỚC app.js (app.js dùng window.voiceInput ngay khi chạy) — thực tế voice=${iVoice}, app=${iApp}`);
  assert.ok(/'voiceInput\.js'/.test(buildSrc),
    'asset mới phải được fingerprint ở scripts/build.js, nếu không sẽ bị cache sai giữa các deploy');
  assert.ok(fs.existsSync(path.join(root, 'public', 'js', 'voiceInput.js')));
});

test('V5. CSS có ĐỦ 5 trạng thái: idle/recording/processing/error/unsupported', () => {
  assert.ok(/#micBtn\.recording/.test(cssSrc));
  assert.ok(/#micBtn\.processing/.test(cssSrc));
  assert.ok(/#micBtn\.mic-error/.test(cssSrc));
  assert.ok(/#micBtn:disabled/.test(cssSrc), 'unsupported -> nút disabled phải có style riêng');
  assert.ok(/prefers-reduced-motion/.test(cssSrc), 'animation phải tôn trọng prefers-reduced-motion');
});

test('V6. i18n có đủ key voice.* ở CẢ vi và en', () => {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public', 'js', 'i18n', 'translations.js'), 'utf8'), sandbox);
  const T = sandbox.window.TRANSLATIONS;
  const need = [
    'voice.micTitle', 'voice.micAria', 'voice.micStopAria', 'voice.listening', 'voice.processing',
    'voice.stopHint', 'voice.unsupported', 'voice.errNotAllowed', 'voice.errNoSpeech',
    'voice.errAudioCapture', 'voice.errNetwork', 'voice.errGeneric'
  ];
  need.forEach((k) => {
    assert.ok(T.vi[k], `thiếu key vi "${k}"`);
    assert.ok(T.en[k], `thiếu key en "${k}"`);
  });
});

test('V7. Permissions-Policy cho phép microphone cho CHÍNH origin, không mở cho cả internet', () => {
  // Express: đọc đúng đối số thứ hai của res.setHeader('Permissions-Policy', ...).
  const expressPolicy = (securitySrc.match(/setHeader\(\s*'Permissions-Policy'\s*,\s*'([^']+)'/) || [])[1] || '';
  // Vercel: parse JSON thật, không dò regex (regex dễ bắt nhầm khóa "value" của header khác).
  const vercel = JSON.parse(vercelJson);
  const rule = vercel.headers.find((h) => h.source === '/(.*)');
  const vercelPolicy = (rule.headers.find((h) => h.key === 'Permissions-Policy') || {}).value || '';

  [['security.js', expressPolicy], ['vercel.json', vercelPolicy]].forEach(([label, policy]) => {
    assert.ok(policy, `${label}: không đọc được Permissions-Policy`);
    assert.ok(/microphone=\(self\)/.test(policy), `${label}: phải là microphone=(self), thực tế "${policy}"`);
    assert.ok(!/microphone=\(\)/.test(policy), `${label}: microphone=() chặn hoàn toàn cả trang này`);
    assert.ok(!/microphone=\*/.test(policy), `${label}: KHÔNG được mở microphone cho mọi origin`);
    assert.ok(/camera=\(\)/.test(policy), `${label}: camera vẫn phải bị chặn`);
  });
  assert.strictEqual(expressPolicy, vercelPolicy,
    'hai nơi set header phải GIỐNG HỆT, nếu không microphone chạy local nhưng chết trên production');
});

test('V8. CSP KHÔNG bị nới thêm vì voice (xử lý hoàn toàn native, không cần CDN/media mới)', () => {
  const csp = (vercelJson.match(/"Content-Security-Policy"[\s\S]*?"value":\s*"([^"]+)"/) || [])[1] || '';
  assert.ok(csp, 'không đọc được CSP');
  assert.ok(!/media-src/.test(csp), 'voice native không cần media-src');
  assert.ok(!/\*\s*;|'unsafe-eval'/.test(csp), 'không được có wildcard/unsafe-eval');
  assert.ok(/default-src 'self'/.test(csp));
});

console.log('\n== (b) MOCK: vòng đời start / result / end / error / abort ==');

/** Dựng một window giả có SpeechRecognition giả rồi nạp voiceInput.js vào đó. */
function loadVoiceModule() {
  const instances = [];
  function FakeRecognition() {
    this.lang = null;
    this.continuous = null;
    this.interimResults = null;
    this.maxAlternatives = null;
    this.started = false;
    this.stopped = false;
    this.aborted = false;
    instances.push(this);
  }
  FakeRecognition.prototype.start = function () {
    this.started = true;
    if (this.onstart) this.onstart();
  };
  FakeRecognition.prototype.stop = function () {
    this.stopped = true;
  };
  FakeRecognition.prototype.abort = function () {
    this.aborted = true;
  };

  const listeners = {};
  const win = {
    SpeechRecognition: FakeRecognition,
    addEventListener: (ev, fn) => { listeners[ev] = fn; },
    languageStore: { getUILanguage: () => 'vi' }
  };
  const sandbox = { window: win, setTimeout, clearTimeout, Date };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(voiceSrc, sandbox);
  return { voice: win.voiceInput, instances, listeners };
}

/** Giả lập một kết quả nhận dạng của Web Speech API. */
function resultEvent(chunks, resultIndex) {
  const results = chunks.map((c) => {
    const r = [{ transcript: c.text }];
    r.isFinal = !!c.final;
    return r;
  });
  results.length = chunks.length;
  return { resultIndex: resultIndex || 0, results };
}

test('V9. isSupported() true khi có SpeechRecognition, false khi không', () => {
  const { voice } = loadVoiceModule();
  assert.strictEqual(voice.isSupported(), true);
  assert.strictEqual(voice.getState(), 'idle');

  const sandbox = { window: { addEventListener: () => {} }, setTimeout, clearTimeout, Date };
  vm.runInNewContext(voiceSrc, sandbox);
  assert.strictEqual(sandbox.window.voiceInput.isSupported(), false);
  assert.strictEqual(sandbox.window.voiceInput.getState(), 'unsupported',
    'trình duyệt không hỗ trợ -> trạng thái unsupported, KHÔNG throw');
});

test('V10. start -> result -> end: transcript FINAL được trả về đúng một lần', () => {
  const { voice, instances } = loadVoiceModule();
  const got = [];
  const states = [];
  voice.subscribe((s) => states.push(s));
  const ok = voice.start({ onResult: (t) => got.push(t) });
  assert.strictEqual(ok, true);
  assert.strictEqual(voice.getState(), 'recording');

  const rec = instances[0];
  rec.onresult(resultEvent([{ text: 'hai x cộng ba bằng bảy', final: true }]));
  rec.onend();

  assert.deepStrictEqual(got, ['hai x cộng ba bằng bảy']);
  assert.strictEqual(voice.getState(), 'idle');
  assert.ok(states.includes('recording'), 'phải phát trạng thái recording cho UI');
});

test('V11. kết quả INTERIM đi qua onPartial, KHÔNG lọt vào transcript cuối', () => {
  const { voice, instances } = loadVoiceModule();
  const partials = [];
  const finals = [];
  voice.start({ onPartial: (t) => partials.push(t), onResult: (t) => finals.push(t) });
  const rec = instances[0];
  rec.onresult(resultEvent([{ text: 'hai x cộng', final: false }]));
  rec.onresult(resultEvent([{ text: 'hai x cộng ba bằng bảy', final: true }]));
  rec.onend();
  assert.deepStrictEqual(partials, ['hai x cộng']);
  assert.deepStrictEqual(finals, ['hai x cộng ba bằng bảy'], 'interim không được cộng vào kết quả cuối');
});

test('V12. error "not-allowed" -> onError nhận code, state=error, KHÔNG throw', () => {
  const { voice, instances } = loadVoiceModule();
  const errors = [];
  voice.start({ onError: (c) => errors.push(c) });
  instances[0].onerror({ error: 'not-allowed' });
  assert.deepStrictEqual(errors, ['not-allowed']);
  assert.strictEqual(voice.getState(), 'error');
  voice.resetError();
  assert.strictEqual(voice.getState(), 'idle', 'phải quay lại idle được sau khi người dùng đọc lỗi');
});

test('V13. abort() BỎ transcript và nhả microphone', () => {
  const { voice, instances } = loadVoiceModule();
  const finals = [];
  voice.start({ onResult: (t) => finals.push(t) });
  const rec = instances[0];
  rec.onresult(resultEvent([{ text: 'bỏ đi', final: true }]));
  voice.abort();
  assert.strictEqual(rec.aborted, true, 'phải gọi abort() của engine để nhả mic');
  assert.deepStrictEqual(finals, [], 'abort phải BỎ kết quả, không đẩy vào ô nhập');
  assert.strictEqual(voice.getState(), 'idle');
});

test('V14. stop() là dừng LỊCH SỰ: kết quả đang chờ vẫn được trả về', () => {
  const { voice, instances } = loadVoiceModule();
  const finals = [];
  voice.start({ onResult: (t) => finals.push(t) });
  const rec = instances[0];
  rec.onresult(resultEvent([{ text: 'giữ lại', final: true }]));
  voice.stop();
  assert.strictEqual(rec.stopped, true);
  assert.strictEqual(voice.getState(), 'processing');
  rec.onend();
  assert.deepStrictEqual(finals, ['giữ lại']);
});

test('V15. không cho hai phiên nhận dạng chồng nhau', () => {
  const { voice, instances } = loadVoiceModule();
  voice.start({});
  const second = voice.start({});
  assert.strictEqual(second, false, 'bấm mic lần hai khi đang ghi KHÔNG được mở phiên mới');
  assert.strictEqual(instances.length, 1);
});

test('V16. engine throw ngay ở start() -> báo lỗi, KHÔNG Unhandled Rejection', () => {
  const instances = [];
  function Boom() { instances.push(this); }
  Boom.prototype.start = function () { throw new Error('InvalidStateError'); };
  Boom.prototype.stop = function () {};
  Boom.prototype.abort = function () {};
  const sandbox = {
    window: { SpeechRecognition: Boom, addEventListener: () => {} },
    setTimeout, clearTimeout, Date
  };
  vm.runInNewContext(voiceSrc, sandbox);
  const errors = [];
  const ok = sandbox.window.voiceInput.start({ onError: (c) => errors.push(c) });
  assert.strictEqual(ok, false);
  assert.deepStrictEqual(errors, ['start-failed']);
  assert.strictEqual(sandbox.window.voiceInput.getState(), 'error');
});

test('V17. subscriber ném lỗi KHÔNG làm hỏng phiên nhận dạng', () => {
  const { voice, instances } = loadVoiceModule();
  voice.subscribe(() => { throw new Error('UI lỗi'); });
  const finals = [];
  assert.doesNotThrow(() => voice.start({ onResult: (t) => finals.push(t) }));
  instances[0].onresult(resultEvent([{ text: 'vẫn chạy', final: true }]));
  instances[0].onend();
  assert.deepStrictEqual(finals, ['vẫn chạy']);
});

test('V18. ngôn ngữ nhận dạng bám theo setting: Tiếng Việt -> vi-VN, English -> en-US', () => {
  const { voice, instances } = loadVoiceModule();
  assert.strictEqual(voice.resolveRecognitionLang('Tiếng Việt'), 'vi-VN');
  assert.strictEqual(voice.resolveRecognitionLang('English'), 'en-US');
  // 'tự động theo câu hỏi' -> theo ngôn ngữ GIAO DIỆN (languageStore giả trả 'vi').
  assert.strictEqual(voice.resolveRecognitionLang('tự động theo câu hỏi'), 'vi-VN');
  voice.start({ lang: voice.resolveRecognitionLang('Tiếng Việt') });
  assert.strictEqual(instances[0].lang, 'vi-VN');
});

console.log('\n== (c) Wiring trong app.js: transcript -> #qInput, KHÔNG tự gửi ==');

test('V19. transcript đi vào #qInput và KHÔNG xoá nội dung đang gõ (PHẦN 24)', () => {
  assert.ok(/function appendTranscript/.test(appJs), 'phải có hàm ghép transcript tường minh');
  const fn = appJs.slice(appJs.indexOf('function appendTranscript'), appJs.indexOf('function startListening'));
  assert.ok(/el\('qInput'\)/.test(fn), 'phải ghi vào đúng #qInput');
  assert.ok(/if \(!current\) input\.value = text;/.test(fn), 'ô rỗng -> gán thẳng');
  assert.ok(/current \+ ' ' \+ text/.test(fn), 'ô đã có nội dung -> NỐI kèm một khoảng trắng');
  assert.ok(!/input\.value\s*=\s*''/.test(fn), 'KHÔNG được xoá nội dung người dùng đang nhập');
});

test('V20. dispatch sự kiện input để auto-resize/listener hiện có vẫn chạy (PHẦN 19)', () => {
  const fn = appJs.slice(appJs.indexOf('function appendTranscript'), appJs.indexOf('function startListening'));
  assert.ok(/dispatchEvent\(new Event\('input'/.test(fn),
    "phải dispatch 'input' — auto-resize textarea phụ thuộc sự kiện này");
});

/** Cắt ĐÚNG thân IIFE setupVoiceInput bằng cách đếm ngoặc nhọn, không dò chuỗi kết thúc. */
function voiceModuleSource() {
  const start = appJs.indexOf('function setupVoiceInput');
  assert.ok(start >= 0, 'không tìm thấy setupVoiceInput trong app.js');
  const bodyStart = appJs.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < appJs.length; i++) {
    const ch = appJs[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return appJs.slice(start, i + 1);
    }
  }
  throw new Error('không cắt được thân setupVoiceInput');
}

/** Thân module voice ĐÃ BỎ COMMENT — comment là tài liệu, không phải mã thực thi. */
function voiceModuleCode() {
  return voiceModuleSource()
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')
    .replace(/\/\/[^\n'"`]*$/gm, '');
}

test('V21. KHÔNG tự động gửi khi nhận dạng xong (PHẦN 15/25)', () => {
  const scoped = voiceModuleCode();
  assert.ok(!/sendMessage\s*\(/.test(scoped),
    'module voice KHÔNG được gọi sendMessage() — người dùng phải tự bấm "Giải bài"');
  assert.ok(/onResult:/.test(scoped) && /appendTranscript\(finalText\)/.test(scoped));
});

test('V22. Esc dừng ghi âm; trình duyệt không hỗ trợ -> disable nút, không crash', () => {
  const block = voiceModuleSource();
  assert.ok(/e\.key !== 'Escape'/.test(block), 'phải hỗ trợ Esc để dừng');
  assert.ok(/micBtn\.disabled = true/.test(block), 'unsupported -> disable nút');
  assert.ok(/voice\.unsupported/.test(block), 'phải hiện thông báo rõ ràng khi không hỗ trợ');
});

test('V23. voice KHÔNG tạo pipeline AI thứ hai (PHẦN 20): không fetch, không /api', () => {
  // Bỏ COMMENT trước khi quét: file có comment giải thích "không gửi tới /api/chat", đó là tài liệu
  // chứ không phải lời gọi. Chỉ mã thật mới bị tính.
  const code = voiceSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')
    .replace(/\/\/[^\n'"`]*$/gm, '');
  assert.ok(!/fetch\s*\(/.test(code), 'voiceInput.js không được gọi network — speech-to-text chạy tại trình duyệt');
  assert.ok(!/XMLHttpRequest|navigator\.sendBeacon/.test(code), 'không được gửi dữ liệu đi bằng đường khác');
  assert.ok(!/['"`][^'"`]*\/api\//.test(code), 'voiceInput.js không được biết tới endpoint nào');
  assert.ok(!/MediaRecorder|getUserMedia/.test(code),
    'không tự thu audio để gửi đi — dùng Web Speech API native');
  const scoped = voiceModuleCode();
  assert.ok(!/fetch\s*\(/.test(scoped), 'phần wiring voice cũng không được gọi API nào');
});

test('V24. có timeout an toàn — microphone không bao giờ chạy mãi (PHẦN 18)', () => {
  assert.ok(/SAFETY_TIMEOUT_MS/.test(voiceSrc));
  assert.ok(/SILENCE_TIMEOUT_MS/.test(voiceSrc));
  assert.ok(/pagehide/.test(voiceSrc), 'rời trang phải nhả microphone');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
