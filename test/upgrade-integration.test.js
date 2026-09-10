'use strict';

/* =====================================================================================
   upgrade-integration.test.js — kiểm chứng các hạng mục mới thêm ở lần nâng cấp này:
     PHẦN A-C   Puter adapter + provider router (tồn tại, đúng interface, CSP đã mở đúng host)
     PHẦN E-I   conversationTaskManager (không còn cờ isGenerating toàn cục, per-conversation state)
     PHẦN J-N   scene3d: compact scene JSON + patch + validator + schema trong prompt
     PHẦN T-Z   i18n: languageStore/i18n/translations, mọi khoá vi<->en khớp nhau
     PHẦN AA-AB Language contract nén + static language rule nằm trong phần prompt được cache
     PHẦN AF-AG Error code -> khoá dịch (backend không quyết định câu chữ hiển thị)
     PHẦN AJ-AN Language lock: settings được SAO CHÉP tại thời điểm request, không đọc lại state sống
     PHẦN AO    i18n không làm phình token: không gửi từ điển dịch cho model

   Đây là test TĨNH (đọc mã nguồn thật + gọi trực tiếp hàm server) — không mock, không giả định
   hành vi trình duyệt. Các hạng mục cần DOM/WebGL thật (render Three.js, orbit, fullscreen) không
   thể xác minh ở môi trường Node và được nêu rõ trong báo cáo là chưa test tự động.
   ===================================================================================== */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  -', name); }
  catch (e) { failed++; console.log(' FAIL -', name, '\n       ', e.message); }
}

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const appJs = read('public/js/app.js');
const indexHtml = read('public/index.html');
const translationsJs = read('public/js/i18n/translations.js');
const i18nJs = read('public/js/i18n/i18n.js');
const languageStoreJs = read('public/js/i18n/languageStore.js');
const scene3dJs = read('public/js/scene3d.js');
const puterJs = read('public/js/providers/puterAdapter.js');
const routerJs = read('public/js/providers/providerRouter.js');
const ctmJs = read('public/js/tasks/conversationTaskManager.js');
const promptBuilderJs = read('server/utils/promptBuilder.js');
const securityJs = read('server/middleware/security.js');
const vercelJson = read('vercel.json');

/* ---------------- PHẦN A-C: Puter + provider router ---------------- */
console.log('\n== PHẦN A-C: Puter adapter + provider router ==');

test('puterAdapter dùng SDK chính thức js.puter.com/v2 và KHÔNG hard-code API key', () => {
  assert.ok(puterJs.includes('https://js.puter.com/v2/'), 'phải dùng đúng URL SDK chính thức');
  assert.ok(!/api[_-]?key\s*[:=]\s*['"][A-Za-z0-9_\-]{8,}/i.test(puterJs), 'không được hard-code khoá API');
});

test('puterAdapter chuẩn hoá lỗi về error.* code (PHẦN AF) thay vì message thô', () => {
  assert.ok(puterJs.includes("'error.rateLimit'") && puterJs.includes("'error.timeout'"));
  assert.ok(puterJs.includes('normalizePuterError'));
});

test('providerRouter thử provider hiện có TRƯỚC, Puter chỉ là fallback (không thay thế mù quáng)', () => {
  const serverCallIdx = routerJs.indexOf('window.apiPostStream');
  const puterCallIdx = routerJs.indexOf('puterAdapter.streamPuter');
  assert.ok(serverCallIdx > -1 && puterCallIdx > -1);
  assert.ok(serverCallIdx < puterCallIdx, 'apiPostStream (provider hiện có) phải được gọi trước Puter');
});

test('providerRouter KHÔNG fallback khi người dùng bấm Dừng (abort không phải lỗi provider)', () => {
  assert.ok(/cancelled|AbortError/.test(routerJs));
  assert.ok(routerJs.includes('throw err'), 'abort phải được ném lại, không đi tiếp sang Puter');
});

test('providerRouter giới hạn fallback, KHÔNG retry vô hạn (PHẦN B)', () => {
  assert.ok(!/while\s*\(\s*true\s*\)/.test(routerJs), 'không được có vòng lặp retry vô hạn');
  assert.ok(routerJs.includes('allowPuterFallback'), 'phải có cờ chặn fallback lặp lại');
});

test('CSP cho phép đúng host Puter, KHÔNG bật unsafe-inline/unsafe-eval (PHẦN AX)', () => {
  assert.ok(securityJs.includes('https://js.puter.com'), 'helmet scriptSrc phải có js.puter.com');
  assert.ok(securityJs.includes('https://api.puter.com'), 'helmet connectSrc phải có api.puter.com');
  assert.ok(vercelJson.includes('https://js.puter.com'), 'vercel.json CSP phải khớp helmet');
  const scriptSrc = (securityJs.match(/scriptSrc:\s*\[([^\]]*)\]/) || [])[1] || '';
  assert.ok(!scriptSrc.includes('unsafe-inline'), "scriptSrc không được có 'unsafe-inline'");
  // Kiểm tra trên DIRECTIVE THẬT, không phải cả file — chú thích trong security.js có nhắc chữ
  // "unsafe-eval" dưới dạng văn bản giải thích (khẳng định KHÔNG dùng), nếu grep cả file sẽ dương
  // tính giả. Cùng lý do đó, CSP trong vercel.json được kiểm bằng chính chuỗi directive.
  const securityDirectives = securityJs
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(!securityDirectives.includes('unsafe-eval'), "directive không được có 'unsafe-eval'");
  const vercelCsp = (vercelJson.match(/"Content-Security-Policy"[^}]*"value":\s*"([^"]*)"/) || [])[1] || '';
  assert.ok(!vercelCsp.includes('unsafe-eval'), "vercel.json CSP không được có 'unsafe-eval'");
  assert.ok(!/script-src[^;]*unsafe-inline/.test(vercelCsp), "vercel.json script-src không được có 'unsafe-inline'");
});

