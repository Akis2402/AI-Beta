'use strict';

/* =====================================================================================
   puterAuthUI.js — Giao diện Auth Puter.js: mục trong Settings + popup thông báo lần đầu + CTA trên
   thẻ hình AI. CHỈ ĐỌC canonical auth state của puterAdapter.auth (không tự kiểm tra riêng) và
   CHỈ gọi auth.signIn() từ sự kiện click THẬT của người dùng vào nút trong Settings.

   Luồng (Master prompt Puter Auth):
     tải trang -> auth.init() (nạp SDK + isSignedIn(), KHÔNG popup) -> (chưa Auth & chưa tắt hôm nay)
     popup THÔNG BÁO (không phải popup Auth) -> người dùng mở Settings -> bấm [Auth Puter.js]
     -> cửa sổ Auth của Puter -> thành công -> state = authenticated -> hình AI dùng được, KHÔNG reload.

   Popup thông báo có 2 kiểu tắt:
     • "Đã hiểu" (một lần): lần tải trang sau có thể hiện lại.
     • "Không hiển thị lại hôm nay": lưu dismissedUntilDate = YYYY-MM-DD theo NGÀY LỊCH của múi giờ
       trình duyệt (không phải mốc 24 giờ cứng) — sang ngày mới thì hiện lại.
   Không bao giờ hiện lại giữa chừng một lần tải trang (SSE reconnect/re-render không kích hoạt lại).
   ===================================================================================== */
