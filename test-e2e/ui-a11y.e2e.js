'use strict';

// E2E UI/A11y (P1–P5). CẦN trình duyệt nên KHÔNG nằm trong `npm test`. Chạy: npm run test:e2e-ui
//   1) npx playwright install chromium     2) npm run build && npx next start -p 3000
//   3) E2E_BASE_URL=http://127.0.0.1:3000 npm run test:e2e-ui
// Biến tuỳ chọn: E2E_BASE_URL (mặc định http://127.0.0.1:3000), CHROMIUM_PATH (đường dẫn Chromium có sẵn).

const { chromium } = require('playwright');

const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000';
let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ok  -', name); } else { failed++; console.log(' FAIL -', name, detail === undefined ? '' : '\n       ' + JSON.stringify(detail)); }
}

// Chỉ cho phép gọi tới BASE — mọi request ra ngoài (Google Fonts, Puter...) bị chặn để test ổn định/offline.
async function newPage(browser, opts) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.route('**/*', (r) => (r.request().url().startsWith(BASE) ? r.continue() : r.abort()));
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof createDialog === 'function');
  return { page, ctx, pageErrors };
}

// ------------------------------------------------------------------ P1 + P5: topbar mobile
async function topbarChecks(browser) {
  for (const w of [320, 360, 375, 390, 414]) {
   for (const bg of [false, true]) {
    const { page, ctx } = await newPage(browser, { viewport: { width: w, height: 844 }, isMobile: true, hasTouch: true });
    // bg=true: ca xấu nhất — nút tác vụ nền #bgTaskBtn hiện (JS bật bằng style.display = '').
    // Lưu ý: backgroundTaskUI.refreshBadge() bật CẢ nút lẫn class .has-bgtask trên #topbar; ở đây mô phỏng đúng cặp đó.
    if (bg) await page.evaluate(() => { document.getElementById('bgTaskBtn').style.display = ''; document.getElementById('topbar').classList.add('has-bgtask'); });
    const tag = `${w}px${bg ? ' + bgTask' : ''}`;
    const r = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth,
      cw: document.documentElement.clientWidth,
      pad: getComputedStyle(document.getElementById('topbar')).padding,
      statusFs: getComputedStyle(document.getElementById('statusText')).fontSize,
      offscreen: [...document.querySelectorAll('#topbar button')]
        .filter((b) => { const x = b.getBoundingClientRect(); return x.width > 0 && (x.left < -0.5 || x.right > innerWidth + 0.5); })
        .map((b) => b.id),
      small: [...document.querySelectorAll('#topbar .iconbtn')]
        .filter((b) => { const x = b.getBoundingClientRect(); return x.width > 0 && (x.width < 43.5 || x.height < 43.5); })
        .map((b) => b.id),
      titleW: Math.round(document.getElementById('chatTitle').getBoundingClientRect().width)
    }));
    check(`P1 ${tag}: không tràn ngang`, r.sw === r.cw, r);
    check(`P1 ${tag}: mọi nút topbar nằm trọn trong viewport`, r.offscreen.length === 0, r.offscreen);
    check(`P1 ${tag}: override mobile có hiệu lực (font trạng thái = 0)`, r.statusFs === '0px', r.statusFs);
    check(`P5 ${tag}: nút icon topbar >= 44x44 (pointer:coarse)`, r.small.length === 0, r.small);
    check(`P1 ${tag}: tiêu đề còn chỗ hiển thị (>= 60px)`, r.titleW >= 60, r.titleW);
    await ctx.close();
   }
  }
}

// ------------------------------------------------------------------ P5: tablet cảm ứng (641-1024px, sidebar hiện)
async function tabletTouchChecks(browser) {
  const { page, ctx } = await newPage(browser, { viewport: { width: 768, height: 1024 }, isMobile: true, hasTouch: true });
  const tooSmall = () => page.evaluate(() => [...document.querySelectorAll('#settingsOverlay.show .chip, #settingsOverlay.show .set-close, #settingsOverlay.show button, #addSourceOverlay.show #urlSourceAddBtn, #addSourceOverlay.show #urlSourceInput, #addSourceBtn, #sourceSearchInput, #historySubjectFilter')]
    // offsetWidth/offsetHeight = kích thước layout, KHÔNG bị transform scale của animation mở modal làm lệch (getBoundingClientRect đo 43px giữa animation).
    .map((e) => [e.id || e.className, e.offsetWidth, e.offsetHeight])
    .filter((x) => x[1] > 0 && x[2] > 0 && (x[1] < 44 || x[2] < 44)));
  await page.click('#settingsBtnTop');
  check('P5 tablet: chip/nút trong Settings và ô sidebar >= 44px', (await tooSmall()).length === 0, await tooSmall());
  await page.keyboard.press('Escape');
  await page.click('#addSourceBtn');
  check('P5 tablet: #urlSourceAddBtn và #urlSourceInput >= 44px', (await tooSmall()).length === 0, await tooSmall());
  const hit = await page.evaluate(() => { const a = getComputedStyle(document.getElementById('attachBtn'), '::after'); return [a.width, a.height]; });
  check('P5 tablet: nút công cụ composer có vùng chạm 44x44 (::after)', hit[0] === '44px' && hit[1] === '44px', hit);
  await ctx.close();
}