/* ---------------- PHẦN D-I: task manager / abort / isolation ---------------- */
console.log('\n== PHẦN D-I: multi-conversation background execution ==');

test('KHÔNG còn AbortController toàn cục "chatAbortController" trong app.js (PHẦN F)', () => {
  const codeLines = appJs.split('\n').filter((l) => !l.trim().startsWith('//'));
  const live = codeLines.join('\n');
  assert.ok(!/\bchatAbortController\b/.test(live), 'biến toàn cục cũ phải bị loại bỏ hoàn toàn');
});

test('KHÔNG dùng cờ isGenerating toàn cục để khoá cả app (PHẦN F)', () => {
  assert.ok(!/^\s*(let|var|const)\s+isGenerating\b/m.test(appJs), 'không được khai báo isGenerating toàn cục');
  assert.ok(ctmJs.includes('function isGenerating(conversationId)'), 'trạng thái generating phải tra theo conversationId');
});

test('task object có đủ field yêu cầu ở PHẦN E', () => {
  ['conversationId', 'requestId', 'status', 'provider', 'model', 'text', 'partial',
    'startedAt', 'updatedAt', 'completedAt', 'error', 'usage'].forEach((f) => {
    assert.ok(ctmJs.includes(f), `thiếu field "${f}" trong task state`);
  });
});

test('mọi event đều mang conversationId + requestId (PHẦN G — response isolation)', () => {
  assert.ok(ctmJs.includes('notify(t.conversationId'), 'event phải phát theo conversationId');
  assert.ok(/requestId/.test(ctmJs));
  assert.ok(ctmJs.includes('byConversation'), 'phải map conversationId -> requestId đang active');
});

test('có concurrency limit + queue khi vượt giới hạn (PHẦN F)', () => {
  assert.ok(ctmJs.includes('CTM_MAX_CONCURRENT'));
  assert.ok(ctmJs.includes('queue.push'), 'task vượt giới hạn phải vào queue');
  assert.ok(ctmJs.includes('runNextQueued'), 'phải có cơ chế chạy task kế tiếp khi có slot trống');
});

test('Stop chỉ abort task của ĐÚNG conversation đang xem (PHẦN D)', () => {
  assert.ok(ctmJs.includes('function abortActiveTask(conversationId)'));
  assert.ok(appJs.includes('abortActiveTask(conv.id)'), 'nút Dừng phải truyền conv.id cụ thể');
});

test('chuyển chat KHÔNG abort: loadConversation không gọi abort ở bất kỳ đâu (NGUYÊN TẮC #2)', () => {
  const start = appJs.indexOf('async function loadConversation');
  const end = appJs.indexOf('function deleteConversation');
  assert.ok(start > -1 && end > start);
  const body = appJs.slice(start, end);
  assert.ok(!/abort/i.test(body), 'loadConversation() tuyệt đối không được abort task nào');
});