(function installPuterAuthUI(global) {
  const doc = global.document;
  const DISMISS_KEY = 'tro-giai:puter-notice-dismissed-until';
  const NOTICE_DELAY_MS = 1200;
  const tr = (k, v) => (typeof global.t === 'function' ? global.t(k, v) : k);
  const auth = () => (global.puterAdapter && global.puterAdapter.auth) || null;
  let noticeShownThisPage = false;
  let noticeEl = null;
  let memoryDismissedUntil = null; // dự phòng khi localStorage bị chặn (private mode)

  // ---------------------------------------------------------------- Chính sách ngày (thuần hàm)
  function localDateKey(d) {
    const x = d instanceof Date ? d : new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
  }
  function readDismissedUntil() {
    try {
      const v = global.localStorage.getItem(DISMISS_KEY);
      if (/^\d{4}-\d{2}-\d{2}$/.test(v || '')) return v;
    } catch (_) { /* storage bị chặn */ }
    return memoryDismissedUntil;
  }
  function writeDismissedUntil(key) {
    memoryDismissedUntil = key;
    try { global.localStorage.setItem(DISMISS_KEY, key); return true; } catch (_) { return false; }
  }
  function isDismissedForToday(now) {
    const until = readDismissedUntil();
    return !!until && localDateKey(now) <= until; // so sánh chuỗi ISO = so sánh ngày
  }
  function dismissForToday(now) { return writeDismissedUntil(localDateKey(now)); }
  function settingsOpen() {
    const o = doc && doc.getElementById('settingsOverlay');
    return !!(o && o.classList.contains('show'));
  }
  function shouldShowNotice(state, now) {
    return !!state && state.status === 'unauthenticated' && !noticeShownThisPage && !isDismissedForToday(now) && !settingsOpen();
  }

  // ---------------------------------------------------------------- Mở Settings tại mục Puter (KHÔNG Auth)
  function openSettingsAtPuter() {
    if (typeof global.openSettings === 'function') global.openSettings();
    else { const b = doc.getElementById('settingsBtnTop') || doc.getElementById('settingsBtnSide'); if (b) b.click(); }
    const sec = doc.getElementById('puterAuthSection');
    if (sec) {
      try { sec.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) { /* ignore */ }
      const btn = doc.getElementById('puterAuthBtn');
      if (btn && typeof btn.focus === 'function') btn.focus({ preventScroll: true });
    }
  }

  // ---------------------------------------------------------------- Mục Settings
  function helpKey(st) {
    if (st.busy) return 'puter.busy';
    if (st.status === 'error' && st.errorCode === 'PUTER_SDK_UNAVAILABLE') return 'puter.err.sdk';
    if (st.status === 'error' && st.errorCode === 'PUTER_AUTH_FAILED') return 'puter.err.session';
    if (st.errorCode === 'PUTER_AUTH_FAILED' && st.errorMessage) return `puter.err.${['popup_blocked', 'auth_cancelled'].includes(st.errorMessage) ? st.errorMessage : 'auth_failed'}`;
    if (st.status === 'authenticated') return 'puter.authed.hint';
    return '';
  }
  function render(state) {
    const a = auth();
    const st = state || (a && a.getState());
    const root = doc.getElementById('puterAuthSection');
    if (!root || !st) return;
    root.setAttribute('data-status', st.status);
    const set = (id, fn) => { const n = doc.getElementById(id); if (n) fn(n); };
    set('puterAuthStatus', (n) => { n.textContent = tr(`puter.status.${st.status}`); n.setAttribute('data-status', st.status); });
    set('puterAuthUser', (n) => { const u = st.user && st.user.username; n.textContent = u && st.status === 'authenticated' ? `${tr('puter.user')} ${u}` : ''; n.hidden = !(u && st.status === 'authenticated'); });
    set('puterAuthBtn', (n) => { n.textContent = tr(st.status === 'authenticated' ? 'puter.btn.reauth' : 'puter.btn.auth'); n.disabled = !!st.busy; n.setAttribute('aria-busy', st.busy ? 'true' : 'false'); });
    set('puterSignOutBtn', (n) => { n.hidden = !(st.status === 'authenticated' && a && a.canSignOut()); n.disabled = !!st.busy; });
    set('puterRecheckBtn', (n) => { n.hidden = st.status !== 'error'; });
    set('puterAuthHelp', (n) => { const k = helpKey(st); n.textContent = k ? tr(k) : ''; n.hidden = !k; });
  }
  function bindSettings() {
    const a = auth();
    const authBtn = doc.getElementById('puterAuthBtn');
    // Click THẬT của người dùng là điều kiện bắt buộc (isTrusted) — puterAdapter từ chối mọi lời gọi khác.
    if (authBtn && !authBtn.__puterBound) { authBtn.__puterBound = true; authBtn.addEventListener('click', (ev) => { if (a) a.signIn({ event: ev }).catch(() => { /* trạng thái lỗi hiển thị qua render() */ }); }); }
    const so = doc.getElementById('puterSignOutBtn');
    if (so && !so.__puterBound) { so.__puterBound = true; so.addEventListener('click', () => { if (a) a.signOut().catch(() => {}); }); }
    const rc = doc.getElementById('puterRecheckBtn');
    if (rc && !rc.__puterBound) { rc.__puterBound = true; rc.addEventListener('click', () => { if (a) a.retryInit(); }); }
  }

  // ---------------------------------------------------------------- Popup thông báo lần đầu
  function hideNotice() {
    if (noticeEl && noticeEl.parentNode) noticeEl.parentNode.removeChild(noticeEl);
    noticeEl = null;
    doc.removeEventListener('keydown', onNoticeKey, true);
  }
  function onNoticeKey(ev) { if (ev.key === 'Escape' && noticeEl) hideNotice(); }
  function mkBtn(cls, key, onClick) {
    const b = doc.createElement('button');
    b.type = 'button'; b.className = cls; b.setAttribute('data-i18n', key); b.textContent = tr(key);
    b.addEventListener('click', onClick);
    return b;
  }
  function showNotice() {
    if (noticeEl || !doc || !doc.body) return false;
    noticeShownThisPage = true;
    const el = doc.createElement('div');
    el.id = 'puterAuthNotice'; el.className = 'puter-notice';
    el.setAttribute('role', 'dialog'); el.setAttribute('aria-labelledby', 'puterNoticeTitle'); el.setAttribute('aria-describedby', 'puterNoticeBody');
    const h = doc.createElement('div'); h.id = 'puterNoticeTitle'; h.className = 'puter-notice-title'; h.setAttribute('data-i18n', 'puter.notice.title'); h.textContent = tr('puter.notice.title');
    const p = doc.createElement('p'); p.id = 'puterNoticeBody'; p.className = 'puter-notice-body'; p.setAttribute('data-i18n', 'puter.notice.body'); p.textContent = tr('puter.notice.body');
    const row = doc.createElement('div'); row.className = 'puter-notice-actions';
    row.appendChild(mkBtn('puter-notice-btn primary', 'puter.notice.openSettings', () => { hideNotice(); openSettingsAtPuter(); }));
    row.appendChild(mkBtn('puter-notice-btn', 'puter.notice.close', () => hideNotice()));
    row.appendChild(mkBtn('puter-notice-btn subtle', 'puter.notice.dismissToday', () => { dismissForToday(new Date()); hideNotice(); }));
    el.appendChild(h); el.appendChild(p); el.appendChild(row);
    doc.body.appendChild(el);
    noticeEl = el;
    doc.addEventListener('keydown', onNoticeKey, true);
    return true;
  }

  // ---------------------------------------------------------------- Khởi tạo
  function onState(st) {
    render(st);
    if (st && st.status === 'authenticated') hideNotice();
  }
  function scheduleNotice() {
    global.setTimeout(() => {
      const a = auth();
      if (a && shouldShowNotice(a.getState(), new Date())) showNotice();
    }, NOTICE_DELAY_MS);
  }
  function init() {
    const a = auth();
    if (!a) return;
    bindSettings();
    a.subscribe(onState);
    render(a.getState());
    // Kiểm tra trạng thái lúc tải trang: nạp SDK + isSignedIn(). KHÔNG popup, KHÔNG throw.
    a.init().then(() => { onState(a.getState()); scheduleNotice(); });
    // Người dùng có thể Auth/đăng xuất ở tab khác -> đọc lại (đồng bộ, không popup) khi quay lại tab.
    if (global.languageStore && typeof global.languageStore.subscribe === 'function') global.languageStore.subscribe(() => render());
    global.addEventListener('focus', () => a.refresh());
    doc.addEventListener('visibilitychange', () => { if (!doc.hidden) a.refresh(); });
  }

  global.puterAuthUI = {
    DISMISS_KEY, localDateKey, isDismissedForToday, dismissForToday, shouldShowNotice,
    showNotice, hideNotice, render, openSettingsAtPuter, init,
    _debug: () => ({ noticeShownThisPage, noticeVisible: !!noticeEl })
  };
  if (doc) {
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init); else init();
  }
})(typeof window !== 'undefined' ? window : globalThis);