// ------------------------------------------------------------------ P3 + P4: dialog / drawer
const DIALOGS = [
  { name: 'Settings', root: '#settingsOverlay', open: 'show', modal: true, opener: '#settingsBtnTop', trigger: (p) => p.click('#settingsBtnTop') },
  { name: 'Practice', root: '#practiceOverlay', open: 'show', modal: true, opener: '#newChatBtn',
    trigger: (p) => p.evaluate(() => { document.getElementById('newChatBtn').focus(); openPracticeSetup(); }) },
  { name: 'Note', root: '#noteOverlay', open: 'show', modal: true, opener: '#newChatBtn',
    trigger: (p) => p.evaluate(() => { document.getElementById('newChatBtn').focus(); openNoteModal({ query: 'câu hỏi thử', userNote: '' }, { id: 'c' }); }) },
  { name: 'Recommend', root: '#recommendPanel', open: 'open', modal: false, opener: '#recommendTopBtn', trigger: (p) => p.click('#recommendTopBtn') },
  { name: 'Flashcard', root: '#flashcardPanel', open: 'open', modal: false, opener: '#flashcardTopBtn', trigger: (p) => p.click('#flashcardTopBtn') }
];

async function dialogChecks(browser) {
  for (const d of DIALOGS) {
    const { page, ctx, pageErrors } = await newPage(browser, { viewport: { width: 1280, height: 800 } });
    const isOpen = () => page.evaluate(([s, c]) => document.querySelector(s).classList.contains(c), [d.root, d.open]);
    const activeInfo = () => page.evaluate((s) => ({ inside: document.querySelector(s).contains(document.activeElement), id: document.activeElement && document.activeElement.id }), d.root);

    // ARIA tĩnh
    const aria = await page.evaluate((s) => {
      const root = document.querySelector(s);
      const dlg = root.getAttribute('role') === 'dialog' ? root : root.querySelector('[role="dialog"]');
      const lbl = dlg && dlg.getAttribute('aria-labelledby');
      const lblEl = lbl && document.getElementById(lbl);
      return { role: dlg && dlg.getAttribute('role'), modal: dlg && dlg.getAttribute('aria-modal'), label: lblEl ? lblEl.textContent.trim() : null };
    }, d.root);
    check(`P4 ${d.name}: role=dialog`, aria.role === 'dialog', aria);
    check(`P4 ${d.name}: aria-modal="${d.modal}"`, aria.modal === String(d.modal), aria);
    check(`P4 ${d.name}: aria-labelledby trỏ tới tiêu đề có chữ`, !!aria.label, aria);

    // Mở -> focus vào trong
    await d.trigger(page);
    check(`P3 ${d.name}: mở được`, await isOpen());
    const a1 = await activeInfo();
    check(`P4 ${d.name}: mở xong focus nằm TRONG dialog`, a1.inside, a1);

    // Trap Tab (chỉ modal)
    if (d.modal) {
      let escaped = 0;
      for (let i = 0; i < 40; i++) { await page.keyboard.press('Tab'); if (!(await activeInfo()).inside) escaped++; }
      for (let i = 0; i < 40; i++) { await page.keyboard.press('Shift+Tab'); if (!(await activeInfo()).inside) escaped++; }
      check(`P4 ${d.name}: Tab/Shift+Tab xoay vòng, không thoát ra ngoài (80 lần)`, escaped === 0, escaped);
    }

    // Esc khi đang ghi âm phải NHƯỜNG cho handler dừng ghi âm
    await page.evaluate(() => { window.__origGetState = window.voiceInput.getState; window.voiceInput.getState = () => 'recording'; });
    await page.keyboard.press('Escape');
    check(`P3 ${d.name}: đang ghi âm thì Esc KHÔNG đóng dialog (handler ghi âm thắng)`, await isOpen());
    await page.evaluate(() => { window.voiceInput.getState = window.__origGetState; });

    // Esc đóng + trả focus
    if (!(await activeInfo()).inside) await page.focus(d.root + ' button');
    await page.keyboard.press('Escape');
    check(`P3 ${d.name}: Esc đóng`, !(await isOpen()));
    const back = await page.evaluate(() => document.activeElement && document.activeElement.id);
    check(`P3 ${d.name}: đóng xong focus về nút đã mở (${d.opener})`, '#' + back === d.opener, back);

    // Mở lại rồi đóng bằng backdrop vẫn trả focus
    if (d.modal) {
      await d.trigger(page);
      await page.mouse.click(4, 4); // backdrop (góc overlay, ngoài modal)
      check(`P3 ${d.name}: click backdrop đóng`, !(await isOpen()));
      const back2 = await page.evaluate(() => document.activeElement && document.activeElement.id);
      check(`P3 ${d.name}: đóng bằng backdrop cũng trả focus`, '#' + back2 === d.opener, back2);
    }

    check(`${d.name}: không có lỗi JS trang`, pageErrors.length === 0, pageErrors);
    await ctx.close();
  }

  // Drawer mở TỰ ĐỘNG (không có nút mở, không chuyển focus): Esc khi không focus gì thì đóng; đang gõ ở ô nhập thì KHÔNG đóng
  {
    const { page, ctx } = await newPage(browser, { viewport: { width: 1280, height: 800 } });
    const open = () => page.evaluate(() => document.getElementById('flashcardPanel').classList.contains('open'));
    await page.evaluate(() => { document.activeElement && document.activeElement.blur(); openFlashcardPanel(); });
    check('P3 Flashcard tự mở: mở được và KHÔNG cướp focus', (await open()) && !(await page.evaluate(() => document.getElementById('flashcardPanel').contains(document.activeElement))));
    await page.focus('#qInput');
    await page.keyboard.press('Escape');
    check('P3 Flashcard tự mở: đang gõ trong ô nhập thì Esc KHÔNG đóng drawer', await open());
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.press('Escape');
    check('P3 Flashcard tự mở: không focus gì thì Esc đóng drawer', !(await open()));
    await ctx.close();
  }

  // Note: Esc phải dọn ngữ cảnh ghi chú
  {
    const { page, ctx } = await newPage(browser, { viewport: { width: 1280, height: 800 } });
    await page.evaluate(() => openNoteModal({ query: 'q', userNote: '' }, { id: 'c' }));
    await page.keyboard.press('Escape');
    const ctxLeft = await page.evaluate(() => activeNoteCtx);
    check('Note: Esc dọn activeNoteCtx (Lưu không ghi vào tin nhắn đã đóng)', ctxLeft === null, ctxLeft);
    await ctx.close();
  }
}