test('UI attach/detach tách rời khỏi vòng đời task (PHẦN E)', () => {
  assert.ok(ctmJs.includes('function attach(conversationId, cb)'));
  assert.ok(appJs.includes('conversationTaskManager.attach('), 'UI phải attach khi mở lại conversation');
});

test('PHẦN I: có cơ chế đồng bộ multi-tab (BroadcastChannel + ownership token)', () => {
  assert.ok(ctmJs.includes('BroadcastChannel'));
  assert.ok(ctmJs.includes('OWNER_TOKEN'), 'phải có ownership token phân biệt tab');
});

test('PHẦN AZ: task hoàn thành được dọn khỏi registry active (không giữ buffer vô hạn)', () => {
  assert.ok(ctmJs.includes('tasks.delete('), 'phải xoá task khỏi registry sau khi hoàn tất');
  assert.ok(ctmJs.includes('runningCount = Math.max(0, runningCount - 1)'), 'phải giải phóng slot concurrency');
});

/* ---------------- PHẦN J-N: 3D ---------------- */
console.log('\n== PHẦN J-N: 3D engine (compact scene JSON + patch + procedural) ==');

test('scene3d hỗ trợ đủ loại đối tượng yêu cầu ở PHẦN J', () => {
  ['pt', 'line', 'seg', 'vec', 'plane', 'surf', 'axes', 'grid',
    'cube', 'sphere', 'cylinder', 'cone', 'pyramid', 'prism'].forEach((t) => {
    assert.ok(scene3dJs.includes(`'${t}'`), `scene3d thiếu loại "${t}"`);
  });
});

test('PHẦN M: geometry dựng procedural bằng THREE.*Geometry, không nhận vertex-list lớn', () => {
  assert.ok(/SphereGeometry|BoxGeometry|PlaneGeometry/.test(scene3dJs));
  assert.ok(scene3dJs.includes('buildPrimitiveGeometryAndVertices'), 'phải tái dùng builder khối rắn có sẵn');
});

test('PHẦN N: surface z=f(x,y) tự sample, giới hạn độ phân giải theo thiết bị', () => {
  assert.ok(scene3dJs.includes('scene3dSampleSurface'));
  assert.ok(scene3dJs.includes('quality.surfaceN'), 'độ phân giải surface phải theo quality tier');
});

test('PHẦN O: có 3 mức chất lượng + tự giảm trên mobile + fallback khi không có WebGL', () => {
  ['high', 'medium', 'low'].forEach((q) => assert.ok(scene3dJs.includes(`${q}:`), `thiếu preset "${q}"`));
  assert.ok(scene3dJs.includes('pixelRatioCap') && scene3dJs.includes('antialias'));
  assert.ok(scene3dJs.includes('scene3dWebGLAvailable') && scene3dJs.includes('scene3dRenderFallback'));
});

