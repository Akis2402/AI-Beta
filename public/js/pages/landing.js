'use strict';

/* landing.js — trang giới thiệu. KHÔNG gọi AI. Chỉ có 1 request: GET /api/auth/session (chỉ để đổi nút
   "Đăng nhập" thành "Vào ứng dụng" nếu đã đăng nhập; lỗi thì giữ nguyên nút mặc định). */
(function () {
  // Supabase có thể redirect link email (đặt lại mật khẩu / lỗi) về "/" — chuyển nguyên hash sang app để authUI xử lý.
  var hash = location.hash || '';
  if (/[#&](access_token=|type=recovery|error=|error_code=|error_description=)/.test(hash)) {
    location.replace('/index.html' + hash);
    return;
  }

  var root = document.documentElement;
  root.classList.add('js');
  var A = window.AkisMascot;
  var $ = function (id) { return document.getElementById(id); };
  function tr(key) { return typeof window.t === 'function' ? window.t(key) : key; }
  function syncLang() { if (window.languageStore) root.lang = window.languageStore.getUILanguage(); }
  syncLang();
  if (window.applyStaticTranslations) window.applyStaticTranslations(document);

  // ------------------------------------------------------------------ linh vật: hero + dock
  var hero = null, dock = null, heroBubble = null, dockBubble = null;
  var heroKey = 'lp.say.hero', dockKey = '';
  if (A) {
    hero = A.create({ size: '100%', variant: 'full', state: 'wave', track: true });
    $('heroAkis').appendChild(hero.el);
    heroBubble = A.createBubble();
    $('heroBubbleSlot').appendChild(heroBubble.el);
    setTimeout(function () { heroBubble.say(tr(heroKey), 5200); }, 500);

    dock = A.create({ size: '100%', variant: 'body', state: 'idle' });
    $('dockAkis').appendChild(dock.el);
    dockBubble = A.createBubble();
    $('dockBubbleSlot').appendChild(dockBubble.el);
  }

  // ------------------------------------------------------------------ Akis đổi trạng thái theo mục đang cuộn tới
  var dockEl = $('dock');
  var holdTimer = 0, current = null;
  function activate(sec) {
    if (!sec || sec === current) return;
    current = sec;
    if (sec.id === 'hero') { dockEl.classList.add('is-off'); if (dockBubble) dockBubble.hide(); return; }
    dockEl.classList.remove('is-off');
    if (!dock) return;
    dock.setState(sec.getAttribute('data-akis-state') || 'idle');
    dock.setProp(sec.getAttribute('data-akis-prop') || 'none');
    dockKey = sec.getAttribute('data-akis-say') || '';
    if (dockKey) dockBubble.say(tr(dockKey), 4200);
  }
  function flash(state, ms) {
    if (!dock) return;
    clearTimeout(holdTimer);
    dock.setState(state);
    holdTimer = setTimeout(function () { if (current) dock.setState(current.getAttribute('data-akis-state') || 'idle'); }, ms);
  }
  var secs = [].slice.call(document.querySelectorAll('[data-akis-state]'));
  if ('IntersectionObserver' in window) {
    var secIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) activate(e.target); });
    }, { rootMargin: '-45% 0px -45% 0px', threshold: 0 });
    secs.forEach(function (s) { secIO.observe(s); });

    var rvIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); rvIO.unobserve(e.target); } });
    }, { threshold: 0.15 });
    [].forEach.call(document.querySelectorAll('.rv'), function (n) { rvIO.observe(n); });
  } else {
    [].forEach.call(document.querySelectorAll('.rv'), function (n) { n.classList.add('in'); });
  }

  // ------------------------------------------------------------------ tiến độ cuộn -> --p (thanh trên cùng + vệt xoáy của Akis)
  var ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () {
      ticking = false;
      var max = root.scrollHeight - window.innerHeight;
      var p = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
      root.style.setProperty('--p', p.toFixed(4));
      if (hero) hero.setProgress(p);
      if (dock) dock.setProgress(p);
    });
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // ------------------------------------------------------------------ tương tác nhỏ
  var solBtn = $('solBtn'), solBox = $('solBox');
  if (solBtn && solBox) {
    solBtn.addEventListener('click', function () {
      var open = solBtn.getAttribute('aria-expanded') !== 'true';
      solBtn.setAttribute('aria-expanded', String(open));
      solBox.hidden = !open;
      var key = open ? 'lp.s2.hide' : 'lp.s2.reveal';
      solBtn.setAttribute('data-i18n', key);
      solBtn.textContent = tr(key);
      if (open) flash('success', 1800);
    });
  }
  var card = $('flash');
  if (card) {
    var front = card.querySelector('.front'), back = card.querySelector('.back');
    var setFace = function (flipped) {
      card.setAttribute('aria-pressed', String(flipped));
      front.setAttribute('aria-hidden', String(flipped));
      back.setAttribute('aria-hidden', String(!flipped));
    };
    setFace(false);
    card.addEventListener('click', function () {
      var flipped = card.getAttribute('aria-pressed') !== 'true';
      setFace(flipped);
      if (flipped) flash('celebrate', 1600);
    });
  }
  var dockBtn = $('dockBtn');
  if (dockBtn && dock) {
    dockBtn.addEventListener('click', function () {
      flash('wave', 1600);
      dockBubble.say(tr('ak.say.hi'), 3000);
    });
  }
  var langBtn = $('langBtn');
  if (langBtn && window.languageStore) {
    langBtn.addEventListener('click', function () {
      window.languageStore.setUILanguage(window.languageStore.getUILanguage() === 'vi' ? 'en' : 'vi');
    });
    window.languageStore.subscribe(function () {
      syncLang();
      if (heroBubble) heroBubble.say(tr(heroKey), 3000);
      if (dockKey && dockBubble) dockBubble.say(tr(dockKey), 3000);
    });
  }

  // ------------------------------------------------------------------ đã đăng nhập? -> "Vào ứng dụng"
  function swapCta() {
    [].forEach.call(document.querySelectorAll('[data-cta="login"], [data-cta="signup"]'), function (n) { n.hidden = true; });
    [].forEach.call(document.querySelectorAll('[data-cta="app"]'), function (n) { n.hidden = false; });
  }
  if (window.fetch) {
    fetch('/api/auth/session', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && j.status === 'authenticated') swapCta(); })
      .catch(function () { /* giữ nút mặc định */ });
  }

  // Không destroy mascot ở pagehide: giữ trang dùng được khi quay lại từ bfcache.
})();
