'use strict';

/* =====================================================================================
   backgroundTaskUI.js — PHẦN BG: bảng theo dõi tác vụ AI chạy nền + badge + toast +
   browser notification.

   NGUYÊN TẮC (mục 6/24/25/26/39/40 của yêu cầu):
     - Module này là OBSERVER THUẦN TUÝ. Nó KHÔNG BAO GIỜ abort/huỷ/reset task.
     - Ngoại lệ DUY NHẤT: người dùng bấm đúng nút "Dừng" của 1 task trong panel
       (hành động chủ động) -> conversationTaskManager.abortTask(requestId).
     - Đóng popup = chỉ đóng popup. Ẩn tab = chỉ đổi nhãn hiển thị.

   Nguồn dữ liệu DUY NHẤT: window.conversationTaskManager (subscribeAll + các getter).
   Cầu nối tới app: window.appTaskBridge { isViewing, openConversation, getConversationTitle }.
   Module vẫn chạy được nếu bridge chưa sẵn sàng (chỉ mất khả năng nhảy tới conversation).
   ===================================================================================== */

(function () {
  const NOTIFY_PREF_KEY = 'trogiai.notifyOnDone';
  const RENDER_THROTTLE_MS = 300;   // mục 43: không render lại panel theo từng delta
  const SYNC_THROTTLE_MS = 400;     // mục 12: debounce visibilitychange/focus
  const TOAST_TTL_MS = 7000;

  const ctm = () => window.conversationTaskManager;
  const bridge = () => window.appTaskBridge || null;
  const tr = (key, vars) => (window.t ? window.t(key, vars) : key);

  let panelEl = null, btnEl = null, badgeEl = null, listEl = null, emptyEl = null;
  let notifyToggleEl = null, notifyHintEl = null, toastHostEl = null, closeBtnEl = null;
  let renderTimer = null, syncTimer = null, tickTimer = null;
  let panelOpen = false;
  let lastFocusedBeforePanel = null;

  /* ---------------- tiện ích ---------------- */
  function el(id) { return document.getElementById(id); }
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function shorten(s, n) {
    const clean = String(s || '').replace(/\s+/g, ' ').trim();
    if (!clean) return '';
    return clean.length > n ? clean.slice(0, n - 1) + '…' : clean;
  }
  function fmtDuration(ms) {
    const s = Math.max(0, Math.round((ms || 0) / 100) / 10);
    if (s < 60) return tr('background.seconds', { n: s.toFixed(1) });
    const m = Math.floor(s / 60);
    const rest = Math.round(s - m * 60);
    return tr('background.minutes', { m, s: rest });
  }
  function notifyPrefEnabled() {
    try { return localStorage.getItem(NOTIFY_PREF_KEY) === '1'; } catch (e) { return false; }
  }
  function setNotifyPref(on) {
    try { localStorage.setItem(NOTIFY_PREF_KEY, on ? '1' : '0'); } catch (e) { /* ignore */ }
  }
  function notificationsSupported() { return typeof window.Notification !== 'undefined'; }

  /* ---------------- trạng thái -> nhãn hiển thị ---------------- */
  function statusLabel(task) {
    const S = ctm() ? ctm().STATUS : {};
    switch (task.status) {
      case S.QUEUED: return tr('background.queued');
      case S.RUNNING: return task.backgrounded ? tr('background.runningInBackground') : tr('background.running');
      case S.RECOVERING: return tr('background.recovering');
      case S.COMPLETED: return tr('background.completed');
      case S.FAILED: return tr('background.failed');
      case S.CANCELLED: return tr('background.cancelled');
      case S.INTERRUPTED: return tr('background.interrupted');
      default: return task.status || '';
    }
  }
  function statusClass(task) {
    const S = ctm() ? ctm().STATUS : {};
    if (task.status === S.COMPLETED) return 'is-done';
    if (task.status === S.FAILED) return 'is-failed';
    if (task.status === S.CANCELLED || task.status === S.INTERRUPTED) return 'is-stopped';
    if (task.status === S.QUEUED) return 'is-queued';
    if (task.status === S.RECOVERING) return 'is-recovering';
    return 'is-running';
  }
  function isActive(task) {
    return !!(ctm() && ctm().ACTIVE_STATUSES.indexOf(task.status) >= 0);
  }
  function convLabel(task) {
    const b = bridge();
    const fromApp = b && typeof b.getConversationTitle === 'function' ? b.getConversationTitle(task.conversationId) : '';
    return shorten(fromApp || task.title || tr('chat.newChatTitle'), 38);
  }

  /* ---------------- badge trên topbar ---------------- */
  function refreshBadge() {
    if (!btnEl || !ctm()) return;
    const running = ctm().getBackgroundTaskCount();
    const unseen = ctm().getUnseenCount();
    const total = running + unseen;
    btnEl.classList.toggle('has-running', running > 0);
    btnEl.classList.toggle('has-unseen', unseen > 0);
    btnEl.style.display = (total > 0 || panelOpen) ? '' : 'none';
    if (badgeEl) {
      badgeEl.textContent = total ? String(total) : '';
      badgeEl.style.display = total ? '' : 'none';
    }
    // Accessibility (mục 34): trạng thái KHÔNG chỉ dựa vào màu/chấm — luôn có text đọc được.
    const label = running
      ? tr('background.badgeRunning', { n: running })
      : (unseen ? tr('background.badgeUnseen', { n: unseen }) : tr('background.title'));
    btnEl.setAttribute('aria-label', label);
    btnEl.title = label;
    const srEl = btnEl.querySelector('.bgtask-sr');
    if (srEl) srEl.textContent = label;
  }

  /* ---------------- danh sách task trong panel ---------------- */
  function taskRow(task) {
    const li = document.createElement('li');
    li.className = 'bgtask-item ' + statusClass(task) + (task.seen ? '' : ' is-unseen');
    li.dataset.requestId = task.requestId;
    const elapsed = (task.completedAt || Date.now()) - task.startedAt;
    const stageLabel = task.stage === 'detail' ? tr('background.stageDetail')
      : (task.stage === 'approach' ? tr('background.stageApproach') : '');
    const bgNote = (!isActive(task) && task.backgroundMs > 1000)
      ? tr('background.ranInBackground', { d: fmtDuration(task.backgroundMs) })
      : (task.backgrounded ? tr('background.hiddenTabNote') : '');

    li.innerHTML = `
      <div class="bgtask-row-head">
        <span class="bgtask-dot" aria-hidden="true"></span>
        <span class="bgtask-conv">${escapeHtml(convLabel(task))}</span>
        ${stageLabel ? `<span class="bgtask-stage">${escapeHtml(stageLabel)}</span>` : ''}
        <span class="bgtask-status">${escapeHtml(statusLabel(task))}</span>
      </div>
      <div class="bgtask-query">${escapeHtml(shorten(task.query, 110) || tr('background.noQuery'))}</div>
      <div class="bgtask-meta">
        <span>${escapeHtml(fmtDuration(elapsed))}</span>
        ${task.textLength ? `<span>${escapeHtml(tr('background.chars', { n: task.textLength }))}</span>` : ''}
        ${task.provider ? `<span>${escapeHtml(task.provider)}</span>` : ''}
      </div>
      ${task.statusMessage ? `<div class="bgtask-progress">${escapeHtml(shorten(task.statusMessage, 90))}</div>` : ''}
      ${bgNote ? `<div class="bgtask-bgnote">${escapeHtml(bgNote)}</div>` : ''}
      ${task.error ? `<div class="bgtask-error">${escapeHtml(shorten(task.error, 140))}</div>` : ''}
      <div class="bgtask-actions"></div>
    `;

    const actions = li.querySelector('.bgtask-actions');
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'bgtask-act';
    openBtn.textContent = tr('background.open');
    openBtn.onclick = () => openConversation(task);
    actions.appendChild(openBtn);

    if (isActive(task) && !task.remote) {
      const stopBtn = document.createElement('button');
      stopBtn.type = 'button';
      stopBtn.className = 'bgtask-act bgtask-act--stop';
      stopBtn.textContent = tr('chat.stop');
      // Đây là hành động DỪNG CHỦ ĐỘNG duy nhất của module này (mục 24).
      stopBtn.onclick = () => { if (ctm()) ctm().abortTask(task.requestId); };
      actions.appendChild(stopBtn);
    } else if (!task.remote) {
      // PHẦN BG/21: task bị cắt giữa chừng ở phiên trước -> HỎI LẠI server (không giải lại).
      if (ctm() && task.status === ctm().STATUS.INTERRUPTED) {
        const recBtn = document.createElement('button');
        recBtn.type = 'button';
        recBtn.className = 'bgtask-act bgtask-act--recover';
        recBtn.textContent = tr('background.recover');
        recBtn.onclick = async () => {
          const b = bridge();
          if (!b || typeof b.recoverJob !== 'function') return;
          recBtn.disabled = true;
          recBtn.textContent = tr('background.recoverWorking');
          let out = null;
          try { out = await b.recoverJob(task.requestId); } catch (e) { out = null; }
          recBtn.disabled = false;
          if (out && out.ok) { recBtn.textContent = tr('background.recover'); scheduleRender(); return; }
          const reason = out && out.reason;
          recBtn.textContent = reason === 'still-running' ? tr('background.recoverRunning') : tr('background.recoverNotFound');
        };
        actions.appendChild(recBtn);
      }
      const rmBtn = document.createElement('button');
      rmBtn.type = 'button';
      rmBtn.className = 'bgtask-act bgtask-act--ghost';
      rmBtn.textContent = tr('background.dismiss');
      rmBtn.onclick = () => { if (ctm()) { ctm().removeCompletedTask(task.requestId); scheduleRender(); } };
      actions.appendChild(rmBtn);
    }
    return li;
  }

  function renderPanel() {
    if (!listEl || !ctm()) return;
    const local = ctm().getAllTasks();
    const remote = (ctm().getRemoteTasks ? ctm().getRemoteTasks() : []).map((t) => ({ ...t, remote: true }));
    const all = local.concat(remote);
    // Đang chạy lên đầu, rồi tới chưa xem, rồi theo thời gian cập nhật.
    all.sort((a, b) => {
      const aa = isActive(a) ? 0 : (a.seen ? 2 : 1);
      const bb = isActive(b) ? 0 : (b.seen ? 2 : 1);
      if (aa !== bb) return aa - bb;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
    listEl.innerHTML = '';
    all.forEach((task) => listEl.appendChild(taskRow(task)));
    if (emptyEl) emptyEl.style.display = all.length ? 'none' : '';
    refreshBadge();
    updateNotifyControls();
  }

  function scheduleRender() {
    refreshBadge();
    if (!panelOpen) return;       // panel đóng -> chỉ cần badge, khỏi dựng DOM (mục 43)
    if (renderTimer) return;
    renderTimer = setTimeout(() => { renderTimer = null; renderPanel(); }, RENDER_THROTTLE_MS);
  }

  /* ---------------- mở/đóng panel ---------------- */
  function openPanel() {
    if (!panelEl) return;
    panelOpen = true;
    lastFocusedBeforePanel = document.activeElement;
    panelEl.classList.add('open');
    panelEl.setAttribute('aria-hidden', 'false');
    if (btnEl) btnEl.setAttribute('aria-expanded', 'true');
    renderPanel();
    if (closeBtnEl) closeBtnEl.focus();
    startTicker();
  }
  // mục 25: đóng popup CHỈ đóng popup — không cancel task nào.
  function closePanel() {
    if (!panelEl) return;
    panelOpen = false;
    panelEl.classList.remove('open');
    panelEl.setAttribute('aria-hidden', 'true');
    if (btnEl) btnEl.setAttribute('aria-expanded', 'false');
    stopTicker();
    refreshBadge();
    if (lastFocusedBeforePanel && lastFocusedBeforePanel.isConnected) {
      try { lastFocusedBeforePanel.focus(); } catch (e) { /* ignore */ }
    }
    lastFocusedBeforePanel = null;
  }
  function togglePanel() { panelOpen ? closePanel() : openPanel(); }

  // Đồng hồ cập nhật "đã chạy N giây" khi panel mở — dừng hẳn khi đóng/tab ẩn (mục 31/43).
  function startTicker() {
    stopTicker();
    tickTimer = setInterval(() => { if (panelOpen && !document.hidden) renderPanel(); }, 1000);
  }
  function stopTicker() { if (tickTimer) { clearInterval(tickTimer); tickTimer = null; } }

  function openConversation(task) {
    const b = bridge();
    if (ctm()) { ctm().markAsSeen(task.requestId); ctm().markConversationSeen(task.conversationId); }
    if (b && typeof b.openConversation === 'function') b.openConversation(task.conversationId);
    closePanel();
    scheduleRender();
  }

  /* ---------------- tuỳ chọn thông báo ---------------- */
  function updateNotifyControls() {
    if (!notifyToggleEl) return;
    const supported = notificationsSupported();
    const perm = supported ? Notification.permission : 'unsupported';
    notifyToggleEl.checked = notifyPrefEnabled() && perm === 'granted';
    notifyToggleEl.disabled = !supported || perm === 'denied';
    if (notifyHintEl) {
      let hint = '';
      if (!supported) hint = tr('background.notifyUnsupported');
      else if (perm === 'denied') hint = tr('background.notifyDenied');
      else if (perm !== 'granted' && notifyPrefEnabled()) hint = tr('background.notifyNeedPermission');
      notifyHintEl.textContent = hint;
      notifyHintEl.style.display = hint ? '' : 'none';
    }
  }
  // mục 13: CHỈ xin quyền sau user gesture (bấm vào ô tuỳ chọn), không tự xin lúc load trang.
  async function onNotifyToggle() {
    if (!notifyToggleEl) return;
    if (!notifyToggleEl.checked) { setNotifyPref(false); updateNotifyControls(); return; }
    if (!notificationsSupported()) { setNotifyPref(false); updateNotifyControls(); return; }
    let perm = Notification.permission;
    if (perm === 'default') {
      try { perm = await Notification.requestPermission(); } catch (e) { perm = 'denied'; }
    }
    setNotifyPref(perm === 'granted');
    updateNotifyControls();
  }

  /* ---------------- toast trong app ---------------- */
  function showToast(task, kind) {
    if (!toastHostEl) return;
    const node = document.createElement('div');
    node.className = 'app-toast ' + (kind === 'error' ? 'app-toast--error' : 'app-toast--ok');
    node.setAttribute('role', 'status');
    node.innerHTML = `
      <div class="app-toast-main">
        <div class="app-toast-title">${escapeHtml(kind === 'error' ? tr('background.toastFailed') : tr('background.toastDone'))}</div>
        <div class="app-toast-sub">${escapeHtml(shorten(task.query || convLabel(task), 72))}</div>
      </div>
      <button type="button" class="app-toast-act">${escapeHtml(tr('background.viewAnswer'))}</button>
      <button type="button" class="app-toast-close" aria-label="${escapeHtml(tr('action.close'))}">✕</button>
    `;
    const remove = () => { if (node.isConnected) { node.classList.add('leaving'); setTimeout(() => node.remove(), 200); } };
    node.querySelector('.app-toast-act').onclick = () => { openConversation(task); remove(); };
    node.querySelector('.app-toast-close').onclick = remove;
    toastHostEl.appendChild(node);
    setTimeout(remove, TOAST_TTL_MS);
  }

  /* ---------------- browser notification ---------------- */
  function maybeNotify(task, kind) {
    // mục 14/32: chỉ 1 lần/1 task, chỉ cho chuyển trạng thái kết thúc thật.
    if (!ctm() || task.notified) return;
    if (!ctm().markNotified(task.requestId)) return;

    const viewingHere = bridge() && typeof bridge().isViewing === 'function' && bridge().isViewing(task.conversationId);
    const hidden = document.hidden || !document.hasFocus();

    // Toast: bỏ qua nếu người dùng đang nhìn đúng conversation đó với tab đang hiện (mục 15).
    if (!(viewingHere && !hidden)) showToast(task, kind);

    if (!hidden) return;                       // tab đang hiện -> toast là đủ
    if (!notificationsSupported()) return;     // fallback toast/badge (mục 13)
    if (!notifyPrefEnabled() || Notification.permission !== 'granted') return;

    try {
      const n = new Notification(tr('background.notificationTitle'), {
        body: kind === 'error'
          ? tr('background.notificationBodyFailed')
          : tr('background.notificationBody', { q: shorten(task.query, 60) || convLabel(task) }),
        tag: 'trogiai-task-' + task.requestId,
        icon: '/favicon.svg'
      });
      n.onclick = () => {
        try { window.focus(); } catch (e) { /* ignore */ }
        openConversation(task);
        n.close();
      };
    } catch (e) { /* Notification có thể ném trên 1 số trình duyệt/iOS — không được crash */ }
  }

  /* ---------------- đồng bộ khi quay lại tab ---------------- */
  function syncNow() {
    if (!ctm()) return;
    ctm().setUiHidden(document.hidden); // CHỈ đổi nhãn — không abort (mục 6)
    refreshBadge();
    if (panelOpen) renderPanel();
    const b = bridge();
    if (b && typeof b.syncActiveConversation === 'function') b.syncActiveConversation();
  }
  function scheduleSync() {
    if (syncTimer) return;
    syncTimer = setTimeout(() => { syncTimer = null; syncNow(); }, SYNC_THROTTLE_MS);
  }

  /* ---------------- kéo–thả popup (chỉ desktop, không bắt buộc để dùng) ---------------- */
  // Kéo bằng thanh tiêu đề. Bỏ qua trên màn hình hẹp (ở đó panel là bottom sheet) và khi người dùng
  // bấm đúng nút Đóng. Vị trí KHÔNG lưu lại giữa các phiên — tránh trường hợp panel "biến mất"
  // ngoài khung nhìn sau khi đổi kích thước cửa sổ/màn hình.
  function enableDrag() {
    if (!panelEl) return;
    const head = panelEl.querySelector ? panelEl.querySelector('.rec-head') : null;
    if (!head || !head.addEventListener) return;
    let dragging = false;
    let startX = 0, startY = 0, baseLeft = 0, baseTop = 0;

    const onMove = (e) => {
      if (!dragging) return;
      const vw = window.innerWidth || 1024;
      const vh = window.innerHeight || 768;
      const w = (panelEl.offsetWidth || 330);
      const h = (panelEl.offsetHeight || 320);
      const left = Math.min(Math.max(0, baseLeft + (e.clientX - startX)), Math.max(0, vw - w));
      const top = Math.min(Math.max(0, baseTop + (e.clientY - startY)), Math.max(0, vh - 44));
      panelEl.style.left = left + 'px';
      panelEl.style.top = top + 'px';
      panelEl.style.right = 'auto';
      panelEl.style.bottom = 'auto';
      if (e.preventDefault) e.preventDefault();
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      panelEl.classList.remove('dragging');
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    head.addEventListener('pointerdown', (e) => {
      if ((window.innerWidth || 1024) <= 760) return;      // mobile: bottom sheet, không kéo
      if (e.target && e.target.closest && e.target.closest('.rec-close')) return;
      const rect = panelEl.getBoundingClientRect ? panelEl.getBoundingClientRect() : null;
      if (!rect) return;
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      baseLeft = rect.left; baseTop = rect.top;
      panelEl.classList.add('dragging');
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });
  }

  /* ---------------- khởi tạo ---------------- */
  function init() {
    panelEl = el('bgTaskPanel');
    btnEl = el('bgTaskBtn');
    badgeEl = el('bgTaskBadge');
    listEl = el('bgTaskList');
    emptyEl = el('bgTaskEmpty');
    notifyToggleEl = el('bgTaskNotifyToggle');
    notifyHintEl = el('bgTaskNotifyHint');
    closeBtnEl = el('bgTaskCloseBtn');
    toastHostEl = el('toastHost');
    if (!panelEl || !btnEl) return; // HTML chưa có -> không crash, app vẫn chạy bình thường

    btnEl.addEventListener('click', togglePanel);
    if (closeBtnEl) closeBtnEl.addEventListener('click', closePanel);
    if (notifyToggleEl) notifyToggleEl.addEventListener('change', onNotifyToggle);

    // Esc đóng panel; click ra ngoài đóng panel. Cả 2 KHÔNG đụng tới task (mục 25).
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && panelOpen) closePanel(); });
    document.addEventListener('click', (e) => {
      if (!panelOpen) return;
      if (panelEl.contains(e.target) || btnEl.contains(e.target)) return;
      closePanel();
    });

    if (ctm()) {
      ctm().subscribeAll((ev) => {
        if (ev.type === 'done') maybeNotify(ev.task, 'done');
        else if (ev.type === 'error') maybeNotify(ev.task, 'error');
        // 'cancelled' KHÔNG notify (người dùng tự bấm Dừng — mục 32).
        scheduleRender();
      });
      ctm().setUiHidden(document.hidden);
    }

    // mục 12: chỉ đồng bộ UI, có debounce. KHÔNG gọi API, KHÔNG abort.
    document.addEventListener('visibilitychange', scheduleSync);
    window.addEventListener('focus', scheduleSync);
    window.addEventListener('blur', scheduleSync);

    enableDrag();

    if (window.languageStore && typeof window.languageStore.subscribe === 'function') {
      window.languageStore.subscribe(() => { refreshBadge(); if (panelOpen) renderPanel(); });
    }

    refreshBadge();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // Expose cho app.js/test (không bắt buộc dùng).
  window.backgroundTaskUI = {
    open: openPanel, close: closePanel, toggle: togglePanel,
    refresh: () => { refreshBadge(); if (panelOpen) renderPanel(); },
    isOpen: () => panelOpen,
    notifyPrefEnabled
  };
})();