test('PHẦN P: tương tác 3D không gọi AI (không có fetch/apiPost trong scene3d.js)', () => {
  assert.ok(!/fetch\(|apiPost|streamViaProviderRouter/.test(scene3dJs),
    'renderer 3D tuyệt đối không được gọi API/AI cho thao tác UI');
});

test('PHẦN L: patch system có add/del/update và áp lên scene đang có', () => {
  assert.ok(scene3dJs.includes('applyPatch'));
  ["'add'", "'del'", "'update'"].forEach((op) => assert.ok(scene3dJs.includes(op), `thiếu op ${op}`));
  assert.ok(appJs.includes('applyScenePatchToContainer'), 'app.js phải áp patch lên khối scene3d trước đó');
});

test('validator server nhận diện scene3d/scenepatch (khối hỏng không bị coi là hoàn chỉnh)', () => {
  const { validateAllDrawingBlocks } = require('../server/utils/drawingValidator');
  const okBlocks = validateAllDrawingBlocks('```scene3d\n{"v":1,"objs":[{"t":"pt","p":[1,2,3],"l":"A"}]}\n```');
  assert.strictEqual(okBlocks.length, 1);
  assert.strictEqual(okBlocks[0].valid, true);

  const badType = validateAllDrawingBlocks('```scene3d\n{"v":1,"objs":[{"t":"khong-ton-tai"}]}\n```');
  assert.strictEqual(badType[0].valid, false, 'loại đối tượng lạ phải bị coi là không hợp lệ');

  const emptyObjs = validateAllDrawingBlocks('```scene3d\n{"v":1,"objs":[]}\n```');
  assert.strictEqual(emptyObjs[0].valid, false, 'objs rỗng phải bị coi là không hợp lệ');

  const okPatch = validateAllDrawingBlocks('```scenepatch\n{"v":1,"op":[["add","pt",{"p":[1,1,1]}]]}\n```');
  assert.strictEqual(okPatch[0].valid, true);

  const badPatch = validateAllDrawingBlocks('```scenepatch\n{"v":1,"op":[["khong-hop-le"]]}\n```');
  assert.strictEqual(badPatch[0].valid, false, 'op lạ phải bị coi là không hợp lệ');
});

test('prompt dạy AI dùng scene JSON nén + patch, KHÔNG sinh code Three.js (NGUYÊN TẮC #8/#9)', () => {
  assert.ok(promptBuilderJs.includes('scene3d') && promptBuilderJs.includes('scenepatch'));
  assert.ok(/KHÔNG lặp lại toàn bộ "objs"|thay vì gửi lại toàn bộ scene/.test(promptBuilderJs),
    'prompt phải yêu cầu dùng patch thay vì gửi lại full scene');
  assert.ok(!/new THREE\.|WebGLRenderer/.test(promptBuilderJs),
    'prompt tuyệt đối không được chứa/mời gọi code Three.js');
});

/* ---------------- PHẦN T-Z: i18n ---------------- */
console.log('\n== PHẦN T-Z: internationalization ==');

// Nạp translations trong 1 sandbox `window` giả để so khớp khoá thật (không chỉ grep chuỗi).
function loadTranslations() {
  const sandbox = { window: {}, navigator: { language: 'vi' } };
  // eslint-disable-next-line no-new-func
  new Function('window', 'navigator', translationsJs)(sandbox.window, sandbox.navigator);
  return sandbox.window.TRANSLATIONS;
}

test('translations.js có đúng 2 ngôn ngữ vi/en và không rỗng', () => {
  const T = loadTranslations();
  assert.deepStrictEqual(Object.keys(T).sort(), ['en', 'vi']);
  assert.ok(Object.keys(T.vi).length > 100, 'từ điển vi phải phủ đủ UI (>100 khoá)');
});

test('MỌI khoá tồn tại ở CẢ vi và en (không sót khoá -> không lẫn ngôn ngữ)', () => {
  const T = loadTranslations();
  const viKeys = Object.keys(T.vi).sort();
  const enKeys = Object.keys(T.en).sort();
  const missingInEn = viKeys.filter((k) => !(k in T.en));
  const missingInVi = enKeys.filter((k) => !(k in T.vi));
  assert.deepStrictEqual(missingInEn, [], 'khoá có ở vi nhưng thiếu ở en: ' + missingInEn.join(', '));
  assert.deepStrictEqual(missingInVi, [], 'khoá có ở en nhưng thiếu ở vi: ' + missingInVi.join(', '));
});

test('bản dịch en KHÔNG bị bỏ sót thành nguyên văn tiếng Việt (phát hiện copy-paste)', () => {
  const T = loadTranslations();
  const viOnlyChars = /[àáâãèéêìíòóôõùúýăđĩũơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i;
  const suspicious = Object.keys(T.en).filter((k) => {
    const v = T.en[k];
    // Cho phép tên riêng tiếng Việt (vd "Trợ Giải") xuất hiện trong câu tiếng Anh.
    return typeof v === 'string' && viOnlyChars.test(v) && !/Trợ Giải/.test(v);
  });
  assert.deepStrictEqual(suspicious, [], 'các khoá en còn nguyên văn tiếng Việt: ' + suspicious.join(', '));
});

test('placeholder {{n}} khớp nhau giữa vi và en (không vỡ nội suy biến)', () => {
  const T = loadTranslations();
  Object.keys(T.vi).forEach((k) => {
    const viVars = (String(T.vi[k]).match(/\{\{(\w+)\}\}/g) || []).sort();
    const enVars = (String(T.en[k]).match(/\{\{(\w+)\}\}/g) || []).sort();
    assert.deepStrictEqual(enVars, viVars, `khoá "${k}" lệch biến nội suy giữa vi/en`);
  });
});

test('languageStore là nguồn ngôn ngữ TRUNG TÂM, có persist + subscribe (PHẦN T/U/V/AH)', () => {
  assert.ok(languageStoreJs.includes('getUILanguage') && languageStoreJs.includes('setUILanguage'));
  assert.ok(languageStoreJs.includes('localStorage'), 'phải persist lựa chọn ngôn ngữ');
  assert.ok(languageStoreJs.includes('subscribe'), 'phải cho component đăng ký rerender');
  assert.ok(languageStoreJs.includes('SUPPORTED_LANGS'), 'phải khai báo danh sách ngôn ngữ mở rộng được');
});

test('i18n.js rerender UI khi đổi ngôn ngữ, không cần reload trang (PHẦN AH)', () => {
  assert.ok(i18nJs.includes('languageStore.subscribe'));
  assert.ok(i18nJs.includes('applyStaticTranslations(document)'));
});

test('đổi Settings > Language đồng bộ vào languageStore (PHẦN T)', () => {
  assert.ok(appJs.includes('languageStore.setUILanguage'),
    'chip chọn ngôn ngữ phải ghi vào languageStore, không giữ state riêng');
});

test('index.html dùng translation key thay vì hard-code (PHẦN W/X)', () => {
  const count = (indexHtml.match(/data-i18n(?:-html|-placeholder|-title|-aria-label)?=/g) || []).length;
  assert.ok(count >= 70, `mới có ${count} thuộc tính data-i18n — chưa phủ đủ UI tĩnh`);
  // Phủ đủ các NHÓM bắt buộc ở PHẦN X, không chỉ menu.
  assert.ok(indexHtml.includes('data-i18n-placeholder='), 'thiếu dịch placeholder');
  assert.ok(indexHtml.includes('data-i18n-title='), 'thiếu dịch tooltip/title');
  assert.ok(indexHtml.includes('data-i18n-aria-label='), 'thiếu dịch accessibility label');
});

test('trạng thái/nút/empty-state trong app.js đi qua t() thay vì chuỗi cứng (PHẦN X)', () => {
  ["t('chat.statusReady')", "t('chat.stop", "t('chat.retry')",
    "t('chat.detailBtn')", "t('error.", "t('history.deleteConfirm')"].forEach((frag) => {
    assert.ok(appJs.includes(frag), `app.js chưa dùng ${frag}`);
  });
  assert.ok(!appJs.includes("statusEl.textContent = 'SẴN SÀNG'"), 'còn chuỗi trạng thái hard-code');
  // Empty state là markup TĨNH -> dịch qua data-i18n trong index.html (không phải qua app.js);
  // kiểm ở đúng nơi nó sống thay vì đòi app.js phải gọi t('history.empty').
  assert.ok(/id="historyEmpty"[^>]*data-i18n="history\.empty"/.test(indexHtml), 'empty state lịch sử chưa dịch');
  assert.ok(/id="notesEmpty"[^>]*data-i18n-html="notes\.empty"/.test(indexHtml), 'empty state ghi chú chưa dịch');
  assert.ok(/id="emptySources"[^>]*data-i18n="sources\.empty"/.test(indexHtml), 'empty state nguồn chưa dịch');
});

/* ---------------- PHẦN AA-AB, AJ-AN: language contract + lock ---------------- */
console.log('\n== PHẦN AA-AB / AJ-AN: language contract + language lock ==');

const { buildChatSystemPrompt, PROMPT_VERSION } = require('../server/utils/promptBuilder');

function promptFor(lang, stage) {
  return buildChatSystemPrompt({
    deepThinking: false, image: null, rules: [], contexts: [],
    settings: { detail: 'tiêu chuẩn', lang, school: 'thpt', grade: '10' },
    stage: stage || 'detail', approachText: '', problemText: 'Giải phương trình x^2-5x+6=0'
  });
}

test('PHẦN AA: prompt chứa language contract NGẮN, dạng parse được (LANG=/ANSWER=/EXPLANATION=)', () => {
  const en = promptFor('English');
  assert.ok(/LANG=en/.test(en) && /ANSWER=en/.test(en) && /EXPLANATION=en/.test(en));
  const vi = promptFor('Tiếng Việt');
  assert.ok(/LANG=vi/.test(vi) && /ANSWER=vi/.test(vi) && /EXPLANATION=vi/.test(vi));
});

test('PHẦN AB: static language rule có mặt và nói rõ answer + steps cùng ngôn ngữ (sửa bug PHẦN Y)', () => {
  const en = promptFor('English');
  assert.ok(en.includes('Answer and step-by-step explanation MUST use the same language.'));
  assert.ok(en.includes('Do not mix languages unless quoting source material'));
  assert.ok(/BẢNG/.test(en), 'quy tắc phải nêu rõ nội dung bảng cũng theo cùng ngôn ngữ (PHẦN AE)');
});

test('PHẦN AB: static rule GIỐNG NHAU giữa các ngôn ngữ (phần tĩnh -> cache được)', () => {
  const ruleLine = 'Answer and step-by-step explanation MUST use the same language.';
  assert.ok(promptFor('English').includes(ruleLine));
  assert.ok(promptFor('Tiếng Việt').includes(ruleLine));
  assert.ok(promptFor('tự động theo câu hỏi').includes(ruleLine));
});

test('PHẦN AB: static rule nằm chung khối đầu prompt cùng CORE_DIRECTIVE (vùng cache)', () => {
  const en = promptFor('English');
  const coreIdx = en.indexOf('MỆNH LỆNH DUY NHẤT');
  const ruleIdx = en.indexOf('QUY TẮC NGÔN NGỮ');
  const queryIdx = en.indexOf('NHIỆM VỤ');
  assert.ok(coreIdx === 0 || coreIdx < ruleIdx, 'CORE_DIRECTIVE phải ở đầu');
  assert.ok(ruleIdx > -1 && (queryIdx === -1 || ruleIdx < queryIdx),
    'quy tắc ngôn ngữ tĩnh phải nằm TRƯỚC phần động của từng lượt');
});

test('PHẦN AE: heading English mode là English, không lẫn tiêu đề tiếng Việt', () => {
  const en = promptFor('English');
  assert.ok(en.includes('## Solution') || en.includes('## Approach'));
  assert.ok(!en.includes('## Lời giải'), 'English mode không được yêu cầu tiêu đề tiếng Việt');
  const vi = promptFor('Tiếng Việt');
  assert.ok(vi.includes('## Lời giải') || vi.includes('## Hướng giải'));
});

test('PHẦN AS/AO: prompt KHÔNG chứa từ điển dịch i18n (token không phình vì i18n)', () => {
  const en = promptFor('English');
  assert.ok(!en.includes('chat.generating'), 'không được gửi khoá dịch UI cho model');
  assert.ok(!en.includes('TRANSLATIONS'), 'không được gửi từ điển dịch cho model');
  // Language contract phải RẤT ngắn so với toàn prompt.
  const contractLine = (en.match(/LANG=en[^\n]*/) || [''])[0];
  assert.ok(contractLine.length < 220, `dòng contract dài ${contractLine.length} ký tự — phải ngắn gọn`);
});

test('PHẦN AJ/AK: settings được SAO CHÉP tại thời điểm bắt đầu request (không tham chiếu state sống)', () => {
  assert.ok(appJs.includes('const settingsSnapshot = { ...state.settings }'),
    'phải snapshot settings để đổi Settings giữa stream không đổi ngôn ngữ đang chạy');
  // Sau khi snapshot, request phải gửi snapshot chứ KHÔNG gửi state.settings sống.
  assert.ok(appJs.includes('settings: settingsSnapshot'), 'request phải dùng bản snapshot');
});

test('PHẦN AK: task lưu language lock (requestLanguage/answerLanguage/explanationLanguage)', () => {
  ['requestLanguage', 'uiLanguageAtStart', 'answerLanguage', 'explanationLanguage'].forEach((f) => {
    assert.ok(ctmJs.includes(f), `task state thiếu "${f}"`);
    assert.ok(appJs.includes(f), `app.js chưa chốt "${f}" khi bắt đầu request`);
  });
});

test('PHẦN AM/AN: fallback Puter kế thừa language contract của request gốc', () => {
  assert.ok(routerJs.includes('buildPuterFallbackSystemPrompt'));
  assert.ok(/settings\.lang/.test(routerJs), 'prompt fallback phải đọc ngôn ngữ từ payload đã chốt');
  assert.ok(/English|Tiếng Việt/.test(routerJs), 'fallback phải có chỉ thị ngôn ngữ tường minh');
});

/* ---------------- PHẦN AF-AG: error code -> i18n ---------------- */
console.log('\n== PHẦN AF-AG: error code / status language separation ==');

test('backend trả code + retryable ổn định, không phụ thuộc câu chữ', () => {
  const { normalizeError } = require('../server/utils/errorNormalize');
  const e = new Error('bất kỳ');
  e.status = 429;
  const n = normalizeError(e);
  assert.strictEqual(n.code, 'RATE_LIMIT');
  assert.strictEqual(n.retryable, true);
});

test('frontend map error code -> khoá dịch (UI quyết định câu chữ, không phải backend)', () => {
  assert.ok(i18nJs.includes('ERROR_CODE_I18N_KEY'));
  ['RATE_LIMIT', 'TIMEOUT', 'PROVIDER_UNAVAILABLE', 'INVALID_INPUT'].forEach((c) => {
    assert.ok(i18nJs.includes(c), `thiếu mapping cho code ${c}`);
  });
  assert.ok(i18nJs.includes('function tError'), 'phải có helper dịch theo code');
});

test('apiPost/apiPostStream ưu tiên dịch theo code trả về từ server', () => {
  assert.ok(appJs.includes('window.tError'), 'app.js phải dùng tError cho lỗi từ server');
  const occurrences = (appJs.match(/window\.tError\(/g) || []).length;
  assert.ok(occurrences >= 3, `mới có ${occurrences} chỗ dùng tError — cần phủ cả apiPost, stream, SSE error`);
});

test('mọi khoá error.* được map tới đều TỒN TẠI trong từ điển (không hiện undefined)', () => {
  const T = loadTranslations();
  const mapBody = (i18nJs.match(/ERROR_CODE_I18N_KEY = \{([\s\S]*?)\};/) || [])[1] || '';
  const keys = [...mapBody.matchAll(/'([\w.]+)'/g)].map((m) => m[1]).filter((k) => k.includes('.'));
  assert.ok(keys.length >= 8, 'map error code quá ít, có thể parse sai');
  keys.forEach((k) => {
    assert.ok(k in T.vi, `khoá "${k}" thiếu trong từ điển vi`);
    assert.ok(k in T.en, `khoá "${k}" thiếu trong từ điển en`);
  });
});

/* ---------------- Regression: PROMPT_VERSION + asset wiring ---------------- */
console.log('\n== Regression: prompt version + asset wiring ==');

test('PROMPT_VERSION đã bump (cache L1 cũ không bị dùng lại sau khi đổi prompt ngôn ngữ/3D)', () => {
  assert.notStrictEqual(PROMPT_VERSION, 'chat-prompt-v4', 'phải bump khi đổi cấu trúc prompt');
  assert.ok(/^chat-prompt-v\d+$/.test(PROMPT_VERSION));
});

test('mọi file JS mới đều được nạp trong index.html, đúng thứ tự phụ thuộc', () => {
  const order = ['/js/i18n/translations.js', '/js/i18n/languageStore.js', '/js/i18n/i18n.js',
    '/js/scene3d.js', '/js/providers/puterAdapter.js', '/js/providers/providerRouter.js',
    '/js/tasks/conversationTaskManager.js', '/js/app.js'];
  // CHỈ xét các thẻ <script src> THẬT — index.html có chú thích nhắc tên file (vd "public/js/app.js")
  // ở phía trên phần <script>, nếu dùng indexOf trên cả file sẽ bắt phải chú thích đó và báo sai
  // thứ tự nạp.
  const scriptSrcs = [...indexHtml.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
  const idx = order.map((f) => {
    const i = scriptSrcs.indexOf(f);
    assert.ok(i > -1, `index.html chưa nạp ${f} bằng thẻ <script src>`);
    return i;
  });
  for (let i = 1; i < idx.length; i++) {
    assert.ok(idx[i] > idx[i - 1], `${order[i]} phải nạp SAU ${order[i - 1]}`);
  }
});

test('build script fingerprint đủ các asset mới (tránh HTML mới + JS cũ trên Vercel)', () => {
  const buildJs = read('scripts/build.js');
  ['scene3d.js', 'translations.js', 'languageStore.js', 'i18n.js',
    'puterAdapter.js', 'providerRouter.js', 'conversationTaskManager.js'].forEach((f) => {
    assert.ok(buildJs.includes(`'${f}'`), `scripts/build.js chưa fingerprint ${f}`);
  });
});

test('scene3d.js không dùng localStorage/sessionStorage trực tiếp (state 3D là ephemeral)', () => {
  assert.ok(!/localStorage|sessionStorage/.test(scene3dJs));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
