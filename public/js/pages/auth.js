'use strict';

/* auth.js — điều khiển trang /auth (đăng nhập, đăng ký, quên mật khẩu).
   Chỉ gọi /api/auth/* qua AuthClient. KHÔNG gọi route AI nên không tốn token AI.
   Luồng dữ liệu thật dùng chung server với modal đăng nhập trong app (cookie HttpOnly, PoW, giới hạn tốc độ). */
(function () {
  // Link email của Supabase có thể trỏ về đây: chuyển nguyên hash (recovery / lỗi) sang app để authUI xử lý.
  var hash = location.hash || '';
  if (/[#&](access_token=|type=recovery|error=|error_code=|error_description=)/.test(hash)) {
    location.replace('/index.html' + hash);
    return;
  }

  var root = document.documentElement;
  root.classList.add('js');
  var A = window.AkisMascot, C = window.AuthClient;
  var $ = function (id) { return document.getElementById(id); };
  function tr(key) { return typeof window.t === 'function' ? window.t(key) : key; }
  function syncLang() { if (window.languageStore) root.lang = window.languageStore.getUILanguage(); }
  syncLang();
  if (window.applyStaticTranslations) window.applyStaticTranslations(document);
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var el = {
    form: $('apForm'), email: $('apEmail'), pw: $('apPw'), pw2: $('apPw2'), pwField: $('pwField'), pw2Field: $('pw2Field'),
    hint: $('pwHint'), toggle: $('pwToggle'), remember: $('apRemember'), rememberRow: $('rememberRow'), msg: $('apMsg'),
    submit: $('apSubmit'), title: $('apTitle'), sub: $('apSub'), tabs: $('apTabs'), tabLogin: $('tabLogin'), tabSignup: $('tabSignup'),
    forgot: $('forgotLink'), backLogin: $('backLogin'),
    name: $('apName'), nameField: $('nameField'), oauth: $('oauthBlock'), google: $('googleBtn'), captcha: $('cfTurnstile'), resendBox: $('resendBox'), resendBtn: $('resendBtn')
  };

  var params = new URLSearchParams(location.search);
  var next = C.safeNext(params.get('next'));
  var MODES = ['login', 'signup', 'forgot'];
  var mode = MODES.indexOf(params.get('mode')) >= 0 ? params.get('mode') : 'login';

  // ------------------------------------------------------------------ Akis
  var mk = null, bubble = null, idleTimer = 0, busy = false, pwFocus = false, msgKey = '', sayKey = '';
  if (A) {
    mk = A.create({ size: '100%', variant: 'full', state: 'wave', track: true });
    $('stageAkis').appendChild(mk.el);
    bubble = A.createBubble();
    bubble.el.removeAttribute('role'); bubble.el.removeAttribute('aria-live'); // vùng thông báo thật là #apMsg
    $('stageBubble').appendChild(bubble.el);
  }
  function state(s) { if (mk) mk.setState(s); }
  function say(key, ms) { sayKey = key; if (bubble) bubble.say(key ? tr(key) : '', ms); }
  function settle(ms) { clearTimeout(idleTimer); idleTimer = setTimeout(function () { if (!busy) refreshState(); }, ms); }
  function refreshState() {
    if (pwFocus && el.pw.type === 'password') state('hide-eyes');
    else if (document.activeElement === el.email) state('type-email');
    else state('idle');
  }

  function showMsg(key, kind) {
    msgKey = key || '';
    el.msg.textContent = key ? tr(key) : '';
    el.msg.className = 'msg' + (kind ? ' ' + kind : '');
  }
  function bind(node, key) { node.setAttribute('data-i18n', key); node.textContent = tr(key); }

  // ------------------------------------------------------------------ chế độ
  function setMode(next_, focus) {
    mode = next_;
    var signup = mode === 'signup', forgot = mode === 'forgot';
    showMsg('');
    bind(el.title, 'ap.title.' + mode);
    bind(el.sub, 'ap.sub.' + mode);
    bind(el.submit, 'ap.submit.' + mode);
    el.tabs.hidden = forgot;
    [el.tabLogin, el.tabSignup].forEach(function (b) {
      var on = b.getAttribute('data-mode') === mode;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on || (forgot && b === el.tabLogin) ? 0 : -1;
    });
    el.pwField.hidden = forgot; el.pw.required = !forgot;
    el.pw2Field.hidden = !signup; el.hint.hidden = !signup;
    el.nameField.hidden = !signup; el.oauth.hidden = forgot;
    el.resendBox.hidden = true;
    el.rememberRow.hidden = forgot;
    el.pw.autocomplete = signup ? 'new-password' : 'current-password';
    el.forgot.hidden = mode !== 'login'; el.backLogin.hidden = !forgot;
    [el.email, el.pw, el.pw2].forEach(function (i) { i.removeAttribute('aria-invalid'); });

    var q = new URLSearchParams();
    if (mode !== 'login') q.set('mode', mode);
    if (params.get('next')) q.set('next', next);
    history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q.toString() : ''));

    state('wave'); say('ap.say.' + mode, 4200); settle(reduce ? 400 : 1800);
    if (focus) el.email.focus();
  }

  [el.tabLogin, el.tabSignup].forEach(function (b) {
    b.addEventListener('click', function () { setMode(b.getAttribute('data-mode'), true); });
    b.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
      e.preventDefault();
      var target = (e.key === 'ArrowLeft' || e.key === 'Home') ? el.tabLogin : el.tabSignup;
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') target = b === el.tabLogin ? el.tabSignup : el.tabLogin;
      target.focus(); setMode(target.getAttribute('data-mode'), false);
    });
  });
  el.forgot.addEventListener('click', function () { setMode('forgot', true); });
  el.backLogin.addEventListener('click', function () { setMode('login', true); });

  // ------------------------------------------------------------------ Google (server lo PKCE; trang chỉ điều hướng)
  function syncGoogle() { el.google.href = C.googleUrl(next, el.remember.checked); }
  syncGoogle();
  el.remember.addEventListener('change', syncGoogle);
  el.google.addEventListener('click', function () {
    syncGoogle();
    el.google.setAttribute('aria-disabled', 'true');
    state('wave'); say('ap.say.google', 3000);
  });
  // Nhấn Back từ Google (bfcache) quay lại: mở khóa nút.
  window.addEventListener('pageshow', function () { el.google.removeAttribute('aria-disabled'); });

  // ------------------------------------------------------------------ Cloudflare Turnstile (captcha)
  // Script tải động (không đặt thẻ <script> ngoại lai trong HTML; CSP cho phép script-src + frame-src challenges.cloudflare.com).
  // Token dùng 1 LẦN: sau mỗi lần gửi luôn reset. Không tải được script (bị chặn/mất mạng): không chặn ở client — server mới
  // là nơi quyết định (đã bật secret => từ chối kèm thông báo rõ ràng).
  var TS_SITEKEY = el.captcha ? el.captcha.getAttribute('data-sitekey') : '';
  var tsId = null, tsToken = '';
  function tsReset() {
    tsToken = '';
    try { if (tsId !== null && window.turnstile) window.turnstile.reset(tsId); } catch (_) { /* widget đã bị gỡ */ }
  }
  function tsRender() {
    if (tsId !== null || !window.turnstile || !TS_SITEKEY) return;
    var lang = window.languageStore && window.languageStore.getUILanguage ? window.languageStore.getUILanguage() : 'vi';
    tsId = window.turnstile.render(el.captcha, {
      sitekey: TS_SITEKEY,
      action: el.captcha.getAttribute('data-action') || 'auth',
      theme: 'auto',
      size: 'flexible',
      language: lang === 'en' ? 'en' : 'vi',
      callback: function (t) { tsToken = t; },
      'expired-callback': function () { tsToken = ''; },
      'timeout-callback': function () { tsToken = ''; },
      'error-callback': function () { tsToken = ''; }
    });
  }
  if (TS_SITEKEY) {
    var tsScript = document.createElement('script');
    tsScript.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    tsScript.async = true; tsScript.defer = true;
    tsScript.onload = tsRender;
    document.head.appendChild(tsScript);
  }

  // ------------------------------------------------------------------ Akis phản ứng khi nhập
  el.email.addEventListener('focus', function () { if (busy) return; state('type-email'); say('ap.say.email', 3500); });
  el.email.addEventListener('input', function () { if (mk) mk.lookAt(-0.9 + Math.min(el.email.value.length, 28) / 28 * 1.8, 0.7); });
  el.email.addEventListener('blur', function () { if (!busy) { if (mk) mk.lookAt(0, 0); refreshState(); } });
  [el.pw, el.pw2].forEach(function (i) {
    i.addEventListener('focus', function () { pwFocus = true; if (busy) return; refreshState(); say(i === el.pw ? 'ap.say.pw' : 'ap.say.pw2', 3500); });
    i.addEventListener('blur', function () { pwFocus = false; if (!busy) refreshState(); });
  });
  el.toggle.addEventListener('click', function () {
    var show = el.pw.type === 'password';
    el.pw.type = show ? 'text' : 'password';
    el.toggle.setAttribute('aria-pressed', String(show));
    bind(el.toggle, show ? 'ap.pw.hide' : 'ap.pw.show');
    el.toggle.setAttribute('data-i18n-aria-label', show ? 'ap.pw.hideAria' : 'ap.pw.showAria');
    el.toggle.setAttribute('aria-label', tr(show ? 'ap.pw.hideAria' : 'ap.pw.showAria'));
    if (!busy) refreshState();
  });

  // ------------------------------------------------------------------ gửi form
  function setBusy(on) {
    busy = on;
    el.submit.disabled = on;
    el.submit.setAttribute('aria-busy', String(on));
    bind(el.submit, on ? 'ap.busy' : 'ap.submit.' + mode);
  }
  function fail(key, field) {
    showMsg(key, 'err');
    if (field) { field.setAttribute('aria-invalid', 'true'); field.focus(); }
    state('error'); say('ap.say.err', 3600); settle(reduce ? 400 : 1800);
  }
  function enterApp(msg) {
    showMsg(msg || 'ap.ok.enter', 'ok');
    state('success'); say('ap.say.ok', 2000);
    setTimeout(function () { location.replace(next); }, reduce ? 250 : 950);
  }

  async function submit() {
    [el.email, el.pw, el.pw2, el.name].forEach(function (i) { i.removeAttribute('aria-invalid'); });
    var email = el.email.value.trim(), pw = el.pw.value, pw2 = el.pw2.value;
    if (!C.isEmail(email)) return fail('ap.v.email', el.email);
    if (mode !== 'forgot') {
      if (!pw) return fail('ap.v.pwEmpty', el.pw);
      if (mode === 'signup') {
        if (el.name.value.trim().length > 60) return fail('ap.v.name', el.name);
        if (!C.isStrongPassword(pw)) return fail('ap.v.pwWeak', el.pw);
        if (pw !== pw2) return fail('ap.v.mismatch', el.pw2);
      }
    }
    if (tsId !== null && !tsToken) return fail('ap.err.captcha_required', null);
    var token = tsToken; tsReset();
    setBusy(true); showMsg(mode === 'login' ? '' : 'ap.pow'); state('working'); say('ap.say.working');
    var r;
    try {
      if (mode === 'login') r = await C.login(email, pw, el.remember.checked, token);
      else if (mode === 'signup') r = await C.signup(email, pw, pw2, el.remember.checked, el.name.value.trim(), token);
      else r = await C.forgot(email, token);
    } catch (err) {
      setBusy(false);
      return fail(err && err.json ? C.errorKey(err.json) : 'ap.err.network', null);
    }
    setBusy(false);
    var j = r.json || {};
    if (r.ok) {
      if (mode === 'forgot') { showMsg('ap.ok.forgot', 'ok'); state('success'); say('ap.say.pending', 4000); settle(2200); return; }
      if (mode === 'signup' && j.status !== 'authenticated') { showMsg('ap.ok.pending', 'ok'); state('success'); say('ap.say.pending', 5000); showResend(email); settle(2400); return; }
      return enterApp('ap.ok.enter');
    }
    var key = j.code ? C.errorKey(j) : (r.status === 429 ? 'ap.err.auth_rate_limited' : 'ap.err.generic');
    var field = /password|credentials/.test(String(j.code || '')) ? el.pw : (/email/.test(String(j.code || '')) ? el.email : null);
    if (j.code === 'email_not_confirmed') showResend(email);
    fail(key, field);
  }
  el.form.addEventListener('submit', function (e) { e.preventDefault(); if (!busy) submit(); });

  // ------------------------------------------------------------------ Gửi lại email xác minh (supabase.auth.resend type=signup)
  // Hiện sau khi đăng ký, hoặc khi đăng nhập báo "email chưa xác nhận". Có đếm ngược 60 giây (GoTrue giới hạn 1 thư/60s).
  var resendEmail = '', resendTimer = 0;
  function startResendCooldown(sec) {
    clearInterval(resendTimer);
    var left = sec;
    el.resendBtn.disabled = true;
    function paint() { el.resendBtn.textContent = tr('ap.resend') + ' (' + left + 's)'; }
    paint();
    resendTimer = setInterval(function () {
      left -= 1;
      if (left <= 0) { clearInterval(resendTimer); el.resendBtn.disabled = false; el.resendBtn.textContent = tr('ap.resend'); } else paint();
    }, 1000);
  }
  function showResend(email) { resendEmail = email; el.resendBox.hidden = false; startResendCooldown(60); }
  el.resendBtn.addEventListener('click', async function () {
    if (!resendEmail || busy) return;
    if (tsId !== null && !tsToken) return fail('ap.err.captcha_required', null);
    var token = tsToken; tsReset();
    setBusy(true); showMsg('ap.pow');
    try {
      var r = await C.resend(resendEmail, token);
      setBusy(false);
      if (r.ok) { showMsg('ap.ok.resent', 'ok'); state('success'); say('ap.say.pending', 4000); startResendCooldown(60); return; }
      var j = r.json || {};
      if (j.code === 'resend_rate_limited') startResendCooldown(60);
      fail(j.code ? C.errorKey(j) : 'ap.err.generic', null);
    } catch (err) {
      setBusy(false);
      fail(err && err.json ? C.errorKey(err.json) : 'ap.err.network', null);
    }
  });

  // ------------------------------------------------------------------ ngôn ngữ
  var langBtn = $('langBtn');
  if (langBtn && window.languageStore) {
    langBtn.addEventListener('click', function () {
      window.languageStore.setUILanguage(window.languageStore.getUILanguage() === 'vi' ? 'en' : 'vi');
    });
    window.languageStore.subscribe(function () {
      syncLang();
      if (msgKey) el.msg.textContent = tr(msgKey);
      el.toggle.setAttribute('aria-label', tr(el.pw.type === 'password' ? 'ap.pw.showAria' : 'ap.pw.hideAria'));
      if (sayKey && bubble) bubble.say(tr(sayKey), 3000);
    });
  }

  // ------------------------------------------------------------------ đã đăng nhập thì vào thẳng app
  C.session().then(function (r) {
    var s = r.json && r.json.status;
    if (s === 'authenticated' || s === 'disabled') location.replace(next);
    else if (s === 'unconfigured') showMsg('ap.err.auth_not_configured', 'err');
    else if (s === 'unavailable') showMsg('ap.err.auth_unavailable', 'err');
  }).catch(function () { /* mạng lỗi: vẫn cho nhập, lỗi cụ thể sẽ hiện khi gửi */ });

  setMode(mode, false);

  // Quay lại từ /api/auth/callback khi đăng nhập Google lỗi/hủy: chỉ nhận 2 giá trị trong danh sách trắng (setMode đã dọn URL).
  var oauthErr = params.get('oauth_error');
  if (oauthErr === 'failed' || oauthErr === 'cancelled') fail('ap.err.oauth_' + oauthErr, null);
})();