// ------------------------------------------------------------------ P4: tabs + tên truy cập
async function ariaChecks(browser) {
  const { page, ctx } = await newPage(browser, { viewport: { width: 1280, height: 800 } });
  const before = await page.evaluate(() => [...document.querySelectorAll('#sidebarTabs .sbtab')].map((t) => [t.getAttribute('role'), t.getAttribute('aria-selected')]));
  check('P4 tabs: 4 nút role=tab, chỉ tab đầu selected', before.length === 4 && before.every((x) => x[0] === 'tab') && before[0][1] === 'true' && before.slice(1).every((x) => x[1] === 'false'), before);
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'public/js/tasks/backgroundTaskUI.js'), 'utf8');
  check('backgroundTaskUI bật/tắt class .has-bgtask cùng lúc với nút (CSS topbar hẹp phụ thuộc vào đó)', /classList\.toggle\('has-bgtask'/.test(src));
  check('P4 tabs: container role=tablist', await page.evaluate(() => document.getElementById('sidebarTabs').getAttribute('role')) === 'tablist');
  await page.click('.sbtab[data-tab="history"]');
  const after = await page.evaluate(() => [...document.querySelectorAll('#sidebarTabs .sbtab')].map((t) => t.getAttribute('aria-selected')));
  check('P4 tabs: aria-selected đổi theo tab đang chọn', after.join() === 'false,true,false,false', after);
  const panels = await page.evaluate(() => [...document.querySelectorAll('.sbpanel')].map((p) => [p.getAttribute('role'), document.getElementById(p.getAttribute('aria-labelledby')) !== null]));
  check('P4 tabs: panel role=tabpanel + aria-labelledby hợp lệ', panels.every((x) => x[0] === 'tabpanel' && x[1]), panels);
  const names = await page.evaluate(() => ['historySubjectFilter', 'fileInput', 'imageInput'].map((id) => [id, (document.getElementById(id).getAttribute('aria-label') || '').trim()]));
  check('P4: select lọc môn + 2 input file có aria-label không rỗng, không phải key thô', names.every((x) => x[1] && !/^[a-z]+\.[A-Za-z]+/.test(x[1])), names);
  const ph = await page.evaluate(() => document.getElementById('sourceSearchInput').placeholder);
  check('P2: placeholder ô tìm nguồn không phải key thô', ph && ph !== 'sources.searchPlaceholder', ph);
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  try {
    await topbarChecks(browser);
    await tabletTouchChecks(browser);
    await dialogChecks(browser);
    await ariaChecks(browser);
  } finally {
    await browser.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
