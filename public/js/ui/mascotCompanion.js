'use strict';

/* =====================================================================================
   mascotCompanion.js — Akis đứng cạnh khung chat + hướng dẫn nhanh lần đầu.
   - Dùng đúng ảnh Akis (AkisMascot). KHÔNG gọi AI, KHÔNG gọi mạng: 0 token.
   - Chỉ hiện khi đã đăng nhập (TGAuth.status = authenticated) hoặc khi server tắt bắt buộc đăng nhập (disabled).
   - Phải nạp SAU app.js (cần các id: #addSourceBtn #qInput #subjectBtn #flashcardTopBtn #sendBtn #thread).
   - Phản ứng: gửi câu hỏi -> "working"; có nội dung mới trong #thread -> "success" rồi về "idle".
   - Thu nhỏ/mở lại bằng chính nút Akis; trạng thái nhớ trong localStorage (có try/catch).
   ===================================================================================== */
(function () {
  var A = window.AkisMascot;
  if (!A || window.TGAkis) return;

  var KEY_TOUR = 'tg.akis.tour.v1', KEY_MIN = 'tg.akis.min';
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
  function tr(key, vars) {
    var s = typeof window.t === 'function' ? window.t(key) : key;
    if (vars) Object.keys(vars).forEach(function (k) { s = s.replace('{{' + k + '}}', vars[k]); });
    return s;
  }
  function $(sel) { return document.querySelector(sel); }
  function visible(n) { return !!(n && n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden'); }

  var STEPS = [
    { sel: '#addSourceBtn', key: 'ak.t1', state: 'point-left' },
    { sel: '#qInput', key: 'ak.t2', state: 'type-email' },
    { sel: '#subjectBtn', key: 'ak.t3', state: 'point-left' },
    { sel: '#flashcardTopBtn', key: 'ak.t4', state: 'celebrate' }
  ];

  var host, btn, mk, bubble, tour, idleT = 0, built = false;

  function build() {
    if (built) return; built = true;
    host = document.createElement('div');
    host.id = 'tgAkis';
    host.className = 'tg-akis' + (store(KEY_MIN) === '1' ? ' is-min' : '');
    bubble = A.createBubble();
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tg-akis-btn';
    mk = A.create({ size: '100%', variant: 'body', state: 'idle', track: true });
    btn.appendChild(mk.el);
    host.appendChild(bubble.el);
    host.appendChild(btn);
    document.body.appendChild(host);
    syncLabel();

    btn.addEventListener('click', function () {
      var min = !host.classList.contains('is-min');
      host.classList.toggle('is-min', min);
      store(KEY_MIN, min ? '1' : '0');
      syncLabel();
      if (!min) { say('ak.say.hi', 3000); flash('wave', 1500); }
    });
    wireReactions();
    if (window.languageStore) window.languageStore.subscribe(function () { syncLabel(); if (tour) renderStep(); });
  }
  function syncLabel() {
    var min = host.classList.contains('is-min');
    btn.setAttribute('aria-label', tr(min ? 'ak.show' : 'ak.hide'));
    btn.setAttribute('aria-expanded', String(!min));
    btn.title = tr('ak.aria');
  }
  function say(key, ms) { if (host.classList.contains('is-min') && !tour) return; bubble.say(tr(key), ms); }
  function flash(state, ms) {
    mk.setState(state); clearTimeout(idleT);
    idleT = setTimeout(function () { mk.setState('idle'); }, ms);
  }

  // ------------------------------------------------------------------ phản ứng với việc học
  function wireReactions() {
    var send = $('#sendBtn'), thread = $('#thread'), input = $('#qInput');
    var pending = false, quiet = 0, safety = 0;
    function done() {
      if (!pending) return;
      pending = false; clearTimeout(quiet); clearTimeout(safety);
      flash('success', reduce ? 800 : 2200); say('ak.say.done', 3500);
    }
    if (send) send.addEventListener('click', function () {
      if (input && !input.value.trim()) return;
      pending = true; clearTimeout(idleT); mk.setState('working'); say('ak.say.working');
      clearTimeout(safety); safety = setTimeout(function () { pending = false; mk.setState('idle'); bubble.hide(); }, 120000);
    });
    if (thread && window.MutationObserver) {
      new MutationObserver(function () {
        if (!pending) return;
        clearTimeout(quiet); quiet = setTimeout(done, 1800);
      }).observe(thread, { childList: true, subtree: true, characterData: true });
    }
    if (input) {
      input.addEventListener('focus', function () { if (!pending && !tour) mk.setState('look'); });
      input.addEventListener('blur', function () { if (!pending && !tour) mk.setState('idle'); });
    }
  }

  // ------------------------------------------------------------------ hướng dẫn lần đầu
  var stepIdx = 0, steps = [], prevFocus = null, hl = null;
  function startTour() {
    steps = STEPS.filter(function (s) { return visible($(s.sel)); });
    if (!steps.length || tour) return;
    host.classList.remove('is-min');
    prevFocus = document.activeElement;
    tour = document.createElement('div');
    tour.className = 'tg-akis-tour';
    tour.setAttribute('role', 'dialog');
    tour.setAttribute('aria-label', tr('ak.tour.aria'));
    tour.innerHTML = '<p class="tg-tour-n"></p><p class="tg-tour-t"></p><div class="tg-tour-row"><button type="button" class="tg-tour-b" data-a="skip"></button><span class="tg-tour-gap"></span><button type="button" class="tg-tour-b" data-a="prev"></button><button type="button" class="tg-tour-b tg-tour-main" data-a="next"></button></div>';
    host.insertBefore(tour, host.firstChild);
    tour.addEventListener('click', function (e) {
      var a = e.target && e.target.getAttribute && e.target.getAttribute('data-a');
      if (a === 'next') { if (stepIdx >= steps.length - 1) endTour(); else { stepIdx++; renderStep(true); } }
      else if (a === 'prev' && stepIdx > 0) { stepIdx--; renderStep(true); }
      else if (a === 'skip') endTour();
    });
    document.addEventListener('keydown', onKey, true);
    stepIdx = 0; renderStep(true);
  }
  function onKey(e) { if (e.key === 'Escape' && tour) { e.stopPropagation(); endTour(); } }
  function renderStep(focus) {
    if (!tour) return;
    var s = steps[stepIdx], target = $(s.sel);
    if (hl) hl.classList.remove('tg-akis-hl');
    hl = target; if (hl) { hl.classList.add('tg-akis-hl'); try { hl.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' }); } catch (e) { /* bỏ qua */ } }
    tour.querySelector('.tg-tour-n').textContent = tr('ak.tour.n', { n: stepIdx + 1, total: steps.length });
    tour.querySelector('.tg-tour-t').textContent = tr(s.key);
    var last = stepIdx === steps.length - 1;
    tour.querySelector('[data-a="skip"]').textContent = tr('ak.skip');
    var prev = tour.querySelector('[data-a="prev"]'); prev.textContent = tr('ak.prev'); prev.hidden = stepIdx === 0;
    var next = tour.querySelector('[data-a="next"]'); next.textContent = tr(last ? 'ak.done' : 'ak.next');
    mk.setState(s.state);
    if (focus) next.focus();
  }
  function endTour() {
    if (!tour) return;
    store(KEY_TOUR, '1');
    if (hl) hl.classList.remove('tg-akis-hl');
    document.removeEventListener('keydown', onKey, true);
    tour.parentNode.removeChild(tour); tour = null; hl = null;
    mk.setState('success'); idleT = setTimeout(function () { mk.setState('idle'); }, reduce ? 500 : 1800);
    try { (prevFocus && document.contains(prevFocus) ? prevFocus : btn).focus(); } catch (e) { /* bỏ qua */ }
  }

  // ------------------------------------------------------------------ khởi động: chờ trạng thái đăng nhập
  var tries = 0;
  function boot() {
    var st = window.TGAuth && window.TGAuth.getState ? window.TGAuth.getState().status : null;
    if (st === 'authenticated' || st === 'disabled') {
      build();
      if (store(KEY_TOUR) !== '1') setTimeout(startTour, 900);
      return;
    }
    if (++tries < 40) setTimeout(boot, 400); // nhanh lúc mở trang, rồi chậm lại để Akis xuất hiện ngay sau khi người dùng đăng nhập
    else setTimeout(boot, 2000);
  }
  boot();

  window.TGAkis = {
    startTour: function () { build(); if (built) startTour(); },
    setState: function (s) { if (mk) mk.setState(s); },
    say: function (key, ms) { if (built) say(key, ms); }
  };
})();
