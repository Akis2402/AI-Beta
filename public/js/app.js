'use strict';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const state = {
  docs: [],              // {id, name, ext, chunks:[{id,text}], included:true}
  rules: [],
  // Ghi chú KHÔNG lưu ở mảng riêng nữa — mỗi ghi chú gắn trực tiếp vào tin nhắn AI tương ứng
  // (msg.userNote / msg.userNoteAt trong conversations bên dưới), nhờ vậy luôn đồng bộ 1-1 với
  // đúng câu trả lời và tự động được lưu/khôi phục cùng cuộc trò chuyện, không cần đồng bộ 2 nơi.
  conversations: [],       // {id, title, createdAt, updatedAt, messages:[...]}
  currentConvId: null,
  history: [],             // {role, content:string} — ngữ cảnh gửi API cho cuộc trò chuyện hiện tại
  pendingImage: null,      // {mediaType, base64, url}
  deepThinking: false,     // "Suy nghĩ sâu" — AI tự phản biện/kiểm tra lại trong khối <thinking> nội bộ
  crossCheck: false,       // "Đối chiếu đa hướng" — giải 2 hướng độc lập rồi tổng hợp (chỉ áp dụng ở bước giải chi tiết)
  formulaSubject: 'toan',
  settings: { detail: 'tiêu chuẩn', lang: 'Tiếng Việt', school: 'thpt', grade: '10' }
};

let pendingTurn = null; // lượt hỏi đang chờ (đã có "Hướng giải", chưa bấm "Xem chi tiết")

const el = (id) => document.getElementById(id);
const threadEl = el('thread');
const statusEl = el('statusText');

/* ================= Gọi backend (KHÔNG bao giờ gọi Anthropic trực tiếp từ trình duyệt) ================= */
function apiHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (window.APP_CONFIG && window.APP_CONFIG.appKey) headers['x-app-key'] = window.APP_CONFIG.appKey;
  return headers;
}
async function apiPost(path, body) {
  const res = await fetch(path, { method: 'POST', headers: apiHeaders(), body: JSON.stringify(body) });
  let data;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok) {
    let msg = (data && data.error) || `Lỗi máy chủ (HTTP ${res.status}).`;
    // Khi TẤT CẢ nhà cung cấp AI đều lỗi, server trả kèm providerErrors (tên provider + lý do lỗi
    // cụ thể của từng nơi, vd "API key sai", "model không hợp lệ", "hết hạn mức"...) — nối luôn vào
    // thông báo để tự chẩn đoán ngay trên giao diện mà không cần vào xem log server.
    if (data && Array.isArray(data.providerErrors) && data.providerErrors.length) {
      msg += '\n' + data.providerErrors.map((p) => `• ${p.label}: ${p.error}`).join('\n');
    }
    throw new Error(msg);
  }
  return data;
}

/**
 * Gửi request streaming (SSE) tới backend — dùng cho hiệu ứng "gõ chữ" thời gian thực thay vì đợi
 * AI trả lời xong toàn bộ rồi mới hiển thị. callbacks:
 *   onDelta(text)   — gọi mỗi khi có 1 đoạn văn bản mới từ AI
 *   onStatus(msg)   — gọi khi server báo tiến trình (vd đang đối chiếu đa hướng ở chế độ Sâu, lúc
 *                     này chưa có delta nào để hiển thị)
 * Trả về Promise<object> = metadata cuối cùng từ sự kiện "done" (text đầy đủ, provider, crossChecked...).
 * Nếu trình duyệt không hỗ trợ ReadableStream (rất hiếm), hoặc server trả lỗi trước khi kịp mở
 * stream, tự động rơi về apiPost() thường (không streaming) để vẫn hoạt động được.
 */
async function apiPostStream(path, body, { onDelta, onStatus } = {}) {
  if (!window.ReadableStream || !window.TextDecoder) {
    const data = await apiPost(path, body);
    if (data && data.text && typeof onDelta === 'function') onDelta(data.text);
    return data;
  }

  const res = await fetch(path, { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ ...body, stream: true }) });
  if (!res.ok || !res.body) {
    // Server từ chối trước khi mở stream (lỗi validate, thiếu API key...) — đọc lỗi JSON thường.
    let data;
    try { data = await res.json(); } catch (e) { data = null; }
    let msg = (data && data.error) || `Lỗi máy chủ (HTTP ${res.status}).`;
    if (data && Array.isArray(data.providerErrors) && data.providerErrors.length) {
      msg += '\n' + data.providerErrors.map((p) => `• ${p.label}: ${p.error}`).join('\n');
    }
    throw new Error(msg);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let currentEvent = 'message';
  let doneData = null;
  let errorMsg = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (line === '') { currentEvent = 'message'; continue; }
      if (line.startsWith('event:')) { currentEvent = line.slice(6).trim(); continue; }
      if (!line.startsWith('data:')) continue;
      let payload;
      try { payload = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
      if (currentEvent === 'delta' && typeof onDelta === 'function') onDelta(payload.text || '');
      else if (currentEvent === 'status' && typeof onStatus === 'function') onStatus(payload.message || '');
      else if (currentEvent === 'done') doneData = payload;
      else if (currentEvent === 'error') errorMsg = payload.message || 'Có lỗi khi kết nối tới máy chủ AI.';
    }
  }

  if (errorMsg) throw new Error(errorMsg);
  if (!doneData) throw new Error('Kết nối streaming bị ngắt trước khi AI trả lời xong. Vui lòng thử lại.');
  return doneData;
}

/* ================= Icons (SVG) ================= */
const ICONS = {
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></svg>',
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="6.34" y2="6.34"/><line x1="17.66" y1="17.66" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="6.34" y2="17.66"/><line x1="17.66" y1="6.34" x2="19.07" y2="4.93"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
  zap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
  sparkles: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/></svg>',
  presentation: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
  cards: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
  note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="12" y2="17"/></svg>',
  compass: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>',
  outline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="16" x2="13" y2="16"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>',
  mindmap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="2.6"/><circle cx="4" cy="5" r="2"/><circle cx="4" cy="19" r="2"/><circle cx="20" cy="6.5" r="2"/><circle cx="20" cy="17.5" r="2"/><path d="M9.9 10.7 5.6 6.2M9.9 13.3l-4.3 4.5M14.1 10.7l3.9-3.6M14.1 13.3l3.9 3.6"/></svg>',
  zoomIn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>',
  zoomOut: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>',
  expand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>'
};
el('menuBtn').innerHTML = ICONS.menu;
el('settingsBtnTop').innerHTML = ICONS.settings;
el('flashcardTopBtn').innerHTML = ICONS.cards;
el('recommendTopBtn').innerHTML = ICONS.outline;
el('attachBtn').innerHTML = ICONS.camera;
el('settingsGearIcon').innerHTML = ICONS.settings;
document.querySelectorAll('.think-opt .ic').forEach((s) => { s.innerHTML = ICONS[s.dataset.icon]; });

/* ================= Lưu trữ cục bộ (localStorage — trang web độc lập, không dùng window.storage) ================= */
const LS_KEYS = {
  rules: 'tro-giai:rules', theme: 'tro-giai:theme', think: 'tro-giai:think-mode',
  deepThinking: 'tro-giai:deep-thinking', crossCheck: 'tro-giai:cross-check', settings: 'tro-giai:settings',
  notes: 'tro-giai:notes', conversations: 'tro-giai:conversations', currentConv: 'tro-giai:current-conv'
};
const MAX_STORED_CONVERSATIONS = 40;
function lsGet(key, fallback) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch (e) { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* localStorage có thể bị chặn/đầy — bỏ qua an toàn */ }
}
function loadAll() {
  state.rules = lsGet(LS_KEYS.rules, []);
  renderRules();
  applyTheme(lsGet(LS_KEYS.theme, 'light'));
  // Di chuyển dữ liệu cũ: trước đây chỉ có 1 chế độ "fast"/"deep" gộp chung — nếu người dùng đã
  // từng bật "deep" ở phiên bản cũ và chưa có lựa chọn mới nào được lưu, coi như bật cả 2 công tắc
  // (giữ đúng hành vi cũ họ đã quen) thay vì âm thầm reset về tắt hết.
  const legacyDeep = lsGet(LS_KEYS.think, 'fast') === 'deep';
  state.deepThinking = lsGet(LS_KEYS.deepThinking, legacyDeep);
  state.crossCheck = lsGet(LS_KEYS.crossCheck, legacyDeep);
  applyThinkModes();
  state.settings = Object.assign(state.settings, lsGet(LS_KEYS.settings, {}));
  applySettingsUI();
  state.conversations = lsGet(LS_KEYS.conversations, []);
  // Di chuyển dữ liệu cũ: gán id ổn định cho các tin nhắn AI chưa có (cần id này để liên kết
  // ghi chú -> đúng câu trả lời và cuộn tới đúng vị trí khi bấm vào ghi chú đã lưu).
  state.conversations.forEach((conv) => {
    (conv.messages || []).forEach((m) => { if (m.role === 'ai' && !m.id) m.id = uid(); });
  });
  renderNotesList();
  renderFormulaSubjectTabs();
  renderFormulaList();

  const savedCurrentId = lsGet(LS_KEYS.currentConv, null);
  const existing = state.conversations.find((c) => c.id === savedCurrentId);
  if (existing) {
    loadConversation(existing.id, true);
  } else {
    startNewConversation(true);
  }
}

/* ================= Theme ================= */
function applyTheme(theme) {
  document.body.setAttribute('data-theme', theme);
  el('main').setAttribute('data-theme', theme); // giữ lại cho tương thích ngược với các selector cũ nhắm vào #main
  el('themeBtn').innerHTML = theme === 'dark' ? ICONS.sun : ICONS.moon;
  el('setLightBtn').classList.toggle('active', theme === 'light');
  el('setDarkBtn').classList.toggle('active', theme === 'dark');
}
el('themeBtn').onclick = () => { const t = document.body.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'; applyTheme(t); lsSet(LS_KEYS.theme, t); };
el('setLightBtn').onclick = () => { applyTheme('light'); lsSet(LS_KEYS.theme, 'light'); };
el('setDarkBtn').onclick = () => { applyTheme('dark'); lsSet(LS_KEYS.theme, 'dark'); };

/* ================= Sidebar mobile ================= */
el('menuBtn').onclick = () => { el('sidebar').classList.add('open'); el('sidebarOverlay').classList.add('show'); };
el('closeSidebarBtn').onclick = () => { el('sidebar').classList.remove('open'); el('sidebarOverlay').classList.remove('show'); };
el('sidebarOverlay').onclick = () => { el('sidebar').classList.remove('open'); el('sidebarOverlay').classList.remove('show'); };
function closeSidebarOnMobile() {
  if (window.innerWidth <= 760) { el('sidebar').classList.remove('open'); el('sidebarOverlay').classList.remove('show'); }
}

/* ================= Tabs khung bên trái: Nguồn / Lịch sử / Ghi chú / Công thức ================= */
document.querySelectorAll('.sbtab').forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll('.sbtab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.sbpanel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + tab.dataset.tab));
  };
});

/* ================= Settings modal ================= */
function openSettings() { el('settingsOverlay').classList.add('show'); }
function closeSettings() { el('settingsOverlay').classList.remove('show'); }
el('settingsBtnSide').onclick = openSettings;
el('settingsBtnTop').onclick = openSettings;
el('settingsCloseBtn').onclick = closeSettings;
el('settingsOverlay').addEventListener('click', (e) => { if (e.target.id === 'settingsOverlay') closeSettings(); });

function applySettingsUI() {
  document.querySelectorAll('#detailChips .chip').forEach((c) => c.classList.toggle('active', c.dataset.val === state.settings.detail));
  document.querySelectorAll('#langChips .chip').forEach((c) => c.classList.toggle('active', c.dataset.val === state.settings.lang));
  document.querySelectorAll('#schoolChips .chip').forEach((c) => c.classList.toggle('active', c.dataset.val === state.settings.school));
  renderGradeChips();
}
document.querySelectorAll('#detailChips .chip').forEach((c) => c.onclick = () => { state.settings.detail = c.dataset.val; applySettingsUI(); lsSet(LS_KEYS.settings, state.settings); });
document.querySelectorAll('#langChips .chip').forEach((c) => c.onclick = () => { state.settings.lang = c.dataset.val; applySettingsUI(); lsSet(LS_KEYS.settings, state.settings); });
document.querySelectorAll('#schoolChips .chip').forEach((c) => c.onclick = () => {
  state.settings.school = c.dataset.val;
  const grades = (window.SCHOOL_LEVELS[state.settings.school] || {}).grades || [];
  if (!grades.includes(state.settings.grade)) state.settings.grade = grades[0];
  applySettingsUI();
  lsSet(LS_KEYS.settings, state.settings);
  renderFormulaList();
});
function renderGradeChips() {
  const wrap = el('gradeChips');
  const grades = (window.SCHOOL_LEVELS[state.settings.school] || {}).grades || [];
  wrap.innerHTML = grades.map((g) => `<button class="chip${g === state.settings.grade ? ' active' : ''}" data-val="${g}">${window.GRADE_LABELS[g] || g}</button>`).join('');
  wrap.querySelectorAll('.chip').forEach((c) => c.onclick = () => {
    state.settings.grade = c.dataset.val;
    applySettingsUI();
    lsSet(LS_KEYS.settings, state.settings);
    renderFormulaList();
  });
}

el('clearHistoryBtn').onclick = () => {
  if (!confirm('Xóa cuộc trò chuyện hiện tại? Thao tác này không thể hoàn tác.')) return;
  deleteConversation(state.currentConvId);
  closeSettings();
};

/* ================= Rules ================= */
function renderRules() {
  const ul = el('ruleList');
  ul.innerHTML = '';
  if (state.rules.length === 0) { ul.innerHTML = '<div class="set-empty">Chưa có quy tắc nào. AI sẽ ghi nhớ các quy tắc bạn thêm ở đây cho mọi câu hỏi sau này.</div>'; return; }
  state.rules.forEach((r, i) => {
    const li = document.createElement('li');
    const span = document.createElement('span'); span.textContent = r;
    const btn = document.createElement('button'); btn.textContent = '✕';
    btn.onclick = () => { state.rules.splice(i, 1); lsSet(LS_KEYS.rules, state.rules); renderRules(); };
    li.appendChild(span); li.appendChild(btn);
    ul.appendChild(li);
  });
}
el('ruleAddBtn').onclick = () => {
  const v = el('ruleInput').value.trim();
  if (!v) return;
  state.rules.push(v);
  el('ruleInput').value = '';
  lsSet(LS_KEYS.rules, state.rules);
  renderRules();
};

/* ================= Chế độ suy nghĩ (thanh chat, kiểu Claude) — 2 công tắc ĐỘC LẬP ================= */
function applyThinkModes() {
  const btn = el('thinkBtn');
  const { deepThinking, crossCheck } = state;
  const anyOn = deepThinking || crossCheck;
  const label = deepThinking && crossCheck ? 'Sâu + đối chiếu'
    : deepThinking ? 'Suy nghĩ sâu'
    : crossCheck ? 'Đối chiếu đa hướng'
    : 'Nhanh';
  btn.innerHTML = (anyOn ? ICONS.sparkles : ICONS.zap) + `<span>${label}</span>`;
  btn.classList.toggle('deep', anyOn);
  document.querySelectorAll('.think-opt').forEach((o) => {
    const on = o.dataset.mode === 'deepThinking' ? deepThinking : crossCheck;
    o.classList.toggle('active', on);
  });
}
el('thinkBtn').onclick = (e) => { e.stopPropagation(); el('thinkPopover').classList.toggle('show'); };
document.querySelectorAll('.think-opt').forEach((o) => {
  // Mỗi dòng chỉ đảo TRẠNG THÁI CỦA CHÍNH NÓ — không đóng popover sau khi bấm, để có thể bật/tắt
  // liên tiếp cả 2 công tắc trong cùng 1 lần mở menu (khác hành vi cũ: chọn 1 trong 2 rồi đóng ngay).
  o.onclick = () => {
    const key = o.dataset.mode; // 'deepThinking' | 'crossCheck'
    state[key] = !state[key];
    applyThinkModes();
    lsSet(key === 'deepThinking' ? LS_KEYS.deepThinking : LS_KEYS.crossCheck, state[key]);
  };
});
document.addEventListener('click', (e) => { if (!el('thinkBtnWrap').contains(e.target)) el('thinkPopover').classList.remove('show'); });

/* ================= Sources (kiểu NotebookLM) — đọc file hoàn toàn trên trình duyệt ================= */
let sourceCounter = 0;
function chunkText(text, size = 900) {
  const clean = text.replace(/\s+/g, ' ').trim();
  const chunks = [];
  for (let i = 0; i < clean.length; i += size) chunks.push(clean.slice(i, i + size));
  return chunks.map((t, idx) => ({ id: idx + 1, text: t }));
}
async function parsePDF(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let full = '';
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    full += content.items.map((it) => it.str).join(' ') + '\n';
  }
  return full;
}
async function parseDocx(file) { const buf = await file.arrayBuffer(); const res = await mammoth.extractRawText({ arrayBuffer: buf }); return res.value; }
async function parseTxt(file) { return await file.text(); }
function iconFor(ext) { return ext === 'pdf' ? '📕' : ext === 'docx' ? '📘' : '📄'; }

function renderSources() {
  const list = el('sourceList');
  list.innerHTML = '';
  el('emptySources').style.display = state.docs.length ? 'none' : 'block';
  state.docs.forEach((doc) => {
    const li = document.createElement('li');
    li.className = 'source-card' + (doc.included ? '' : ' dim');
    const chars = doc.chunks.reduce((a, c) => a + c.text.length, 0);
    li.innerHTML = `
      <div class="row">
        <input type="checkbox" ${doc.included ? 'checked' : ''}>
        <span class="icon">${iconFor(doc.ext)}</span>
        <div class="meta">
          <div class="nm">${doc.name}</div>
          <div class="sub">${doc.chunks.length} đoạn · ${chars > 1000 ? Math.round(chars / 1000) + ' nghìn ký tự' : chars + ' ký tự'}</div>
        </div>
        <button class="rm" title="Xóa nguồn">✕</button>
      </div>
      <div class="preview">${(doc.chunks[0]?.text || '').slice(0, 320).replace(/</g, '&lt;')}…</div>
    `;
    const checkbox = li.querySelector('input[type=checkbox]');
    checkbox.onchange = () => { doc.included = checkbox.checked; li.classList.toggle('dim', !doc.included); };
    li.querySelector('.rm').onclick = (e) => { e.stopPropagation(); state.docs = state.docs.filter((d) => d.id !== doc.id); renderSources(); };
    li.querySelector('.row').addEventListener('click', (e) => {
      if (e.target === checkbox || e.target.closest('.rm')) return;
      li.classList.toggle('expanded');
    });
    list.appendChild(li);
  });
}

async function handleFiles(files) {
  for (const file of files) {
    const ext = file.name.split('.').pop().toLowerCase();
    const doc = { id: ++sourceCounter, name: file.name, ext, chunks: [{ id: 1, text: '⏳ Đang đọc…' }], included: true };
    state.docs.push(doc);
    renderSources();
    try {
      let text = '';
      if (ext === 'pdf') text = await parsePDF(file);
      else if (ext === 'docx') text = await parseDocx(file);
      else text = await parseTxt(file);
      doc.chunks = chunkText(text);
    } catch (e) {
      doc.chunks = [{ id: 1, text: '⚠️ Không đọc được nội dung file này.' }];
      console.error(e);
    }
    renderSources();
  }
}
el('addSourceBtn').onclick = () => el('fileInput').click();
el('dropHint').onclick = () => el('fileInput').click();
el('fileInput').onchange = (e) => handleFiles(e.target.files);
['dragover', 'dragleave', 'drop'].forEach((evt) => {
  el('dropHint').addEventListener(evt, (e) => {
    e.preventDefault();
    el('dropHint').classList.toggle('dragover', evt === 'dragover');
    if (evt === 'drop') handleFiles(e.dataTransfer.files);
  });
});

/* ================= Ảnh đính kèm ================= */
/**
 * Đọc 1 file ảnh (từ input file HOẶC từ clipboard khi dán) thành base64 và đặt làm ảnh đang chờ gửi
 * — dùng chung cho cả nút đính kèm và cơ chế dán ảnh (Ctrl+V/Cmd+V) bên dưới, tránh lặp code.
 */
function loadImageFile(file) {
  if (!file) return;
  if (!file.type || !file.type.startsWith('image/')) { alert('Chỉ hỗ trợ dán/đính kèm file ảnh.'); return; }
  if (file.size > 5 * 1024 * 1024) { alert('Ảnh vượt quá 5MB, vui lòng chọn ảnh nhỏ hơn.'); return; }
  const reader = new FileReader();
  reader.onload = () => {
    const m = reader.result.match(/^data:(.*?);base64,(.*)$/);
    if (!m) return;
    state.pendingImage = { mediaType: m[1], base64: m[2], url: reader.result };
    renderImagePreview();
  };
  reader.readAsDataURL(file);
}
el('attachBtn').onclick = () => el('imageInput').click();
el('imageInput').onchange = (e) => {
  loadImageFile(e.target.files[0]);
  e.target.value = '';
};

// ---------- Kéo-thả ảnh (drag & drop) từ máy thẳng vào khung soạn tin nhắn ----------
// Cho phép kéo 1 file ảnh từ Explorer/Finder (hoặc từ tab khác của trình duyệt) rồi thả trực tiếp
// vào khung chat để đính kèm làm ảnh đề bài — thêm một cách "tải ảnh từ máy" trực quan, song song với
// nút đính kèm (chọn file) và dán ảnh (Ctrl+V) đã có sẵn ở trên, dùng chung hàm loadImageFile().
const composerEl = el('composer');
let dragDepth = 0; // đếm số lần dragenter lồng nhau (do phần tử con) để tránh dropzone nhấp nháy khi kéo qua các con bên trong #composer
composerEl.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
  e.preventDefault();
  dragDepth++;
  composerEl.classList.add('composer-dragover');
});
composerEl.addEventListener('dragover', (e) => {
  if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
composerEl.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) composerEl.classList.remove('composer-dragover');
});
composerEl.addEventListener('drop', (e) => {
  if (!e.dataTransfer) return;
  e.preventDefault();
  dragDepth = 0;
  composerEl.classList.remove('composer-dragover');
  const files = Array.from(e.dataTransfer.files || []);
  const imgFile = files.find((f) => f.type && f.type.startsWith('image/'));
  if (imgFile) loadImageFile(imgFile);
  else if (files.length) alert('Chỉ hỗ trợ kéo-thả file ảnh vào đây (muốn nạp PDF/DOCX/TXT làm nguồn tài liệu, dùng mục "Nguồn" ở thanh bên).');
});

// ---------- Dán ảnh (Ctrl+V / Cmd+V) thẳng vào khung chat để hỏi ----------
// Cho phép dán ảnh đã sao chép từ nơi khác (ảnh chụp màn hình, ảnh trong trình duyệt/Word/Zalo...)
// trực tiếp vào ô nhập câu hỏi mà không cần lưu ra file rồi bấm nút đính kèm — nếu clipboard có
// nhiều loại dữ liệu (vd vừa có ảnh vừa có văn bản mô tả), ưu tiên nhận ảnh và vẫn giữ nguyên phần
// văn bản đã gõ sẵn trong ô (không xoá nội dung câu hỏi đang có).
function handlePasteImage(e) {
  const items = (e.clipboardData || window.clipboardData) && (e.clipboardData || window.clipboardData).items;
  if (!items) return;
  for (const item of items) {
    if (item.kind === 'file' && item.type && item.type.startsWith('image/')) {
      e.preventDefault(); // tránh trình duyệt dán kèm tên file ngẫu nhiên vào ô văn bản
      loadImageFile(item.getAsFile());
      el('qInput').focus();
      break;
    }
  }
}
el('qInput').addEventListener('paste', handlePasteImage);
// Cũng lắng nghe trên toàn bộ khung soạn tin (không chỉ riêng textarea) — để dán ảnh vẫn hoạt động
// dù người dùng vừa bấm vào nút đính kèm/nút chế độ suy nghĩ (focus không còn ở #qInput).
el('composer').addEventListener('paste', handlePasteImage);

function renderImagePreview() {
  const wrap = el('imgPreviewWrap');
  el('attachBtn').classList.toggle('has-image', !!state.pendingImage);
  if (!state.pendingImage) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = `<div class="img-chip show"><img src="${state.pendingImage.url}"><span>Ảnh đề bài đã đính kèm</span><button class="rm" type="button">✕</button></div>`;
  wrap.querySelector('.rm').onclick = () => { state.pendingImage = null; renderImagePreview(); };
}

/* ================= Truy hồi ngữ cảnh từ nguồn (chạy trên client, chỉ gửi đoạn liên quan lên server) ================= */
function retrieveContext(query, limit = 4) {
  const qWords = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const activeDocs = state.docs.filter((d) => d.included);
  if (qWords.length === 0 || activeDocs.length === 0) return [];
  const scored = [];
  activeDocs.forEach((doc) => {
    doc.chunks.forEach((ch) => {
      const lower = ch.text.toLowerCase();
      let score = 0;
      qWords.forEach((w) => { if (w.length > 2 && lower.includes(w)) score++; });
      if (score > 0) scored.push({ doc: doc.name, id: ch.id, text: ch.text, score });
    });
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
function highlightSnippet(text, query) {
  const qWords = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((w) => w.length > 2);
  let snippet = text.length > 260 ? text.slice(0, 260) + '…' : text;
  let out = snippet.replace(/</g, '&lt;');
  qWords.slice(0, 6).forEach((w) => {
    const re = new RegExp('(' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig');
    out = out.replace(re, '<span class="hl">$1</span>');
  });
  return out;
}

/* ================= Rendering ================= */
function extractThinking(text) {
  const m = text.match(/<thinking>([\s\S]*?)<\/thinking>/i);
  if (!m) return { thinking: null, answer: text.trim() };
  return { thinking: m[1].trim(), answer: text.replace(m[0], '').trim() };
}
function renderMath(container) {
  if (window.renderMathInElement) {
    try {
      renderMathInElement(container, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '\\[', right: '\\]', display: true },
          { left: '$', right: '$', display: false },
          { left: '\\(', right: '\\)', display: false }
        ],
        throwOnError: false
      });
    } catch (e) { console.error(e); }
  }
}
function renderMarkdownLite(text) {
  const drawBlocks = [];
  const mathBlocks = [];
  let working = text.replace(/```(plot|shape|solid3d)\n?([\s\S]*?)```/g, (m, kind, body) => {
    let spec = null;
    try { spec = JSON.parse(body.trim()); } catch (e) { spec = null; }
    drawBlocks.push({ kind, spec });
    return `\u0000DRAW${drawBlocks.length - 1}\u0000`;
  });
  // Bảo vệ các khối công thức LaTeX ($$...$$, \[...\], \(...\), $...$) khỏi bước tách xuống
  // dòng bên dưới (đổi mỗi \n đơn thành <br>) — nếu không, thẻ <br> bị chèn vào giữa công thức
  // nhiều dòng sẽ cắt đứt văn bản thành nhiều text-node, khiến KaTeX không tìm thấy trọn vẹn cặp
  // dấu phân cách mở/đóng và hiển thị nguyên mã LaTeX thay vì công thức đã render.
  working = working.replace(/\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$[^$\n]+?\$/g, (m) => {
    mathBlocks.push(m.replace(/\r?\n\s*/g, ' '));
    return `\u0000MATH${mathBlocks.length - 1}\u0000`;
  });
  let html = working
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/```([\s\S]*?)```/g, (m, c) => `<pre><code>${c.trim()}</code></pre>`)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[(\d+)\]/g, '<sup class="cref">[$1]</sup>')
    .split(/\n{2,}/).map((block) => {
      const h = block.match(/^##\s?(.+)$/);
      if (h) return `<h3>${h[1].trim()}</h3>`;
      return `<p>${block.replace(/\n/g, '<br>')}</p>`;
    }).join('');

  html = html.replace(/\u0000MATH(\d+)\u0000/g, (m, i) =>
    mathBlocks[+i].replace(/&/g, '&amp;').replace(/</g, '&lt;')
  );

  const draws = [];
  html = html.replace(/\u0000DRAW(\d+)\u0000/g, (m, i) => {
    const b = drawBlocks[+i];
    if (!b || !b.spec) return '<p style="color:#c0392b;font-size:12px;">⚠️ Không thể hiển thị hình minh họa (dữ liệu không hợp lệ).</p>';
    const id = 'draw_' + Math.random().toString(36).slice(2, 9);
    draws.push({ id, kind: b.kind, spec: b.spec });
    const cls = b.kind === 'solid3d' ? 'draw-wrap draw-wrap-3d' : 'draw-wrap';
    return `<div class="${cls}" id="${id}"></div>`;
  });
  return { html, draws };
}

/* ---------- Vẽ hình học & đồ thị hàm số ---------- */
function renderDrawing(container, kind, spec) {
  if (!container) return;
  try {
    if (kind === 'plot') drawPlot(container, spec);
    else if (kind === 'solid3d') { if (window.drawSolid3D) window.drawSolid3D(container, spec); else container.innerHTML = '<p style="font-size:12px;color:#c0392b;">⚠️ Không tải được thư viện vẽ 3D.</p>'; }
    else drawShape(container, spec);
  } catch (e) {
    container.innerHTML = '<p style="color:#c0392b;font-size:12px;">⚠️ Có lỗi khi vẽ minh họa.</p>';
    console.error(e);
  }
}
function drawPlot(container, spec) {
  const W = 520, H = 300, pad = 36;
  const xr = (spec.xrange && spec.xrange.length === 2) ? spec.xrange.map(Number) : [-10, 10];
  const exprs = (spec.expressions || []).slice(0, 4).filter(Boolean);
  const N = 240;
  const colors = ['#2955ff', '#0ea8b0', '#e0503f', '#b98a2b'];
  const series = exprs.map((expr) => {
    const pts = [];
    for (let i = 0; i <= N; i++) {
      const x = xr[0] + (xr[1] - xr[0]) * i / N;
      let y;
      try { y = math.evaluate(expr, { x }); } catch (e) { y = NaN; }
      pts.push([x, (typeof y === 'number' && isFinite(y)) ? y : null]);
    }
    return { expr, pts };
  });
  let yr = (spec.yrange && spec.yrange.length === 2) ? spec.yrange.map(Number) : null;
  if (!yr) {
    const vals = [];
    series.forEach((s) => s.pts.forEach((p) => { if (p[1] !== null) vals.push(p[1]); }));
    let mn = vals.length ? Math.min(...vals) : -1, mx = vals.length ? Math.max(...vals) : 1;
    if (mn === mx) { mn -= 1; mx += 1; }
    const m = (mx - mn) * 0.12 || 1;
    yr = [mn - m, mx + m];
  }
  const sx = (x) => pad + (x - xr[0]) / (xr[1] - xr[0]) * (W - 2 * pad);
  const sy = (y) => H - pad - (y - yr[0]) / (yr[1] - yr[0]) * (H - 2 * pad);

  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px">`;
  svg += `<rect x="${pad}" y="${pad}" width="${W - 2 * pad}" height="${H - 2 * pad}" fill="none" stroke="var(--rule)" stroke-width="1"/>`;
  if (xr[0] <= 0 && xr[1] >= 0) svg += `<line x1="${sx(0)}" y1="${pad}" x2="${sx(0)}" y2="${H - pad}" stroke="var(--muted)" stroke-width="1.2"/>`;
  if (yr[0] <= 0 && yr[1] >= 0) svg += `<line x1="${pad}" y1="${sy(0)}" x2="${W - pad}" y2="${sy(0)}" stroke="var(--muted)" stroke-width="1.2"/>`;
  const yspan = yr[1] - yr[0];
  series.forEach((s, i) => {
    let d = ''; let drawing = false;
    s.pts.forEach((p) => {
      if (p[1] === null || p[1] < yr[0] - yspan || p[1] > yr[1] + yspan) { drawing = false; return; }
      const px = sx(p[0]).toFixed(1), py = sy(Math.max(yr[0] - yspan, Math.min(yr[1] + yspan, p[1]))).toFixed(1);
      d += (drawing ? 'L' : 'M') + px + ',' + py + ' ';
      drawing = true;
    });
    svg += `<path d="${d}" fill="none" stroke="${colors[i % colors.length]}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`;
  });
  svg += `</svg>`;
  const legend = series.map((s, i) => `<span style="display:inline-flex;align-items:center;gap:5px;margin:2px 12px 2px 0;"><span style="width:10px;height:10px;border-radius:3px;background:${colors[i % colors.length]};display:inline-block;"></span><span style="font-family:'JetBrains Mono',monospace;">y = ${s.expr.replace(/</g, '&lt;')}</span></span>`).join('');
  container.innerHTML = svg + `<div class="draw-legend">${legend}</div>`;
}
function drawShape(container, spec) {
  const W = 420, H = 300, pad = 40;

  // Chuẩn hoá: hỗ trợ CẢ định dạng đơn giản cũ (1 hình duy nhất: polygon/circle/segment/points ở cấp
  // gốc, như trước) LẪN định dạng mới "composite" — {"type":"composite","elements":[{...},{...},...]}
  // — cho phép gộp NHIỀU yếu tố (đường tròn ngoại tiếp + tam giác + đường cao/đường kính/đoạn phụ +
  // các điểm phụ như trực tâm, giao điểm...) vào ĐÚNG MỘT hình vẽ duy nhất. Đây là phần khắc phục lỗi
  // "hình vẽ thiếu ý" — trước đây mỗi khối \`shape\` chỉ vẽ được 1 loại hình nên với bài có nhiều yếu tố
  // (vd tam giác nội tiếp đường tròn + đường cao + điểm H, K, I, J...) AI buộc phải bỏ bớt, giờ có thể
  // liệt kê đủ tất cả trong "elements".
  const elements = (spec && spec.type === 'composite' && Array.isArray(spec.elements) && spec.elements.length)
    ? spec.elements.filter(Boolean)
    : [spec];

  // Gom TẤT CẢ toạ độ (điểm của mọi element + biên của mọi đường tròn) để tính chung khung nhìn/tỉ lệ,
  // đảm bảo mọi yếu tố đều nằm gọn, đúng tỉ lệ tương đối với nhau trong cùng một hình.
  let allPts = [];
  elements.forEach((elmt) => {
    (elmt.points || []).forEach((p) => allPts.push([Number(p[0]), Number(p[1])]));
    if (elmt.type === 'circle' && elmt.center && elmt.radius != null) {
      const [cx, cy] = elmt.center.map(Number), r = Number(elmt.radius);
      allPts.push([cx - r, cy - r], [cx + r, cy + r]);
    }
  });
  if (allPts.length === 0) allPts = [[0, 0], [1, 1]];

  const xs = allPts.map((p) => p[0]), ys = allPts.map((p) => p[1]);
  let xmin = Math.min(...xs), xmax = Math.max(...xs), ymin = Math.min(...ys), ymax = Math.max(...ys);
  if (xmin === xmax) { xmin -= 1; xmax += 1; }
  if (ymin === ymax) { ymin -= 1; ymax += 1; }
  const mx = (xmax - xmin) * 0.18 + 0.5, my = (ymax - ymin) * 0.18 + 0.5;
  xmin -= mx; xmax += mx; ymin -= my; ymax += my;
  const scale = Math.min((W - 2 * pad) / (xmax - xmin), (H - 2 * pad) / (ymax - ymin));
  const ox = (W - (xmax - xmin) * scale) / 2;
  const oy = (H - (ymax - ymin) * scale) / 2;
  const sx = (x) => ox + (x - xmin) * scale;
  const sy = (y) => H - (oy + (y - ymin) * scale);

  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px">`;

  // Thứ tự vẽ nét: đường tròn (nền) -> đa giác chính -> đoạn/đường phụ -> (điểm & nhãn vẽ riêng ở
  // vòng sau cùng, luôn nổi lên trên mọi nét) — để các yếu tố phụ không che mất hình chính.
  const order = { circle: 0, polygon: 1, segment: 2, points: 3 };
  const sorted = elements
    .map((elmt, i) => ({ elmt, i }))
    .sort((a, b) => (order[a.elmt.type || 'polygon'] ?? 1) - (order[b.elmt.type || 'polygon'] ?? 1) || a.i - b.i);

  sorted.forEach(({ elmt }) => {
    const type = elmt.type || 'polygon';
    // "dashed": true — dùng cho các đoạn DỰNG THÊM/phụ (đường cao, đường kính, đoạn nối điểm phụ...)
    // để phân biệt trực quan với cạnh chính (nét liền) của tam giác/đa giác.
    const dashAttr = elmt.dashed ? ' stroke-dasharray="5,4"' : '';
    const pts = (elmt.points || []).map((p) => [Number(p[0]), Number(p[1])]);
    if (type === 'circle' && elmt.center && elmt.radius != null) {
      const [cx, cy] = elmt.center.map(Number);
      svg += `<circle cx="${sx(cx)}" cy="${sy(cy)}" r="${elmt.radius * scale}" fill="var(--primary)" fill-opacity="0.05" stroke="var(--primary)" stroke-width="1.6"${dashAttr}/>`;
      svg += `<circle cx="${sx(cx)}" cy="${sy(cy)}" r="2.2" fill="var(--primary)"/>`;
    } else if (type === 'segment' && pts.length >= 2) {
      // Hỗ trợ đường gấp khúc nối NHIỀU điểm liên tiếp nếu "points" có hơn 2 điểm (không chỉ 1 đoạn).
      for (let k = 0; k < pts.length - 1; k++) {
        svg += `<line x1="${sx(pts[k][0])}" y1="${sy(pts[k][1])}" x2="${sx(pts[k + 1][0])}" y2="${sy(pts[k + 1][1])}" stroke="var(--primary)" stroke-width="1.8"${dashAttr}/>`;
      }
    } else if (type === 'points') {
      // chỉ chấm điểm, vẽ ở vòng lặp điểm bên dưới
    } else if (pts.length >= 2) {
      const path = pts.map((p, i2) => (i2 === 0 ? 'M' : 'L') + sx(p[0]).toFixed(1) + ',' + sy(p[1]).toFixed(1)).join(' ') + ' Z';
      svg += `<path d="${path}" fill="var(--primary)" fill-opacity="0.08" stroke="var(--primary)" stroke-width="2.2" stroke-linejoin="round"${dashAttr}/>`;
    }
  });

  // Vòng sau cùng: chấm điểm + nhãn cho TẤT CẢ element có "points" (kể cả circle/segment/polygon nếu
  // có kèm points riêng), luôn vẽ SAU để nhãn không bị các nét khác đè lên.
  elements.forEach((elmt) => {
    if (!elmt || !elmt.points) return;
    elmt.points.forEach((p, i) => {
      const x = Number(p[0]), y = Number(p[1]);
      const label = (elmt.labels && elmt.labels[i]) || '';
      svg += `<circle cx="${sx(x)}" cy="${sy(y)}" r="2.6" fill="var(--text)"/>`;
      if (label) svg += `<text x="${sx(x) + 7}" y="${sy(y) - 6}" font-size="13" font-family="Inter,sans-serif" fill="var(--text)" font-weight="600">${String(label).replace(/</g, '&lt;')}</text>`;
    });
  });

  svg += `</svg>`;
  container.innerHTML = svg;
}

function addUserMsg(text, imageUrl) {
  const row = document.createElement('div');
  row.className = 'msg-row msg-user';
  row.innerHTML = '<div class="bubble"></div>';
  const bubble = row.querySelector('.bubble');
  if (imageUrl) { const img = document.createElement('img'); img.src = imageUrl; bubble.appendChild(img); }
  else if (!text) { const span = document.createElement('span'); span.textContent = '📷 Đã gửi kèm ảnh đề bài'; bubble.appendChild(span); }
  if (text) { const span = document.createElement('span'); span.textContent = text; bubble.appendChild(span); }
  threadEl.appendChild(row); threadEl.scrollTop = threadEl.scrollHeight;
}
function addAiMsg(labelText) {
  const row = document.createElement('div');
  row.className = 'msg-row msg-ai';
  row.innerHTML = `<div class="label">${labelText || 'Trợ Giải'}</div><div class="content"><span class="typing"><span></span><span></span><span></span></span></div>`;
  threadEl.appendChild(row); threadEl.scrollTop = threadEl.scrollHeight;
  return row;
}

function humanFileSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return (i === 0 ? Math.round(n) : n.toFixed(1)) + ' ' + units[i];
}

// Gói 1 file .pptx/.docx vừa dựng xong ở CLIENT (pptxgenjs/docx.js) thành 1 TIN NHẮN trong khung chat
// — thay cho hành vi cũ là tự động kích hoạt tải xuống ngay lập tức. File vẫn được dựng bằng đúng cơ
// chế xoay tua/tự động chuyển provider AI (callWithFailover ở server) như trước, chỉ khác ở BƯỚC GIAO
// FILE cho người dùng: giờ xuất hiện như 1 tệp đính kèm ngay trong luồng hội thoại (giữ lại lịch sử,
// cuộn lên xem lại được), người dùng chủ động bấm "Tải xuống" khi cần thay vì bị trình duyệt tự mở
// hộp thoại lưu file ngay lập tức. object URL cố tình KHÔNG revoke để nút tải vẫn dùng được về sau.
// "summaryHtml" (tuỳ chọn): mô tả AI đã tạo NHỮNG GÌ trong file (vd danh sách tiêu đề slide/mục đề
// cương) — hiện NGAY TRÊN thẻ file, thay cho dòng "✅ Đã tạo xong file" chung chung trước đây, để
// người dùng biết rõ nội dung trước khi quyết định tải về. Dựng thẳng từ spec JSON đã có sẵn, KHÔNG
// tốn thêm lượt gọi AI nào.
function appendFileMessage(kind, fileName, blob, summaryHtml) {
  const label = kind === 'pptx' ? 'Slide PPT' : 'Đề cương .docx';
  const icon = kind === 'pptx' ? '🖥️' : '📄';
  const kindLabel = kind === 'pptx' ? 'PowerPoint' : 'Word';
  const row = addAiMsg(label);
  const content = row.querySelector('.content');
  const url = URL.createObjectURL(blob);
  content.innerHTML = `
    ${summaryHtml || '<p style="margin:0 0 10px;">✅ Đã tạo xong file, sẵn sàng tải xuống bên dưới:</p>'}
    <div class="file-msg-card">
      <div class="file-msg-icon">${icon}</div>
      <div class="file-msg-meta">
        <div class="file-msg-name"></div>
        <div class="file-msg-sub">${kindLabel} · ${humanFileSize(blob.size)} · Tạo bởi AI</div>
      </div>
      <button class="file-msg-dl" type="button">${ICONS.download}<span>Tải xuống</span></button>
    </div>`;
  content.querySelector('.file-msg-name').textContent = fileName;
  content.querySelector('.file-msg-dl').onclick = () => {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  threadEl.scrollTop = threadEl.scrollHeight;
  return row;
}

// Tóm tắt NGẮN GỌN những gì AI đã tạo trong file PPT/đề cương .docx, dựng thẳng từ spec JSON (đã có
// sẵn từ /api/generate/ppt-outline hoặc /api/generate/outline) — không gọi thêm AI. Dùng làm
// "summaryHtml" cho appendFileMessage() ở TẤT CẢ các nơi tạo file (nút bấm dưới câu trả lời LẪN gõ
// trực tiếp trong chat), để câu trả lời luôn mô tả rõ nội dung file thay vì chỉ báo "đã xong".
function buildPPTSummaryHtml(spec) {
  const esc = escapeHtml;
  const slides = spec.slides || [];
  const items = slides.slice(0, 12).map((sl, i) => `<li>Slide ${i + 2}: ${esc(sl.heading || '')}</li>`).join('');
  const more = slides.length > 12 ? `<li>… và ${slides.length - 12} slide khác</li>` : '';
  return `
    <p style="margin:0 0 6px;">✅ Mình đã tạo xong file PowerPoint <b>"${esc(spec.title || 'Bài trình chiếu')}"</b> gồm ${slides.length + 1} slide (kể cả trang bìa):</p>
    <ul class="gen-summary-list">${items}${more}</ul>
    <p style="margin:8px 0 10px;">Bấm "Tải xuống" bên dưới để lưu về máy:</p>`;
}
function buildOutlineSummaryHtml(spec) {
  const esc = escapeHtml;
  const sections = spec.sections || [];
  const items = sections.map((sec) => `<li>${esc(sec.heading || '')}</li>`).join('');
  const exNote = Array.isArray(spec.exercises) && spec.exercises.length ? ` kèm bài tập ôn tập theo ${spec.exercises.length} mức độ` : '';
  return `
    <p style="margin:0 0 6px;">✅ Mình đã soạn xong đề cương <b>"${esc(spec.title || 'Đề cương')}"</b> gồm ${sections.length} phần${exNote}:</p>
    <ul class="gen-summary-list">${items}</ul>
    <p style="margin:8px 0 10px;">Bấm "Tải xuống" bên dưới để lưu file .docx về máy:</p>`;
}

// Hiển thị 1 thẻ LỖI ngay trong khung chat kèm nút "Thử lại" — thay cho alert() cũ (chặn cứng luồng,
// muốn thử lại phải tự bấm lại nút gốc hoặc gõ lại câu hỏi từ đầu). Dùng cho MỌI lỗi khi tạo file
// PPT/đề cương .docx (kể cả lỗi "AI trả về dữ liệu không hợp lệ" — nguyên nhân phổ biến nhất). retryFn
// là 1 hàm async KHÔNG THAM SỐ, đã đóng gói sẵn (qua closure ở nơi gọi) toàn bộ ngữ cảnh cần thiết để
// lặp lại ĐÚNG yêu cầu vừa thất bại.
function appendGenErrorMessage(label, message, retryFn) {
  const row = addAiMsg(label);
  const content = row.querySelector('.content');
  content.innerHTML = `
    <div class="gen-error-card">
      <p class="gen-error-text">⚠️ ${escapeHtml(message)}</p>
      <button class="gen-error-retry" type="button">${ICONS.refresh}<span>Thử lại</span></button>
    </div>`;
  const btn = content.querySelector('.gen-error-retry');
  btn.onclick = async () => {
    btn.disabled = true;
    btn.innerHTML = '<span>Đang thử lại…</span>';
    row.remove(); // gỡ thẻ lỗi cũ — retryFn() tự thêm tin nhắn mới (thành công hoặc lỗi khác)
    await retryFn();
  };
  threadEl.scrollTop = threadEl.scrollHeight;
  return row;
}

/* ================= Đa cuộc trò chuyện + Lịch sử (giống Claude, phong cách hiện đại) ================= */
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function currentConversation() {
  return state.conversations.find((c) => c.id === state.currentConvId) || null;
}
function saveConversations() { lsSet(LS_KEYS.conversations, state.conversations); lsSet(LS_KEYS.currentConv, state.currentConvId); }

function startNewConversation(silent) {
  const conv = { id: uid(), title: 'Cuộc trò chuyện mới', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
  state.conversations.unshift(conv);
  if (state.conversations.length > MAX_STORED_CONVERSATIONS) state.conversations.length = MAX_STORED_CONVERSATIONS;
  state.currentConvId = conv.id;
  state.history = [];
  pendingTurn = null;
  threadEl.innerHTML = '';
  welcome();
  el('chatTitle').textContent = 'Phòng giải bài';
  saveConversations();
  renderHistoryList();
  if (!silent) closeSidebarOnMobile();
}
el('newChatBtn').onclick = () => startNewConversation(false);

function loadConversation(id, silent) {
  const conv = state.conversations.find((c) => c.id === id);
  if (!conv) return;
  state.currentConvId = id;
  pendingTurn = null;
  threadEl.innerHTML = '';
  if (conv.messages.length === 0) { welcome(); }
  else {
    conv.messages.forEach((msg) => {
      if (msg.role === 'user') addUserMsg(msg.text, null);
      else renderStoredAiMessage(msg);
    });
  }
  // dựng lại ngữ cảnh gửi API từ nội dung đã lưu
  state.history = [];
  conv.messages.forEach((msg) => {
    if (msg.role === 'user') state.history.push({ role: 'user', content: msg.text || '[Người dùng đã gửi ảnh đề bài để giải]' });
    else state.history.push({ role: 'assistant', content: msg.detail || msg.approach || '' });
  });
  if (state.history.length > 20) state.history = state.history.slice(-20);
  el('chatTitle').textContent = conv.title;
  lsSet(LS_KEYS.currentConv, id);
  renderHistoryList();
  threadEl.scrollTop = threadEl.scrollHeight;
  if (!silent) closeSidebarOnMobile();
}

function deleteConversation(id) {
  state.conversations = state.conversations.filter((c) => c.id !== id);
  saveConversations();
  if (state.currentConvId === id) {
    if (state.conversations.length) loadConversation(state.conversations[0].id, true);
    else startNewConversation(true);
  } else {
    renderHistoryList();
  }
}

function touchConversation(conv) { conv.updatedAt = Date.now(); saveConversations(); renderHistoryList(); }

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'Vừa xong';
  if (s < 3600) return Math.floor(s / 60) + ' phút trước';
  if (s < 86400) return Math.floor(s / 3600) + ' giờ trước';
  if (s < 604800) return Math.floor(s / 86400) + ' ngày trước';
  return new Date(ts).toLocaleDateString('vi-VN');
}

function renderHistoryList() {
  const ul = el('historyList');
  const sorted = [...state.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  el('historyEmpty').style.display = sorted.length ? 'none' : 'block';
  ul.innerHTML = '';
  sorted.forEach((conv) => {
    const li = document.createElement('li');
    li.className = 'hist-card' + (conv.id === state.currentConvId ? ' active' : '');
    li.innerHTML = `
      <div class="hist-main">
        <div class="hist-title">${(conv.title || 'Cuộc trò chuyện mới').replace(/</g, '&lt;')}</div>
        <div class="hist-meta">${conv.messages.length} tin nhắn · ${timeAgo(conv.updatedAt)}</div>
      </div>
      <button class="hist-del" title="Xóa cuộc trò chuyện">${ICONS.trash}</button>
    `;
    li.querySelector('.hist-main').onclick = () => loadConversation(conv.id);
    li.querySelector('.hist-del').onclick = (e) => {
      e.stopPropagation();
      if (confirm('Xóa cuộc trò chuyện này?')) deleteConversation(conv.id);
    };
    ul.appendChild(li);
  });
}

function autoTitleFromQuery(query) {
  const clean = (query || '').replace(/\s+/g, ' ').trim();
  return clean ? (clean.length > 46 ? clean.slice(0, 46) + '…' : clean) : 'Bài tập có ảnh đính kèm';
}

/* ================= Ghi chú =================
 * Ghi chú của người dùng được gắn trực tiếp vào tin nhắn AI (msg.userNote/msg.userNoteAt) thay vì
 * lưu ở 1 mảng tách rời — nhờ đó danh sách "Ghi chú" ở sidebar luôn suy ra được TỪ đúng cuộc trò
 * chuyện + đúng câu trả lời, và bấm vào 1 ghi chú có thể quay thẳng lại đúng vị trí đó.
 */
function collectAllNotes() {
  const list = [];
  state.conversations.forEach((conv) => {
    (conv.messages || []).forEach((m) => {
      if (m.role === 'ai' && m.userNote) {
        list.push({
          convId: conv.id,
          convTitle: conv.title || 'Cuộc trò chuyện',
          msgId: m.id,
          question: m.query || '(Bài tập có ảnh đính kèm)',
          note: m.userNote,
          createdAt: m.userNoteAt || conv.updatedAt || Date.now()
        });
      }
    });
  });
  return list.sort((a, b) => b.createdAt - a.createdAt);
}

function renderNotesList() {
  const ul = el('notesList');
  const notes = collectAllNotes();
  el('notesEmpty').style.display = notes.length ? 'none' : 'block';
  ul.innerHTML = '';
  notes.forEach((note) => {
    const li = document.createElement('li');
    li.className = 'note-card';
    li.title = 'Bấm để xem lại câu trả lời kèm ghi chú của bạn';
    li.innerHTML = `
      <div class="note-q"></div>
      <div class="note-a"></div>
      <div class="note-foot">
        <span class="note-conv"></span>
        <div class="note-foot-right"><span></span><button class="note-del" title="Xóa ghi chú">${ICONS.trash}</button></div>
      </div>
    `;
    li.querySelector('.note-q').textContent = note.question;
    const aEl = li.querySelector('.note-a');
    aEl.textContent = note.note.length > 220 ? note.note.slice(0, 220) + '…' : note.note;
    li.querySelector('.note-conv').textContent = note.convTitle;
    li.querySelector('.note-foot-right span').textContent = timeAgo(note.createdAt);
    li.querySelector('.note-del').onclick = (e) => {
      e.stopPropagation();
      deleteNote(note.convId, note.msgId);
    };
    li.onclick = () => goToNote(note);
    ul.appendChild(li);
  });
}

function deleteNote(convId, msgId) {
  const conv = state.conversations.find((c) => c.id === convId);
  const msg = conv && (conv.messages || []).find((m) => m.id === msgId);
  if (!msg) return;
  delete msg.userNote;
  delete msg.userNoteAt;
  saveConversations();
  renderNotesList();
  refreshNoteUIInThread(msgId);
}

// Sau khi lưu/xóa ghi chú từ nơi khác (vd danh sách Ghi chú ở sidebar), nếu đúng câu trả lời đó
// đang hiển thị sẵn trong khung chat hiện tại thì vẽ lại MỌI khối nút/ghim ghi chú của nó ngay lập
// tức — có thể có tới 2 khối cho cùng 1 msgObj: 1 ở phần "Hướng giải" (trước khi xem chi tiết) và
// 1 ở phần "Lời giải chi tiết", cả 2 đều phải đồng bộ vì cùng ghi/đọc chung msgObj.userNote.
function refreshNoteUIInThread(msgId) {
  const row = threadEl.querySelector(`[data-msg-id="${CSS.escape(String(msgId))}"]`);
  if (!row) return;
  row.querySelectorAll('.study-wrap').forEach((wrap) => { if (typeof wrap._repaint === 'function') wrap._repaint(); });
}

let activeNoteCtx = null;
function openNoteModal(msgObj, conv) {
  activeNoteCtx = { msgObj, conv };
  el('noteModalQ').textContent = msgObj.query || '(Bài tập có ảnh đính kèm)';
  el('noteModalInput').value = msgObj.userNote || '';
  el('noteModalDeleteBtn').classList.toggle('hide', !msgObj.userNote);
  el('noteOverlay').classList.add('show');
  setTimeout(() => el('noteModalInput').focus(), 60);
}
function closeNoteModal() {
  el('noteOverlay').classList.remove('show');
  activeNoteCtx = null;
}
el('noteCloseBtn').onclick = closeNoteModal;
el('noteModalCancelBtn').onclick = closeNoteModal;
el('noteOverlay').addEventListener('click', (e) => { if (e.target.id === 'noteOverlay') closeNoteModal(); });
el('noteModalSaveBtn').onclick = () => {
  if (!activeNoteCtx) return;
  const { msgObj, conv } = activeNoteCtx;
  const text = el('noteModalInput').value.trim();
  if (!text) { el('noteModalInput').focus(); return; }
  msgObj.userNote = text;
  msgObj.userNoteAt = Date.now();
  if (conv) touchConversation(conv); else saveConversations();
  renderNotesList();
  refreshNoteUIInThread(msgObj.id);
  closeNoteModal();
};
el('noteModalDeleteBtn').onclick = () => {
  if (!activeNoteCtx) return;
  const { msgObj, conv } = activeNoteCtx;
  delete msgObj.userNote;
  delete msgObj.userNoteAt;
  if (conv) touchConversation(conv); else saveConversations();
  renderNotesList();
  refreshNoteUIInThread(msgObj.id);
  closeNoteModal();
};

/* ================= Đề cương (.docx) modal ================= */
// Modal chỉ hỏi 1 lựa chọn: có kèm bài tập luyện tập (chia mức độ) hay không — nội dung nguồn luôn
// là đúng câu trả lời AI đang gắn với nút bấm, không cần người dùng tự nhập lại.
let activeOutlineCtx = null;
function openOutlineModal(answerText) {
  activeOutlineCtx = { answerText, includeExercises: false };
  el('outlineExerciseToggle').classList.remove('active');
  el('outlineConfirmBtn').disabled = false;
  el('outlineConfirmBtn').innerHTML = '📥 Tạo &amp; gửi vào chat';
  el('outlineOverlay').classList.add('show');
}
function closeOutlineModal() {
  el('outlineOverlay').classList.remove('show');
  activeOutlineCtx = null;
}
el('outlineCloseBtn').onclick = closeOutlineModal;
el('outlineCancelBtn').onclick = closeOutlineModal;
el('outlineOverlay').addEventListener('click', (e) => { if (e.target.id === 'outlineOverlay') closeOutlineModal(); });
el('outlineExerciseToggle').onclick = () => {
  if (!activeOutlineCtx) return;
  activeOutlineCtx.includeExercises = !activeOutlineCtx.includeExercises;
  el('outlineExerciseToggle').classList.toggle('active', activeOutlineCtx.includeExercises);
};
async function submitOutlineFromModal(answerText, includeExercises) {
  const btn = el('outlineConfirmBtn');
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span>Đang soạn đề cương…</span>';
  try {
    const spec = await apiPost('/api/generate/outline', { content: answerText, includeExercises });
    const { blob, fileName } = await buildOutlineDocxBlob(spec);
    closeOutlineModal();
    appendFileMessage('docx', fileName, blob, buildOutlineSummaryHtml(spec));
  } catch (e) {
    console.error(e);
    closeOutlineModal();
    appendGenErrorMessage('Đề cương .docx', (e && e.message) || 'Không tạo được đề cương, vui lòng thử lại.', () => submitOutlineFromModal(answerText, includeExercises));
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
}
el('outlineConfirmBtn').onclick = () => {
  if (!activeOutlineCtx) return;
  const { answerText, includeExercises } = activeOutlineCtx;
  submitOutlineFromModal(answerText, includeExercises);
};

// Bấm 1 thẻ ghi chú đã lưu -> quay lại đúng cuộc trò chuyện + đúng câu trả lời của AI, cuộn tới
// và nhấp nháy nhẹ để dễ nhận ra, dữ liệu ghi chú của người dùng đã tự hiển thị sẵn ngay dưới câu
// trả lời đó (khối "Ghi chú của bạn" được vẽ lại mỗi lần message được render).
function goToNote(note) {
  closeSidebarOnMobile();
  const scrollToRow = () => {
    const row = threadEl.querySelector(`[data-msg-id="${CSS.escape(String(note.msgId))}"]`);
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.add('note-jump-highlight');
    setTimeout(() => row.classList.remove('note-jump-highlight'), 1600);
  };
  if (state.currentConvId !== note.convId) {
    loadConversation(note.convId, true);
    requestAnimationFrame(() => requestAnimationFrame(scrollToRow));
  } else {
    scrollToRow();
  }
}

/* ================= Danh mục công thức cốt lõi ================= */
function renderFormulaSubjectTabs() {
  const wrap = el('formulaSubjectTabs');
  wrap.innerHTML = (window.FORMULA_SUBJECTS || []).map((s) =>
    `<button class="fsubj-tab${s.key === state.formulaSubject ? ' active' : ''}" data-key="${s.key}">${s.icon} ${s.label}</button>`
  ).join('');
  wrap.querySelectorAll('.fsubj-tab').forEach((btn) => btn.onclick = () => {
    state.formulaSubject = btn.dataset.key;
    renderFormulaSubjectTabs();
    renderFormulaList();
  });
}
function renderFormulaList() {
  const grade = state.settings.grade;
  el('formulaGradeHint').textContent = (window.GRADE_LABELS[grade] || grade) + ' · chỉnh trong Cài đặt';
  const list = el('formulaList');
  const items = ((window.FORMULA_LIBRARY[state.formulaSubject] || {})[grade]) || [];
  if (!items.length) {
    list.innerHTML = `<div class="panel-empty">Chưa có dữ liệu công thức cho môn này ở ${(window.GRADE_LABELS[grade] || grade).toLowerCase()}. Hãy thử chọn môn hoặc khối lớp khác trong Cài đặt.</div>`;
    return;
  }
  list.innerHTML = items.map((it) => `
    <div class="formula-card">
      <div class="formula-name">${it.name.replace(/</g, '&lt;')}</div>
      <div class="formula-eq">$$${it.formula}$$</div>
      ${it.note ? `<div class="formula-note">${it.note.replace(/</g, '&lt;')}</div>` : ''}
    </div>
  `).join('');
  renderMath(list);
}

/* ================= Xây dựng khối UI cho 1 lượt AI (Hướng giải -> Lời giải chi tiết) =================
 * Trả về 1 wrapper duy nhất gồm (nếu có) khối "Ghi chú của bạn" đã ghim + hàng nút hành động.
 * wrapper._repaint() cho phép vẽ lại đúng khối này tại chỗ khi ghi chú được lưu/sửa/xóa, mà không
 * cần render lại toàn bộ câu trả lời (giữ nguyên vị trí cuộn, không nháy giao diện).
 *
 * buildStudyActions() vẽ ĐỦ 5 nút (Ghi chú/Xuất slide PPT/Flashcard/Đề cương .docx/Mindmap) — ĐÃ
 * LUÔN ĐƯỢC HIỂN THỊ ngay từ giai đoạn "Hướng giải" (không còn phải đợi tới "Lời giải chi tiết" mới
 * thấy), vì đây là các tính năng được khuyến nghị dùng ngay khi có bất kỳ câu trả lời nào — người
 * dùng có thể xuất slide/flashcard/mindmap chỉ từ phần Hướng giải mà không bắt buộc phải xem lời
 * giải chi tiết trước. Khi gọi cho giai đoạn Hướng giải, LUÔN truyền thêm extraClass
 * 'approach-note-block' để fetchDetail() có thể tìm và gỡ đúng khối này thay bằng khối đầy đủ của
 * giai đoạn Lời giải chi tiết (tránh hiển thị lặp 2 hàng nút) — xem fetchDetail().
 * buildNoteBlock() (chỉ đúng 1 nút Ghi chú) giờ CHỈ còn dùng cho các câu trả lời "1 lượt duy nhất"
 * không có nội dung bài toán để xuất PPT/flashcard/mindmap riêng (đề cương/mindmap được tạo trực
 * tiếp từ 1 lệnh gọi, đã có sẵn nút tải file/vẽ lại riêng của chúng). Cả 2 khối (nếu cùng tồn tại
 * tạm thời) đều đọc/ghi chung 1 msgObj.userNote nên luôn đồng bộ với nhau.
 */
function noteButtonHtml(hasNote) {
  return `<button class="study-btn note${hasNote ? ' has-note' : ''}" data-act="note">${ICONS.note}<span>${hasNote ? 'Sửa ghi chú' : 'Lưu ghi chú'}</span></button>`;
}
function notePinHtml(msgObj) {
  if (!msgObj || !msgObj.userNote) return '';
  return `<div class="note-pin">
      <div class="note-pin-head"><span>${ICONS.note}Ghi chú của bạn</span><span class="note-pin-time"></span></div>
      <div class="note-pin-text"></div>
    </div>`;
}
function fillNotePin(wrapper, msgObj) {
  if (!msgObj || !msgObj.userNote) return;
  wrapper.querySelector('.note-pin-text').textContent = msgObj.userNote;
  wrapper.querySelector('.note-pin-time').textContent = timeAgo(msgObj.userNoteAt || Date.now());
}

function paintStudyActions(wrapper, msgObj, answerText, aiRow) {
  const hasNote = !!(msgObj && msgObj.userNote);
  wrapper.innerHTML = `
    ${notePinHtml(msgObj)}
    <div class="study-actions">
      ${noteButtonHtml(hasNote)}
      <button class="study-btn ppt" data-act="ppt">${ICONS.presentation}<span>Xuất slide PPT</span></button>
      <button class="study-btn" data-act="flash">${ICONS.cards}<span>Flashcard ôn tập</span></button>
      <button class="study-btn outline" data-act="outline">${ICONS.outline}<span>Đề cương .docx</span></button>
      <button class="study-btn mindmap" data-act="mindmap">${ICONS.mindmap}<span>Mindmap trực quan</span></button>
    </div>
  `;
  fillNotePin(wrapper, msgObj);
  wrapper.querySelector('[data-act="note"]').onclick = () => openNoteModal(msgObj, currentConversation());
  wrapper.querySelector('[data-act="ppt"]').onclick = (e) => handleExportPPT(e.currentTarget, answerText);
  wrapper.querySelector('[data-act="flash"]').onclick = (e) => handleFlashcards(e.currentTarget, aiRow, answerText);
  wrapper.querySelector('[data-act="outline"]').onclick = () => openOutlineModal(answerText);
  wrapper.querySelector('[data-act="mindmap"]').onclick = (e) => handleMindmap(e.currentTarget, aiRow, answerText);
}
function buildStudyActions(msgObj, answerText, aiRow, extraClass) {
  const wrapper = document.createElement('div');
  wrapper.className = extraClass ? `study-wrap ${extraClass}` : 'study-wrap';
  wrapper._repaint = () => paintStudyActions(wrapper, msgObj, answerText, aiRow);
  wrapper._repaint();
  return wrapper;
}

function paintNoteBlock(wrapper, msgObj) {
  const hasNote = !!(msgObj && msgObj.userNote);
  wrapper.innerHTML = `
    ${notePinHtml(msgObj)}
    <div class="study-actions">${noteButtonHtml(hasNote)}</div>
  `;
  fillNotePin(wrapper, msgObj);
  wrapper.querySelector('[data-act="note"]').onclick = () => openNoteModal(msgObj, currentConversation());
}
function buildNoteBlock(msgObj) {
  const wrapper = document.createElement('div');
  wrapper.className = 'study-wrap approach-note-block';
  wrapper._repaint = () => paintNoteBlock(wrapper, msgObj);
  wrapper._repaint();
  return wrapper;
}

/**
 * Tạo 1 vùng "xem trước trực tiếp" trong lúc AI đang stream câu trả lời — chỉ hiển thị văn bản
 * thô (đã escape an toàn, KHÔNG render Markdown/KaTeX) kèm con trỏ nhấp nháy, vì cố render
 * Markdown/công thức LaTeX từng phần dở dang khi văn bản chưa đầy đủ rất dễ vỡ giao diện (chính là
 * lỗi công thức LaTeX bị cắt bởi <br> đã sửa ở renderMarkdownLite). Sau khi stream xong, nơi gọi tự
 * gỡ bỏ vùng preview này và gọi renderAnswerBlock() để render bản đầy đủ, đẹp, có công thức.
 */
function startStreamingPreview(container) {
  const wrap = document.createElement('div');
  wrap.className = 'stage-block streaming-preview';
  const statusLine = document.createElement('div');
  statusLine.className = 'stream-status';
  statusLine.style.display = 'none';
  const pre = document.createElement('div');
  pre.className = 'stream-text typing-cursor';
  wrap.appendChild(statusLine);
  wrap.appendChild(pre);
  container.appendChild(wrap);
  let text = '';
  return {
    wrap,
    append(delta) {
      if (!delta) return;
      text += delta;
      statusLine.style.display = 'none';
      pre.style.display = '';
      pre.textContent = text;
    },
    setStatus(message) {
      statusLine.style.display = '';
      statusLine.textContent = message || '';
    },
    getText: () => text
  };
}

function renderAnswerBlock(container, rawText) {
  const { thinking, answer } = extractThinking(rawText);
  if (thinking) {
    const details = document.createElement('details');
    details.className = 'thinking-block';
    details.innerHTML = '<summary>Xem quá trình suy luận sâu</summary><div class="think-body"></div>';
    details.querySelector('.think-body').textContent = thinking;
    container.appendChild(details);
  }
  const answerWrap = document.createElement('div');
  const { html, draws } = renderMarkdownLite(answer);
  answerWrap.innerHTML = html;
  container.appendChild(answerWrap);
  boxCommonMistakes(answerWrap);
  renderMath(container);
  draws.forEach((d) => renderDrawing(document.getElementById(d.id), d.kind, d.spec));
  return answer;
}

/**
 * Tìm tiêu đề "## Lỗi sai thường gặp" (nếu AI có đưa vào câu trả lời) và bọc riêng nó cùng toàn bộ
 * nội dung phía sau (tới tiêu đề <h3> tiếp theo hoặc hết câu trả lời) vào 1 khung cảnh báo màu cam
 * nổi bật — thay vì chỉ là một tiêu đề "##" trông giống hệt "Tóm tắt đề bài"/"Kết luận". Mục này
 * quan trọng cho việc ôn tập nên cần dễ nhận ra ngay bằng mắt, không lẫn vào các mục khác.
 */
function boxCommonMistakes(root) {
  const heading = Array.from(root.querySelectorAll('h3')).find((h) =>
    /lỗi\s*sai\s*thường\s*gặp/i.test(h.textContent || '')
  );
  if (!heading) return;
  const box = document.createElement('div');
  box.className = 'mistakes-box';
  const title = document.createElement('div');
  title.className = 'mistakes-box-title';
  title.innerHTML = `${ICONS.warning || '⚠️'}<span>${heading.textContent}</span>`;
  box.appendChild(title);
  heading.replaceWith(box);
  // Di chuyển mọi phần tử ngay sau vị trí cũ của heading (tới <h3> tiếp theo hoặc hết) vào trong khung.
  let node = box.nextSibling;
  while (node && !(node.nodeType === 1 && node.tagName === 'H3')) {
    const next = node.nextSibling;
    box.appendChild(node);
    node = next;
  }
}

function renderCitations(container, contexts, query) {
  if (!contexts || !contexts.length) return;
  const citeWrap = document.createElement('div');
  citeWrap.className = 'citations';
  citeWrap.innerHTML = '<div class="cite-title">Nguồn tham khảo</div>' +
    contexts.map((c, i) => `<div class="cite"><b>[${i + 1}] ${c.doc} · đoạn ${c.id}</b><br>${highlightSnippet(c.text, query)}</div>`).join('');
  container.appendChild(citeWrap);
  renderMath(citeWrap);
}

// Render lại đầy đủ 1 message AI đã lưu (khi mở lại cuộc trò chuyện cũ)
function renderStoredAiMessage(msg) {
  const aiRow = addAiMsg(msg.outlineSpec ? 'Đề cương' : msg.pptSpec ? 'Slide PPT' : msg.mindmapSpec ? 'Mindmap' : 'Trợ Giải');
  if (msg.id) aiRow.dataset.msgId = msg.id;
  const contentEl = aiRow.querySelector('.content');
  contentEl.innerHTML = '';

  // Tin nhắn đề cương trực tiếp (xem handleOutlineOnlyTurn) — 1 câu trả lời duy nhất, không có
  // giai đoạn "Hướng giải"/"Lời giải chi tiết" nào để dựng lại, chỉ cần vẽ lại đúng spec đã lưu.
  if (msg.outlineSpec) {
    renderOutlineAnswer(contentEl, msg.outlineSpec, msg, aiRow);
    return;
  }

  // Tương tự cho slide PPT trực tiếp (xem handlePPTOnlyTurn) — vẽ lại đúng spec đã lưu, không gọi
  // lại API.
  if (msg.pptSpec) {
    renderPPTAnswer(contentEl, msg.pptSpec, msg, aiRow);
    return;
  }

  // Tương tự cho mindmap trực tiếp (xem handleMindmapOnlyTurn) — vẽ lại sơ đồ từ spec đã lưu, không
  // gọi lại API.
  if (msg.mindmapSpec) {
    const wrap = document.createElement('div');
    wrap.className = 'mindmap-wrap';
    contentEl.appendChild(wrap);
    renderMindmap(wrap, msg.mindmapSpec);
    contentEl.appendChild(buildNoteBlock(msg));
    return;
  }

  const approachWrap = document.createElement('div');
  approachWrap.className = 'stage-block stage-approach';
  contentEl.appendChild(approachWrap);
  renderAnswerBlock(approachWrap, msg.approach || '');
  renderCitations(approachWrap, msg.contexts, msg.query);

  if (msg.detail) {
    appendDetailSection(contentEl, msg, aiRow);
  } else {
    // Luôn hiển thị đủ 5 nút chức năng (Ghi chú/PPT/Flashcard/Đề cương/Mindmap) ngay từ giai đoạn
    // Hướng giải — xem giải thích đầy đủ ở đầu buildStudyActions().
    contentEl.appendChild(buildStudyActions(msg, msg.approach || '', aiRow, 'approach-note-block'));
    const btnWrap = document.createElement('div');
    btnWrap.className = 'detail-btn-wrap';
    btnWrap.innerHTML = `<button class="detail-btn">${ICONS.compass}<span>Xem cách giải chi tiết</span></button>`;
    btnWrap.querySelector('.detail-btn').onclick = (e) => fetchDetail(e.currentTarget, aiRow, contentEl, msg, null);
    contentEl.appendChild(btnWrap);
  }
}

function appendDetailSection(contentEl, msg, aiRow) {
  const sep = document.createElement('div');
  sep.className = 'stage-divider';
  sep.innerHTML = '<span>Lời giải chi tiết</span>';
  contentEl.appendChild(sep);

  const detailWrap = document.createElement('div');
  detailWrap.className = 'stage-block stage-detail';
  contentEl.appendChild(detailWrap);
  const answerPlain = renderAnswerBlock(detailWrap, msg.detail || '');
  renderCitations(detailWrap, msg.contexts, msg.query);

  if (msg.crossChecked) {
    const badge = document.createElement('div');
    badge.className = 'crosscheck-badge';
    const providers = Array.isArray(msg.providers) && msg.providers.length ? msg.providers : null;
    const modelsPart = providers
      ? `✔️ Đã đối chiếu ${providers.length} lượt giải độc lập (${providers.join(', ')})`
      : '✔️ Đã đối chiếu 2 hướng giải độc lập';
    const reconcilePart = msg.reconciledBy ? ` — tổng hợp bởi ${msg.reconciledBy}` : '';
    badge.innerHTML = modelsPart + reconcilePart + (msg.contexts && msg.contexts.length ? ' + đối chiếu với nguồn tài liệu' : ' + xác minh công thức qua tìm kiếm web');
    contentEl.appendChild(badge);
  }

  contentEl.appendChild(buildStudyActions(msg, answerPlain, aiRow));
}

/* ================= Gửi câu hỏi (2 giai đoạn: Hướng giải -> Lời giải chi tiết) ================= */
el('qInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
el('qInput').addEventListener('input', function () { this.style.height = 'auto'; this.style.height = Math.min(this.scrollHeight, 150) + 'px'; });
el('sendBtn').onclick = sendMessage;

function finalizePendingTurnIfAny() {
  // Nếu lượt trước đó chỉ mới có "Hướng giải" mà người dùng chưa bấm xem chi tiết,
  // vẫn lưu tạm hướng giải vào ngữ cảnh để AI không bị mất mạch khi hỏi tiếp câu khác.
  if (!pendingTurn) return;
  state.history.push({ role: 'user', content: pendingTurn.query || '[Người dùng đã gửi ảnh đề bài để giải]' });
  state.history.push({ role: 'assistant', content: pendingTurn.approachRaw || '' });
  if (state.history.length > 20) state.history = state.history.slice(-20);
  pendingTurn = null;
}

async function sendMessage() {
  const input = el('qInput');
  const query = input.value.trim();
  const image = state.pendingImage;
  if (!query && !image) return;
  input.value = ''; input.style.height = 'auto';

  // Khởi động tìm "Đề xuất ôn tập" NGAY khi gửi câu hỏi, chạy SONG SONG (không await) với toàn bộ
  // luồng giải bài bên dưới — khung bên phải tự cập nhật khi có kết quả, không làm chậm phần trả
  // lời chính. Bỏ qua nếu chỉ gửi ảnh (chưa có văn bản để xác định chủ đề).
  if (query) scheduleRecommend(query);

  // Nếu người dùng CHỈ đang xin đề/bài tập ôn tập (không kèm 1 bài toán cụ thể cần giải), theo yêu
  // cầu: KHÔNG cần AI giải gì cả — chỉ cần khung "Đề xuất ôn tập" ở trên hiện ra là đủ.
  const examOnly = !!query && !image && isExamOnlyRequest(query);
  // Nếu người dùng đang xin SOẠN ĐỀ CƯƠNG (tóm tắt/hệ thống hóa kiến thức) — theo yêu cầu rework:
  // KHÔNG chia thành 2 giai đoạn "Hướng giải" -> (bấm) -> "Lời giải chi tiết" như 1 bài toán thông
  // thường. Toàn bộ được xử lý trong 1 LƯỢT GỌI AI DUY NHẤT (handleOutlineOnlyTurn), trả về ĐÚNG 1
  // câu trả lời (đề cương hiển thị ngay trong khung chat) KÈM file .docx tải được ngay bên dưới —
  // không có bước "Xem cách giải chi tiết" nào ở giữa.
  const outlineOnly = !examOnly && !!query && !image && isOutlineRequest(query);
  // Tương tự đề cương: nếu người dùng đang xin LÀM SLIDE PPT trực tiếp (không kèm bài toán cụ thể) —
  // cùng triết lý: 1 lượt gọi AI duy nhất (handlePPTOnlyTurn), hiện ngay nội dung slide đã tạo trong
  // khung chat KÈM file .pptx tải được ngay bên dưới, không qua 2 giai đoạn Hướng giải/Lời giải chi
  // tiết. Trước đây PPT CHỈ tạo được bằng cách bấm nút "Xuất slide PPT" SAU KHI đã có 1 câu trả lời —
  // giờ gõ thẳng yêu cầu trong chat cũng hoạt động, giống hệt đề cương.
  const pptOnly = !examOnly && !outlineOnly && !!query && !image && isPPTRequest(query);
  // Tương tự đề cương: nếu người dùng đang chủ động xin VẼ MINDMAP/SƠ ĐỒ TÓM TẮT (không phải giải 1
  // bài toán cụ thể) — xử lý trong 1 lượt duy nhất (handleMindmapOnlyTurn), hiển thị sơ đồ trực quan
  // ngay trong khung chat, không qua 2 giai đoạn Hướng giải/Lời giải chi tiết.
  const mindmapOnly = !examOnly && !outlineOnly && !pptOnly && !!query && !image && isMindmapRequest(query);

  el('sendBtn').disabled = true;
  statusEl.textContent = image ? 'ĐANG ĐỌC ĐỀ BÀI…' : (examOnly ? 'ĐANG TÌM TÀI LIỆU LIÊN QUAN…' : (outlineOnly ? 'ĐANG SOẠN ĐỀ CƯƠNG…' : (pptOnly ? 'ĐANG TẠO SLIDE PPT…' : (mindmapOnly ? 'ĐANG VẼ MINDMAP…' : 'ĐANG TÌM HƯỚNG GIẢI…'))));

  finalizePendingTurnIfAny();

  addUserMsg(query, image ? image.url : null);
  state.pendingImage = null; renderImagePreview();

  const conv = currentConversation();
  const userMsgObj = { role: 'user', text: query, hadImage: !!image };
  conv.messages.push(userMsgObj);
  if (conv.messages.filter((m) => m.role === 'user').length === 1) conv.title = autoTitleFromQuery(query || '[Ảnh đề bài]');

  if (examOnly) {
    const aiMsgObj = { id: uid(), role: 'ai', query, approach: '', detail: null, contexts: [], crossChecked: false };
    const aiRow = addAiMsg('Trợ Giải');
    const contentEl = aiRow.querySelector('.content');
    const note = 'Mình đã tìm các đề/bài tập ôn tập liên quan ở khung <strong>📚 Đề xuất ôn tập</strong> bên phải màn hình — bạn xem thử nhé! Nếu muốn giải cụ thể 1 bài, cứ dán hẳn đề bài vào đây.';
    aiMsgObj.approach = note;
    contentEl.innerHTML = `<p>${note}</p>`;
    conv.messages.push(aiMsgObj);
    touchConversation(conv);
    el('sendBtn').disabled = false;
    statusEl.textContent = 'SẴN SÀNG';
    threadEl.scrollTop = threadEl.scrollHeight;
    return;
  }

  if (outlineOnly) {
    await handleOutlineOnlyTurn(query, conv);
    return;
  }

  if (pptOnly) {
    await handlePPTOnlyTurn(query, conv);
    return;
  }

  if (mindmapOnly) {
    await handleMindmapOnlyTurn(query, conv);
    return;
  }

  const contexts = retrieveContext(query, 4);
  const aiMsgObj = { id: uid(), role: 'ai', query, approach: '', detail: null, contexts, crossChecked: false };
  const aiRow = addAiMsg('Hướng giải');
  aiRow.dataset.msgId = aiMsgObj.id;
  const contentEl = aiRow.querySelector('.content');
  conv.messages.push(aiMsgObj);
  touchConversation(conv);

  contentEl.innerHTML = '';
  const preview = startStreamingPreview(contentEl);

  try {
    const data = await apiPostStream('/api/chat', {
      query, deepThinking: state.deepThinking, crossCheck: state.crossCheck, stage: 'approach',
      image: image ? { mediaType: image.mediaType, base64: image.base64 } : null,
      rules: state.rules, contexts, settings: state.settings, history: state.history
    }, {
      onDelta: (piece) => { preview.append(piece); threadEl.scrollTop = threadEl.scrollHeight; },
      onStatus: (msg) => preview.setStatus(msg)
    });
    const raw = data.text || preview.getText() || 'Xin lỗi, không nhận được phản hồi. Vui lòng thử lại.';
    aiMsgObj.approach = raw;
    aiMsgObj.approachProvider = data.provider || null;
    touchConversation(conv);

    contentEl.innerHTML = '';
    const approachWrap = document.createElement('div');
    approachWrap.className = 'stage-block stage-approach';
    contentEl.appendChild(approachWrap);
    renderAnswerBlock(approachWrap, raw);
    renderCitations(approachWrap, contexts, query);
    // Luôn hiển thị đủ 5 nút chức năng (Ghi chú/PPT/Flashcard/Đề cương/Mindmap) ngay từ giai đoạn
    // Hướng giải — xem giải thích đầy đủ ở đầu buildStudyActions().
    contentEl.appendChild(buildStudyActions(aiMsgObj, raw, aiRow, 'approach-note-block'));

    const btnWrap = document.createElement('div');
    btnWrap.className = 'detail-btn-wrap';
    btnWrap.innerHTML = `<button class="detail-btn">${ICONS.compass}<span>Xem cách giải chi tiết</span></button>`;
    contentEl.appendChild(btnWrap);
    const detailBtn = btnWrap.querySelector('.detail-btn');

    pendingTurn = { query, image, approachRaw: raw, msgObj: aiMsgObj };
    detailBtn.onclick = () => fetchDetail(detailBtn, aiRow, contentEl, aiMsgObj, image);
  } catch (e) {
    const msg = (e && e.message) || 'Có lỗi khi kết nối tới máy chủ.';
    // escape HTML thô sơ rồi mới chèn — thông báo lỗi có thể chứa nội dung từ phản hồi API bên
    // ngoài (OpenAI/Gemini/...), không nên tin tưởng tuyệt đối khi ghép vào innerHTML.
    const escaped = msg.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
    contentEl.innerHTML = `<p style="color:#c0392b;white-space:pre-wrap;">⚠️ ${escaped}</p>`;
    console.error(e);
  } finally {
    el('sendBtn').disabled = false;
    statusEl.textContent = 'SẴN SÀNG';
    threadEl.scrollTop = threadEl.scrollHeight;
  }
}

async function fetchDetail(btn, aiRow, contentEl, msgObj, image) {
  btn.disabled = true;
  const { deepThinking, crossCheck } = state;
  // Nhãn/trạng thái ở bước này theo cờ "Đối chiếu đa hướng" — đây là cờ thực sự quyết định server
  // có chạy nhiều lượt giải song song + tổng hợp hay không (xem chat.js); "Suy nghĩ sâu" chỉ ảnh
  // hưởng nội dung suy luận NỘI BỘ của từng lượt gọi, không đổi số lượt gọi hay luồng UI ở đây.
  btn.innerHTML = `<span class="typing"><span></span><span></span><span></span></span><span>${crossCheck ? 'Đang đối chiếu đa hướng…' : 'Đang giải chi tiết…'}</span>`;
  statusEl.textContent = crossCheck ? 'ĐANG ĐỐI CHIẾU ĐA HƯỚNG…' : 'ĐANG GIẢI CHI TIẾT…';

  const preview = startStreamingPreview(contentEl);
  if (crossCheck) preview.setStatus('Đang đối chiếu đa hướng…');

  try {
    const data = await apiPostStream('/api/chat', {
      query: msgObj.query, deepThinking, crossCheck, stage: 'detail', approachText: msgObj.approach,
      image: image ? { mediaType: image.mediaType, base64: image.base64 } : null,
      rules: state.rules, contexts: msgObj.contexts, settings: state.settings, history: state.history
    }, {
      onDelta: (piece) => { preview.append(piece); threadEl.scrollTop = threadEl.scrollHeight; },
      onStatus: (msg) => preview.setStatus(msg)
    });
    const raw = data.text || preview.getText() || 'Xin lỗi, không nhận được phản hồi. Vui lòng thử lại.';
    msgObj.detail = raw;
    msgObj.crossChecked = !!data.crossChecked;
    msgObj.providers = Array.isArray(data.providers) ? data.providers : null;
    msgObj.reconciledBy = data.reconciledBy || null;
    msgObj.provider = data.provider || null;

    preview.wrap.remove();
    btn.closest('.detail-btn-wrap').remove();
    // Gỡ khối "Ghi chú" tạm ở giai đoạn Hướng giải — từ giờ đã có khối ghi chú đầy đủ (kèm PPT/
    // Flashcard) ngay dưới Lời giải chi tiết, dùng chung đúng msgObj nên không mất ghi chú đã lưu.
    const approachNoteBlock = contentEl.querySelector('.approach-note-block');
    if (approachNoteBlock) approachNoteBlock.remove();
    appendDetailSection(contentEl, msgObj, aiRow);

    state.history.push({ role: 'user', content: msgObj.query || '[Người dùng đã gửi ảnh đề bài để giải]' });
    state.history.push({ role: 'assistant', content: raw });
    if (state.history.length > 20) state.history = state.history.slice(-20);
    if (pendingTurn && pendingTurn.msgObj === msgObj) pendingTurn = null;

    const conv = currentConversation();
    if (conv) touchConversation(conv);
  } catch (e) {
    preview.wrap.remove();
    btn.disabled = false;
    btn.innerHTML = `${ICONS.compass}<span>Xem cách giải chi tiết (thử lại)</span>`;
    alert((e && e.message) || 'Không lấy được lời giải chi tiết, vui lòng thử lại.');
    console.error(e);
  } finally {
    statusEl.textContent = 'SẴN SÀNG';
    threadEl.scrollTop = threadEl.scrollHeight;
  }
}

/* ================= Đề cương trực tiếp: 1 lượt duy nhất (không tách Hướng giải/Lời giải chi tiết) =================
 * Kích hoạt khi isOutlineRequest(query) nhận diện người dùng đang xin SOẠN ĐỀ CƯƠNG chứ không phải
 * giải 1 bài toán cụ thể. Khác hẳn luồng sendMessage() bình thường (2 giai đoạn, cần bấm "Xem cách
 * giải chi tiết"), ở đây chỉ có ĐÚNG 1 lệnh gọi tới POST /api/generate/outline: kết quả JSON nhận về
 * được dùng để (1) hiển thị NGAY 1 câu trả lời duy nhất trong khung chat và (2) dựng sẵn file .docx
 * kèm theo ngay bên dưới câu trả lời đó — người dùng bấm 1 nút là file được gửi vào khung chat, không
 * cần mở modal riêng hay quay lại giải bài trước. Vẫn tái sử dụng buildOutlineDocxBlob() đã có sẵn để
 * đảm bảo file .docx tạo ra giống hệt cấu trúc/định dạng như đường tạo đề cương thủ công (từ 1 câu
 * trả lời đã giải).
 */
async function handleOutlineOnlyTurn(query, conv) {
  const contexts = retrieveContext(query, 4);
  const aiMsgObj = { id: uid(), role: 'ai', query, approach: '', detail: null, contexts: [], crossChecked: false, outlineSpec: null };
  const aiRow = addAiMsg('Đề cương');
  aiRow.dataset.msgId = aiMsgObj.id;
  const contentEl = aiRow.querySelector('.content');
  conv.messages.push(aiMsgObj);
  touchConversation(conv);

  try {
    const includeExercises = /bài tập|luyện tập|kèm.*(bài|câu)/.test(query.toLowerCase());
    const sourceContent = contexts.length
      ? query + '\n\nNguồn tài liệu liên quan đã nạp:\n' + contexts.map((c, i) => `[${i + 1}] (${c.doc}) ${c.text}`).join('\n')
      : query;
    const spec = await apiPost('/api/generate/outline', { content: sourceContent, includeExercises });

    aiMsgObj.outlineSpec = spec;
    aiMsgObj.approach = outlineSpecToPlainText(spec); // dùng làm ngữ cảnh (state.history) cho câu hỏi tiếp theo

    contentEl.innerHTML = '';
    renderOutlineAnswer(contentEl, spec, aiMsgObj, aiRow);
    touchConversation(conv);

    state.history.push({ role: 'user', content: query });
    state.history.push({ role: 'assistant', content: aiMsgObj.approach });
    if (state.history.length > 20) state.history = state.history.slice(-20);
  } catch (e) {
    const msg = (e && e.message) || 'Không soạn được đề cương, vui lòng thử lại.';
    contentEl.innerHTML = `
      <div class="gen-error-card">
        <p class="gen-error-text">⚠️ ${escapeHtml(msg)}</p>
        <button class="gen-error-retry" type="button">${ICONS.refresh}<span>Thử lại</span></button>
      </div>`;
    contentEl.querySelector('.gen-error-retry').onclick = () => {
      aiRow.remove();
      const idx = conv.messages.indexOf(aiMsgObj);
      if (idx !== -1) conv.messages.splice(idx, 1);
      handleOutlineOnlyTurn(query, conv);
    };
    console.error(e);
  } finally {
    el('sendBtn').disabled = false;
    statusEl.textContent = 'SẴN SÀNG';
    threadEl.scrollTop = threadEl.scrollHeight;
  }
}

/* ================= Slide PPT trực tiếp: 1 lượt duy nhất (mirror handleOutlineOnlyTurn) =================
 * Kích hoạt khi isPPTRequest(query) nhận diện người dùng đang xin LÀM SLIDE PPT chứ không phải giải 1
 * bài toán cụ thể. Cùng triết lý với handleOutlineOnlyTurn(): ĐÚNG 1 lượt gọi AI tới
 * POST /api/generate/ppt-outline, kết quả JSON được dùng để (1) hiển thị NGAY nội dung slide đã tạo
 * (tiêu đề + từng slide) trong khung chat và (2) dựng sẵn file .pptx kèm theo — người dùng bấm nút là
 * file được gửi vào khung chat, không cần trước đó phải có 1 câu trả lời để bấm nút "Xuất slide PPT".
 */
async function handlePPTOnlyTurn(query, conv) {
  const contexts = retrieveContext(query, 4);
  const aiMsgObj = { id: uid(), role: 'ai', query, approach: '', detail: null, contexts: [], crossChecked: false, pptSpec: null };
  const aiRow = addAiMsg('Slide PPT');
  aiRow.dataset.msgId = aiMsgObj.id;
  const contentEl = aiRow.querySelector('.content');
  conv.messages.push(aiMsgObj);
  touchConversation(conv);

  try {
    const sourceContent = contexts.length
      ? query + '\n\nNguồn tài liệu liên quan đã nạp:\n' + contexts.map((c, i) => `[${i + 1}] (${c.doc}) ${c.text}`).join('\n')
      : query;
    const spec = await apiPost('/api/generate/ppt-outline', { content: sourceContent });

    aiMsgObj.pptSpec = spec;
    aiMsgObj.approach = pptSpecToPlainText(spec); // dùng làm ngữ cảnh (state.history) cho câu hỏi tiếp theo

    contentEl.innerHTML = '';
    renderPPTAnswer(contentEl, spec, aiMsgObj, aiRow);
    touchConversation(conv);

    state.history.push({ role: 'user', content: query });
    state.history.push({ role: 'assistant', content: aiMsgObj.approach });
    if (state.history.length > 20) state.history = state.history.slice(-20);
  } catch (e) {
    const msg = (e && e.message) || 'Không tạo được slide PPT, vui lòng thử lại.';
    contentEl.innerHTML = `
      <div class="gen-error-card">
        <p class="gen-error-text">⚠️ ${escapeHtml(msg)}</p>
        <button class="gen-error-retry" type="button">${ICONS.refresh}<span>Thử lại</span></button>
      </div>`;
    contentEl.querySelector('.gen-error-retry').onclick = () => {
      aiRow.remove();
      const idx = conv.messages.indexOf(aiMsgObj);
      if (idx !== -1) conv.messages.splice(idx, 1);
      handlePPTOnlyTurn(query, conv);
    };
    console.error(e);
  } finally {
    el('sendBtn').disabled = false;
    statusEl.textContent = 'SẴN SÀNG';
    threadEl.scrollTop = threadEl.scrollHeight;
  }
}

// Chuyển spec slide PPT (JSON) thành văn bản thuần — dùng làm state.history (ngữ cảnh hội thoại cho
// AI ở lượt hỏi tiếp theo), KHÔNG dùng để hiển thị (xem renderPPTAnswer).
function pptSpecToPlainText(spec) {
  if (!spec) return '';
  const lines = [];
  if (spec.title) lines.push(spec.title);
  if (spec.subtitle) lines.push(spec.subtitle);
  (spec.slides || []).forEach((sl) => {
    lines.push('## ' + (sl.heading || ''));
    (sl.bullets || []).forEach((b) => lines.push(`- ${b}`));
  });
  return lines.join('\n');
}

// Hiển thị 1 spec slide PPT (đến từ /api/generate/ppt-outline) thành 1 khối câu trả lời hoàn chỉnh
// trong khung chat + nút tạo/gửi file .pptx đi kèm ngay bên dưới — mirror renderOutlineAnswer(). Dùng
// chung cho cả lượt tạo mới (handlePPTOnlyTurn) LẪN khi mở lại cuộc trò chuyện cũ
// (renderStoredAiMessage) nên KHÔNG gọi lại API — spec đã có sẵn trong msgObj.pptSpec.
function renderPPTAnswer(contentEl, spec, msgObj, aiRow) {
  const esc = escapeHtml;
  const wrap = document.createElement('div');
  wrap.className = 'stage-block outline-answer';

  let html = `<h3 class="outline-title">${esc(spec.title || 'Bài trình chiếu')}</h3>`;
  if (spec.subtitle) html += `<p class="outline-overview">${esc(spec.subtitle)}</p>`;

  (spec.slides || []).forEach((sl, i) => {
    html += `<div class="outline-section"><h4>Slide ${i + 2}: ${esc(sl.heading || '')}</h4>`;
    if ((sl.bullets || []).length) {
      html += '<ul class="outline-keypoints">' + sl.bullets.map((b) => `<li>${esc(b)}</li>`).join('') + '</ul>';
    }
    html += '</div>';
  });

  wrap.innerHTML = html;
  contentEl.appendChild(wrap);
  renderMath(wrap);

  const fileWrap = document.createElement('div');
  fileWrap.className = 'outline-file-wrap';
  fileWrap.innerHTML = `<button class="outline-download-btn" type="button">${ICONS.presentation}<span>Xuất file .pptx slide này</span></button><span class="outline-file-hint">File sẽ được gửi vào khung chat, bấm "Tải xuống" trên tin nhắn để lưu về máy.</span>`;
  const dlBtn = fileWrap.querySelector('.outline-download-btn');
  const buildAndSend = async () => {
    const original = dlBtn.innerHTML;
    dlBtn.disabled = true;
    dlBtn.innerHTML = '<span>Đang tạo file…</span>';
    try {
      const { blob, fileName } = await buildPPTBlob(spec);
      appendFileMessage('pptx', fileName, blob, buildPPTSummaryHtml(spec));
    } catch (e) {
      console.error(e);
      appendGenErrorMessage('Slide PPT', (e && e.message) || 'Không tạo được file PPT, vui lòng thử lại.', buildAndSend);
    } finally {
      dlBtn.disabled = false;
      dlBtn.innerHTML = original;
    }
  };
  dlBtn.onclick = buildAndSend;
  contentEl.appendChild(fileWrap);
  contentEl.appendChild(buildNoteBlock(msgObj));
}

// Chuyển spec đề cương (JSON) thành văn bản thuần — dùng làm state.history (ngữ cảnh hội thoại cho
// AI ở lượt hỏi tiếp theo) và khi cần copy nhanh, KHÔNG dùng để hiển thị (xem renderOutlineAnswer).
function outlineSpecToPlainText(spec) {
  if (!spec) return '';
  const lines = [];
  if (spec.title) lines.push(spec.title);
  if (spec.overview) lines.push(spec.overview);
  (spec.sections || []).forEach((sec) => {
    lines.push('## ' + (sec.heading || ''));
    (sec.definitions || []).forEach((d) => lines.push(`- ${d.term}: ${d.definition}`));
    (sec.formulas || []).forEach((f) => lines.push(`- ${f.name}: ${f.expression}${f.note ? ' (' + f.note + ')' : ''}`));
    (sec.keypoints || []).forEach((k) => lines.push(`- ${k}`));
  });
  return lines.join('\n');
}

// Hiển thị 1 spec đề cương (đến từ /api/generate/outline) thành 1 khối câu trả lời hoàn chỉnh trong
// khung chat + nút tải file .docx đi kèm ngay bên dưới. Dùng chung cho cả lượt tạo mới
// (handleOutlineOnlyTurn) LẪN khi mở lại cuộc trò chuyện cũ (renderStoredAiMessage) nên KHÔNG gọi lại
// API — spec đã có sẵn trong msgObj.outlineSpec, chỉ dựng lại giao diện + file từ đúng dữ liệu đó.
function renderOutlineAnswer(contentEl, spec, msgObj, aiRow) {
  const esc = escapeHtml;
  const wrap = document.createElement('div');
  wrap.className = 'stage-block outline-answer';

  let html = `<h3 class="outline-title">${esc(spec.title || 'Đề cương')}</h3>`;
  if (spec.overview) html += `<p class="outline-overview">${esc(spec.overview)}</p>`;

  (spec.sections || []).forEach((sec) => {
    html += `<div class="outline-section"><h4>${esc(sec.heading || '')}</h4>`;
    if ((sec.definitions || []).length) {
      html += '<ul class="outline-defs">' +
        sec.definitions.map((d) => `<li><b>${esc(d.term)}:</b> ${esc(d.definition)}</li>`).join('') + '</ul>';
    }
    if ((sec.formulas || []).length) {
      html += '<div class="outline-formulas">' + sec.formulas.map((f) => `
        <div class="outline-formula">
          <div class="outline-formula-name">${esc(f.name)}</div>
          <div class="outline-formula-expr">$$${f.expression}$$</div>
          ${f.note ? `<div class="outline-formula-note">${esc(f.note)}</div>` : ''}
        </div>`).join('') + '</div>';
    }
    if ((sec.keypoints || []).length) {
      html += '<ul class="outline-keypoints">' + sec.keypoints.map((k) => `<li>${esc(k)}</li>`).join('') + '</ul>';
    }
    html += '</div>';
  });

  if (Array.isArray(spec.exercises) && spec.exercises.length) {
    html += '<div class="outline-exercises"><h4>Bài tập ôn tập theo mức độ</h4>';
    spec.exercises.forEach((lvl) => {
      html += `<div class="outline-exlevel"><div class="outline-exlevel-title">${esc(lvl.level || '')}</div><ol>` +
        (lvl.items || []).map((it) => `<li>${esc(it.question)}<div class="outline-exhint">Đáp án: ${esc(it.answer)}</div></li>`).join('') +
        '</ol></div>';
    });
    html += '</div>';
  }

  if (spec.sourceNote) html += `<div class="outline-source-note">📎 ${esc(spec.sourceNote)}</div>`;

  wrap.innerHTML = html;
  contentEl.appendChild(wrap);
  renderMath(wrap);

  const fileWrap = document.createElement('div');
  fileWrap.className = 'outline-file-wrap';
  fileWrap.innerHTML = `<button class="outline-download-btn" type="button">${ICONS.outline}<span>Xuất file .docx đề cương này</span></button><span class="outline-file-hint">File sẽ được gửi vào khung chat, bấm "Tải xuống" trên tin nhắn để lưu về máy.</span>`;
  const dlBtn = fileWrap.querySelector('.outline-download-btn');
  const buildAndSend = async () => {
    const original = dlBtn.innerHTML;
    dlBtn.disabled = true;
    dlBtn.innerHTML = '<span>Đang tạo file…</span>';
    try {
      const { blob, fileName } = await buildOutlineDocxBlob(spec);
      appendFileMessage('docx', fileName, blob, buildOutlineSummaryHtml(spec));
    } catch (e) {
      console.error(e);
      appendGenErrorMessage('Đề cương .docx', (e && e.message) || 'Không tạo được file .docx, vui lòng thử lại.', buildAndSend);
    } finally {
      dlBtn.disabled = false;
      dlBtn.innerHTML = original;
    }
  };
  dlBtn.onclick = buildAndSend;
  contentEl.appendChild(fileWrap);
  contentEl.appendChild(buildNoteBlock(msgObj));
}

/* ================= Học tập: Xuất PPT & Flashcard ================= */
async function handleExportPPT(btn, answerText) {
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span>Đang tạo slide…</span>';
  try {
    const spec = await apiPost('/api/generate/ppt-outline', { content: answerText });
    const { blob, fileName } = await buildPPTBlob(spec);
    appendFileMessage('pptx', fileName, blob, buildPPTSummaryHtml(spec));
  } catch (e) {
    console.error(e);
    appendGenErrorMessage('Slide PPT', (e && e.message) || 'Không tạo được file PPT, vui lòng thử lại.', () => handleExportPPT(btn, answerText));
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

// Dựng file .pptx thật ở client bằng pptxgenjs, trả về {blob, fileName} thay vì tự tải xuống ngay
// (pptx.writeFile cũ) — người gọi (handleExportPPT) gói kết quả này thành 1 tin nhắn trong khung chat
// qua appendFileMessage(), xem chi tiết lý do ở comment của appendFileMessage().
async function buildPPTBlob(spec) {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'WIDE', width: 13.33, height: 7.5 });
  pptx.layout = 'WIDE';
  const NAVY = '0A1120', PRIMARY = '2955FF';

  let s = pptx.addSlide();
  s.background = { color: NAVY };
  s.addShape('rect', { x: 0, y: 3.1, w: 0.14, h: 1.3, fill: { color: PRIMARY } });
  s.addText(spec.title || 'Bài trình chiếu', { x: 0.7, y: 2.9, w: 11.9, h: 1.4, fontFace: 'Arial', fontSize: 36, bold: true, color: 'FFFFFF' });
  if (spec.subtitle) s.addText(spec.subtitle, { x: 0.7, y: 4.15, w: 11.9, h: 0.6, fontFace: 'Arial', fontSize: 16, color: 'A9C2FF' });
  s.addText('Tạo bởi Trợ Giải · AI học tập', { x: 0.7, y: 6.9, w: 8, h: 0.4, fontFace: 'Arial', fontSize: 10.5, color: '6B7593' });

  (spec.slides || []).forEach((sl) => {
    const sd = pptx.addSlide();
    sd.background = { color: 'FFFFFF' };
    sd.addShape('rect', { x: 0, y: 0, w: 13.33, h: 0.9, fill: { color: 'F3F5F9' } });
    sd.addShape('rect', { x: 0, y: 0.88, w: 13.33, h: 0.03, fill: { color: PRIMARY } });
    sd.addText(sl.heading || '', { x: 0.6, y: 0.18, w: 12.1, h: 0.6, fontFace: 'Arial', fontSize: 22, bold: true, color: '0E1524' });
    const bullets = (sl.bullets || []).map((b) => ({ text: b, options: { bullet: { code: '25CF', color: PRIMARY }, color: '0E1524', breakLine: true } }));
    if (bullets.length) sd.addText(bullets, { x: 0.8, y: 1.3, w: 11.7, h: 5.3, fontFace: 'Arial', fontSize: 18, lineSpacing: 34, valign: 'top' });
    if (sl.note) sd.addNotes(sl.note);
  });

  const last = pptx.addSlide();
  last.background = { color: NAVY };
  last.addText('Cảm ơn!', { x: 0.7, y: 3.1, w: 11.9, h: 1, fontFace: 'Arial', fontSize: 32, bold: true, color: 'FFFFFF' });
  last.addText('Trợ Giải · AI học tập', { x: 0.7, y: 4.0, w: 11.9, h: 0.5, fontFace: 'Arial', fontSize: 14, color: 'A9C2FF' });

  const fname = (spec.title || 'bai-trinh-chieu').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60) || 'bai-trinh-chieu';
  const blob = await pptx.write({ outputType: 'blob' });
  return { blob, fileName: fname + '.pptx' };
}

/* ================= Đề cương: dựng file .docx thật bằng docx.js (thư viện tải qua CDN) =================
 * spec đến từ POST /api/generate/outline (xem server/utils/promptBuilder.js#buildOutlineSystemPrompt
 * để biết đúng schema). Công thức toán ở "expression" là LaTeX thuần (không có $) — docx.js không tự
 * render LaTeX thành ký hiệu toán học native của Word, nên hiển thị dưới dạng văn bản in nghiêng,
 * font Cambria Math, kèm khối nền nhạt để dễ phân biệt với văn bản thường — vẫn đọc được rõ ràng,
 * đúng nội dung công thức, chỉ không phải khối phương trình OMML có thể bấm sửa như gõ tay trong Word.
 */
// Dựng file .docx thật ở client bằng docx.js, trả về {blob, fileName} thay vì tự tải xuống ngay
// (hành vi cũ) — mọi nơi gọi hàm này giờ gói kết quả thành 1 tin nhắn trong khung chat qua
// appendFileMessage(), xem chi tiết lý do ở comment của appendFileMessage().
async function buildOutlineDocxBlob(spec) {
  const {
    Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, BorderStyle
  } = docx;
  const PRIMARY = '2955FF', MUTED = '6B7593', INK = '0E1524';

  const children = [];

  children.push(new Paragraph({
    text: spec.title || 'Đề cương',
    heading: HeadingLevel.TITLE,
    alignment: AlignmentType.CENTER,
    spacing: { after: 120 }
  }));
  if (spec.overview) {
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 320 },
      children: [new TextRun({ text: spec.overview, italics: true, color: MUTED, size: 21 })]
    }));
  }

  (spec.sections || []).forEach((sec) => {
    children.push(new Paragraph({
      text: sec.heading || '',
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 260, after: 120 },
      border: { bottom: { color: PRIMARY, space: 4, style: BorderStyle.SINGLE, size: 6 } }
    }));

    if ((sec.definitions || []).length) {
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_3,
        spacing: { before: 120, after: 80 },
        children: [new TextRun({ text: 'Định nghĩa', color: PRIMARY })]
      }));
      sec.definitions.forEach((d) => {
        children.push(new Paragraph({
          bullet: { level: 0 },
          spacing: { after: 60 },
          children: [
            new TextRun({ text: (d.term || '') + ': ', bold: true }),
            new TextRun({ text: d.definition || '' })
          ]
        }));
      });
    }

    if ((sec.formulas || []).length) {
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_3,
        spacing: { before: 140, after: 80 },
        children: [new TextRun({ text: 'Công thức quan trọng', color: PRIMARY })]
      }));
      sec.formulas.forEach((f) => {
        if (f.name) {
          children.push(new Paragraph({
            spacing: { before: 60, after: 20 },
            children: [new TextRun({ text: f.name, bold: true, size: 21, color: INK })]
          }));
        }
        children.push(new Paragraph({
          spacing: { after: f.note ? 20 : 80 },
          indent: { left: 260 },
          shading: { fill: 'F3F5F9' },
          children: [new TextRun({ text: f.expression || '', italics: true, font: 'Cambria Math', size: 24 })]
        }));
        if (f.note) {
          children.push(new Paragraph({
            spacing: { after: 80 },
            indent: { left: 260 },
            children: [new TextRun({ text: f.note, color: MUTED, size: 19 })]
          }));
        }
      });
    }

    if ((sec.keypoints || []).length) {
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_3,
        spacing: { before: 140, after: 80 },
        children: [new TextRun({ text: 'Lưu ý quan trọng', color: PRIMARY })]
      }));
      sec.keypoints.forEach((k) => {
        children.push(new Paragraph({ bullet: { level: 0 }, spacing: { after: 50 }, text: k }));
      });
    }
  });

  const exercises = spec.exercises || [];
  if (exercises.length) {
    children.push(new Paragraph({
      text: 'Bài tập luyện tập',
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 320, after: 120 },
      border: { bottom: { color: PRIMARY, space: 4, style: BorderStyle.SINGLE, size: 6 } }
    }));
    exercises.forEach((lvl) => {
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_3,
        spacing: { before: 140, after: 80 },
        children: [new TextRun({ text: lvl.level || '', color: PRIMARY })]
      }));
      (lvl.items || []).forEach((it, i) => {
        children.push(new Paragraph({
          spacing: { after: 60 },
          children: [new TextRun({ text: `${i + 1}. ${it.question || ''}` })]
        }));
      });
    });

    // Đáp số/gợi ý gom riêng thành phụ lục cuối tài liệu, để phần bài tập ở trên gọn gàng như một đề
    // ôn tập thật (không lộ đáp án ngay dưới mỗi câu).
    children.push(new Paragraph({
      text: 'Phụ lục: Đáp số / Gợi ý',
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 320, after: 120 },
      border: { bottom: { color: PRIMARY, space: 4, style: BorderStyle.SINGLE, size: 6 } }
    }));
    exercises.forEach((lvl) => {
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_3,
        spacing: { before: 120, after: 70 },
        children: [new TextRun({ text: lvl.level || '', color: PRIMARY })]
      }));
      (lvl.items || []).forEach((it, i) => {
        children.push(new Paragraph({
          spacing: { after: 50 },
          children: [
            new TextRun({ text: `${i + 1}. `, bold: true }),
            new TextRun({ text: it.answer || '(không có)', color: INK })
          ]
        }));
      });
    });
  }

  if (spec.sourceNote) {
    children.push(new Paragraph({
      spacing: { before: 360 },
      border: { top: { color: 'E2E4EA', space: 8, style: BorderStyle.SINGLE, size: 4 } },
      children: [new TextRun({ text: 'Nguồn: ' + spec.sourceNote, italics: true, color: MUTED, size: 18 })]
    }));
  }

  const doc = new Document({
    sections: [{ properties: {}, children }],
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } }
  });

  const blob = await Packer.toBlob(doc);
  const fname = (spec.title || 'de-cuong').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60) || 'de-cuong';
  return { blob, fileName: fname + '.docx' };
}

// Flashcard giờ hiện ra ở KHUNG NỔI #flashcardPanel (popup bên trái màn hình) — dùng CHUNG cơ chế
// mở/đóng/nút-mở-lại với khung "Đề xuất ôn tập" (#recommendPanel), thay vì nhúng thẻ ngay dưới câu
// trả lời (aiRow) như trước. Mỗi lần bấm "Flashcard ôn tập", panel tự mở và vẽ đè lên bộ thẻ cũ (nếu
// có) bằng bộ thẻ vừa tạo — aiRow chỉ còn dùng để giữ nguyên chữ ký hàm gọi từ paintStudyActions().
async function handleFlashcards(btn, aiRow, answerText) {
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span>Đang tạo thẻ…</span>';
  try {
    const data = await apiPost('/api/generate/flashcards', { content: answerText });
    openFlashcardPanel();
    el('flashcardTopic').textContent = answerText.length > 70 ? answerText.slice(0, 70) + '…' : answerText;
    renderFlashcards(el('flashcardBody'), data.cards || []);
  } catch (e) {
    console.error(e);
    alert((e && e.message) || 'Không tạo được flashcard, vui lòng thử lại.');
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

function renderFlashcards(wrap, cards) {
  if (!cards.length) { wrap.innerHTML = '<div class="rec-empty">Không tạo được thẻ ôn tập.</div>'; return; }
  let idx = 0, showingAnswer = false;
  wrap.innerHTML = `
    <div class="flash-wrap">
      <div class="flash-head"><span>${cards.length} thẻ</span>
        <div class="flash-nav"><button data-nav="prev">‹</button><button data-nav="next">›</button></div>
      </div>
      <div class="flash-card"><span class="qlabel">Hỏi</span><div class="txt"></div></div>
      <div class="flash-progress"></div>
    </div>
  `;
  const card = wrap.querySelector('.flash-card');
  const txt = wrap.querySelector('.txt');
  const qlabel = wrap.querySelector('.qlabel');
  const progress = wrap.querySelector('.flash-progress');
  function render() {
    const c = cards[idx];
    txt.textContent = showingAnswer ? c.a : c.q;
    qlabel.textContent = showingAnswer ? 'Đáp án' : 'Hỏi';
    card.classList.toggle('showing-a', showingAnswer);
    progress.textContent = `Thẻ ${idx + 1}/${cards.length} · bấm vào thẻ để lật`;
  }
  card.onclick = () => { showingAnswer = !showingAnswer; render(); };
  wrap.querySelector('[data-nav="prev"]').onclick = () => { idx = (idx - 1 + cards.length) % cards.length; showingAnswer = false; render(); };
  wrap.querySelector('[data-nav="next"]').onclick = () => { idx = (idx + 1) % cards.length; showingAnswer = false; render(); };
  render();
}

/* ================= Mindmap trực quan (sơ đồ tư duy) =================
 * Vẽ hoàn toàn bằng SVG thuần ở client (radial layout tự tính toán, không dùng thư viện ngoài) từ
 * spec JSON server trả về (xem server/utils/promptBuilder.js#buildMindmapSystemPrompt): chủ đề trung
 * tâm ở giữa, các nhánh chính toả tròn xung quanh theo màu riêng, nhánh con/cháu toả tiếp ra ngoài
 * theo đúng góc của nhánh cha (thuật toán "radial tidy tree" đơn giản: mỗi node được cấp 1 khoảng góc
 * tỉ lệ với số lá bên dưới nó). Có phóng to/thu nhỏ/kéo để xem + tải ảnh PNG, không cần thư viện
 * ngoài nào khác ngoài Canvas API sẵn có của trình duyệt.
 */
const MINDMAP_PALETTE = {
  blue: '#2955ff', green: '#16a34a', orange: '#ea580c', purple: '#9333ea', pink: '#db2777',
  teal: '#0d9488', red: '#dc2626', yellow: '#ca8a04', indigo: '#4f46e5', cyan: '#0891b2'
};
const MINDMAP_PALETTE_ORDER = Object.keys(MINDMAP_PALETTE);

async function handleMindmap(btn, aiRow, answerText) {
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span>Đang vẽ mindmap…</span>';
  try {
    const spec = await apiPost('/api/generate/mindmap', { content: answerText });
    let existing = aiRow.querySelector('.mindmap-wrap');
    if (existing) existing.remove();
    const wrap = document.createElement('div');
    wrap.className = 'mindmap-wrap';
    aiRow.appendChild(wrap);
    renderMindmap(wrap, spec);
    wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) {
    console.error(e);
    alert((e && e.message) || 'Không tạo được mindmap, vui lòng thử lại.');
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

// Đo bề rộng chữ thật (canvas 2D) để tự động xuống dòng nhãn node cho vừa khung, tránh chữ tràn ra
// ngoài hoặc node quá to so với nội dung ngắn.
let _mmMeasureCtx = null;
function mmTextWidth(text, fontPx, bold) {
  if (!_mmMeasureCtx) _mmMeasureCtx = document.createElement('canvas').getContext('2d');
  _mmMeasureCtx.font = `${bold ? '700' : '600'} ${fontPx}px 'Inter', 'Be Vietnam Pro', Arial, sans-serif`;
  return _mmMeasureCtx.measureText(text).width;
}
function mmWrapLabel(text, fontPx, bold, maxWidth, maxLines) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    if (mmTextWidth(test, fontPx, bold) > maxWidth && cur) {
      lines.push(cur);
      cur = w;
      if (lines.length === maxLines - 1) break;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  const used = lines.reduce((n, l) => n + l.split(' ').length, 0);
  if (used < words.length && lines.length) lines[lines.length - 1] += '…';
  return lines.slice(0, maxLines);
}

function mmCountLeaves(node) {
  if (!node.children || !node.children.length) return 1;
  return node.children.reduce((sum, c) => sum + mmCountLeaves(c), 0);
}

// Bố cục radial: gán (x,y,angle,depth) cho gốc + toàn bộ cây bằng cách chia đều góc 360° theo tỉ lệ
// số lá, rồi đẩy các node ra xa dần theo bán kính tăng theo cấp.
function mmLayout(spec) {
  const RADIUS = [0, 205, 375, 520];
  const root = { label: spec.title || 'Chủ đề', depth: 0, x: 0, y: 0, angle: 0, children: spec.branches || [] };
  function walk(node, angleStart, angleEnd, depth, parentColor, branchColor) {
    const angle = (angleStart + angleEnd) / 2;
    const r = RADIUS[Math.min(depth, RADIUS.length - 1)];
    node.depth = depth;
    node.angle = angle;
    node.x = depth === 0 ? 0 : Math.cos(angle) * r;
    node.y = depth === 0 ? 0 : Math.sin(angle) * r;
    node.color = depth === 1 ? (MINDMAP_PALETTE[node.color] || MINDMAP_PALETTE_ORDER0()) : (branchColor || null);
    const kids = node.children || [];
    if (kids.length) {
      const leafCounts = kids.map(mmCountLeaves);
      const total = leafCounts.reduce((a, b) => a + b, 0) || 1;
      let a = angleStart;
      const span = angleEnd - angleStart;
      kids.forEach((child, i) => {
        const childSpan = span * (leafCounts[i] / total);
        walk(child, a, a + childSpan, depth + 1, node.color, depth === 1 ? node.color : branchColor);
        a += childSpan;
      });
    }
  }
  function MINDMAP_PALETTE_ORDER0() { return MINDMAP_PALETTE[MINDMAP_PALETTE_ORDER[0]]; }
  walk(root, -Math.PI / 2, Math.PI * 1.5, 0, null, null);
  return root;
}

function mmFlatten(node, out) {
  out.push(node);
  (node.children || []).forEach((c) => mmFlatten(c, out));
  return out;
}

function renderMindmap(container, spec) {
  const branches = (spec && spec.branches) || [];
  if (!branches.length) {
    container.innerHTML = '<div class="set-empty">Không tạo được mindmap từ nội dung này.</div>';
    return;
  }
  const root = mmLayout(spec);
  const allNodes = mmFlatten(root, []);

  // Kích thước từng node theo cấp (gốc to nhất, nhỏ dần ra ngoài) + tự xuống dòng nhãn.
  const SIZE_BY_DEPTH = [
    { font: 16.5, padX: 22, padY: 15, maxW: 200, maxLines: 3, bold: true },
    { font: 13.5, padX: 16, padY: 11, maxW: 150, maxLines: 3, bold: true },
    { font: 12, padX: 13, padY: 9, maxW: 128, maxLines: 3, bold: false },
    { font: 11, padX: 11, padY: 8, maxW: 110, maxLines: 3, bold: false }
  ];
  allNodes.forEach((n) => {
    const cfg = SIZE_BY_DEPTH[Math.min(n.depth, SIZE_BY_DEPTH.length - 1)];
    n.lines = mmWrapLabel(n.label, cfg.font, cfg.bold, cfg.maxW, cfg.maxLines);
    const textW = Math.max(...n.lines.map((l) => mmTextWidth(l, cfg.font, cfg.bold)), 20);
    n.w = textW + cfg.padX * 2;
    n.h = n.lines.length * (cfg.font * 1.28) + cfg.padY * 2;
    n.cfg = cfg;
  });

  // viewBox bao trọn mọi node (tính theo tâm node + nửa kích thước + biên an toàn).
  let minX = 0, maxX = 0, minY = 0, maxY = 0;
  allNodes.forEach((n) => {
    minX = Math.min(minX, n.x - n.w / 2); maxX = Math.max(maxX, n.x + n.w / 2);
    minY = Math.min(minY, n.y - n.h / 2); maxY = Math.max(maxY, n.y + n.h / 2);
  });
  const PAD = 40;
  minX -= PAD; minY -= PAD; maxX += PAD; maxY += PAD;
  const vbW = maxX - minX, vbH = maxY - minY;

  const esc = escapeHtml;
  const isDark = document.body.classList.contains('dark') || document.documentElement.classList.contains('dark');

  // Đường nối cha->con: đường cong mềm (cubic bezier) toả theo hướng góc, tô màu theo nhánh, mảnh
  // dần và nhạt dần ra các cấp ngoài để mắt luôn dồn vào node hơn là đường nối.
  function edgePath(parent, child) {
    const dx = child.x - parent.x, dy = child.y - parent.y;
    const c1x = parent.x + dx * 0.42, c1y = parent.y + dy * 0.12;
    const c2x = parent.x + dx * 0.58, c2y = parent.y + dy * 0.88;
    return `M ${parent.x} ${parent.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${child.x} ${child.y}`;
  }
  const edgesSvg = [];
  function walkEdges(node) {
    (node.children || []).forEach((child) => {
      const color = child.depth === 1 ? child.color : (child.color || '#94a1bf');
      const width = child.depth === 1 ? 3.2 : child.depth === 2 ? 2.2 : 1.5;
      const opacity = child.depth === 1 ? 0.9 : child.depth === 2 ? 0.55 : 0.4;
      edgesSvg.push(`<path d="${edgePath(node, child)}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" opacity="${opacity}"/>`);
      walkEdges(child);
    });
  }
  walkEdges(root);

  const nodesSvg = allNodes.map((n) => {
    const cfg = n.cfg;
    const rx = n.depth === 0 ? n.h / 2 : 12;
    let fill, stroke, textColor;
    if (n.depth === 0) {
      fill = isDark ? '#141f38' : '#0e1524';
      stroke = 'none';
      textColor = '#ffffff';
    } else if (n.depth === 1) {
      fill = n.color;
      stroke = 'none';
      textColor = '#ffffff';
    } else {
      fill = isDark ? 'rgba(255,255,255,.06)' : '#ffffff';
      stroke = n.color;
      textColor = isDark ? '#e7ecf7' : '#0e1524';
    }
    const lineH = cfg.font * 1.28;
    const startY = -((n.lines.length - 1) * lineH) / 2;
    const tspans = n.lines.map((l, i) => `<tspan x="${n.x}" y="${n.y + startY + i * lineH}">${esc(l)}</tspan>`).join('');
    return `<g class="mm-node" data-depth="${n.depth}">
      <rect x="${n.x - n.w / 2}" y="${n.y - n.h / 2}" width="${n.w}" height="${n.h}" rx="${rx}"
        fill="${fill}" stroke="${stroke}" stroke-width="${stroke === 'none' ? 0 : 1.6}"/>
      <text text-anchor="middle" dominant-baseline="middle" fill="${textColor}"
        style="font-size:${cfg.font}px;font-weight:${cfg.bold ? 700 : 600};font-family:'Inter','Be Vietnam Pro',Arial,sans-serif;">${tspans}</text>
    </g>`;
  }).join('');

  container.innerHTML = `
    <div class="mm-head">
      <span>${ICONS.mindmap}<b>Mindmap trực quan</b></span>
      <div class="mm-toolbar">
        <button data-mm="out" title="Thu nhỏ">${ICONS.zoomOut}</button>
        <button data-mm="reset" title="Về vị trí gốc">${ICONS.refresh}</button>
        <button data-mm="in" title="Phóng to">${ICONS.zoomIn}</button>
        <button data-mm="full" title="Toàn màn hình">${ICONS.expand}</button>
        <button data-mm="dl" title="Tải ảnh PNG">${ICONS.download}</button>
      </div>
    </div>
    <div class="mm-stage">
      <div class="mm-pan">
        <svg class="mm-svg" viewBox="${minX} ${minY} ${vbW} ${vbH}" xmlns="http://www.w3.org/2000/svg">
          <g class="mm-edges">${edgesSvg.join('')}</g>
          <g class="mm-nodes">${nodesSvg}</g>
        </svg>
      </div>
    </div>
    <div class="mm-hint">Kéo để di chuyển · lăn chuột/chụm 2 ngón để phóng to · bấm tải ảnh để lưu về máy</div>
  `;

  mmWireInteractions(container, spec);
}

// Kéo-thả (pan) + phóng to/thu nhỏ (zoom) bằng CSS transform thuần trên <div class="mm-pan">, không
// phụ thuộc thư viện ngoài. Toàn màn hình dùng Fullscreen API sẵn có của trình duyệt (fallback: class
// CSS phủ kín màn hình nếu trình duyệt không hỗ trợ). Tải PNG: serialize SVG hiện tại -> vẽ vào
// <canvas> ở độ phân giải x2 (nét hơn) -> xuất file .png tải thẳng về máy, không cần server.
function mmWireInteractions(container, spec) {
  const stage = container.querySelector('.mm-stage');
  const pan = container.querySelector('.mm-pan');
  const svgEl = container.querySelector('.mm-svg');
  let scale = 1, tx = 0, ty = 0;
  function apply() { pan.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`; }
  function setScale(next, cx, cy) {
    next = Math.min(3, Math.max(0.35, next));
    const rect = stage.getBoundingClientRect();
    const px = (cx != null ? cx - rect.left : rect.width / 2);
    const py = (cy != null ? cy - rect.top : rect.height / 2);
    tx -= (px - tx) * (next / scale - 1);
    ty -= (py - ty) * (next / scale - 1);
    scale = next;
    apply();
  }
  container.querySelector('[data-mm="in"]').onclick = () => setScale(scale * 1.25);
  container.querySelector('[data-mm="out"]').onclick = () => setScale(scale / 1.25);
  container.querySelector('[data-mm="reset"]').onclick = () => { scale = 1; tx = 0; ty = 0; apply(); };
  // Toàn màn hình kiểu CSS thuần (position:fixed phủ kín viewport) thay vì Fullscreen API của trình
  // duyệt — nhất quán hơn trên mobile/Safari (nơi Fullscreen API hay bị hạn chế hoặc ẩn thanh công
  // cụ), và vẫn giữ được toolbar/nút bấm hiển thị bình thường khi phóng to.
  container.querySelector('[data-mm="full"]').onclick = () => {
    container.classList.toggle('mm-fullscreen');
    document.body.classList.toggle('mm-lock-scroll', container.classList.contains('mm-fullscreen'));
  };
  document.addEventListener('keydown', function escClose(e) {
    if (e.key === 'Escape' && container.classList.contains('mm-fullscreen')) {
      container.classList.remove('mm-fullscreen');
      document.body.classList.remove('mm-lock-scroll');
    }
  });

  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    setScale(scale * (e.deltaY < 0 ? 1.12 : 0.89), e.clientX, e.clientY);
  }, { passive: false });

  // Kéo (1 ngón/chuột) + CHỤM 2 NGÓN để phóng to/thu nhỏ (pinch-to-zoom) — dùng chung Pointer Events
  // API cho cả chuột lẫn đa điểm chạm trên điện thoại. Trước đây chỉ có 'wheel' (chuột) và kéo 1
  // ngón được nối, nên trên điện thoại chụm 2 ngón không có tác dụng gì dù trong phần hint có nhắc
  // tới — đây chính là lỗi "không phóng to thu nhỏ được trên điện thoại".
  const activePointers = new Map();
  let lastX = 0, lastY = 0;
  let pinchStartDist = 0, pinchStartScale = 1, pinchMidX = 0, pinchMidY = 0;
  const dist2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const mid2 = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId);
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePointers.size === 1) {
      lastX = e.clientX; lastY = e.clientY;
      stage.classList.add('dragging');
    } else if (activePointers.size === 2) {
      stage.classList.remove('dragging');
      const [a, b] = [...activePointers.values()];
      pinchStartDist = dist2(a, b) || 1;
      pinchStartScale = scale;
      const m = mid2(a, b);
      pinchMidX = m.x; pinchMidY = m.y;
    }
  });
  stage.addEventListener('pointermove', (e) => {
    if (!activePointers.has(e.pointerId)) return;
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePointers.size >= 2) {
      const [a, b] = [...activePointers.values()];
      const m = mid2(a, b);
      // Trung điểm 2 ngón di chuyển -> kéo (pan) theo, giữ đúng cảm giác "chụm ở đâu, dính ở đó".
      tx += m.x - pinchMidX; ty += m.y - pinchMidY;
      pinchMidX = m.x; pinchMidY = m.y;
      const d = dist2(a, b) || 1;
      setScale(pinchStartScale * (d / pinchStartDist), m.x, m.y);
    } else if (activePointers.size === 1) {
      tx += e.clientX - lastX; ty += e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      apply();
    }
  });
  function endPointer(e) {
    activePointers.delete(e.pointerId);
    if (activePointers.size === 1) {
      const [p] = [...activePointers.values()];
      lastX = p.x; lastY = p.y;
      stage.classList.add('dragging');
    } else {
      stage.classList.remove('dragging');
    }
  }
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => stage.addEventListener(ev, endPointer));

  container.querySelector('[data-mm="dl"]').onclick = () => mmDownloadPNG(svgEl, spec.title || 'mindmap');
}

async function mmDownloadPNG(svgEl, title) {
  const clone = svgEl.cloneNode(true);
  const vb = svgEl.viewBox.baseVal;
  const bg = document.body.classList.contains('dark') ? '#0b1220' : '#ffffff';
  clone.setAttribute('style', `background:${bg}`);
  const xml = new XMLSerializer().serializeToString(clone);
  const svg64 = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
  const img = new Image();
  await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = svg64; });
  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = vb.width * scale;
  canvas.height = vb.height * scale;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  canvas.toBlob((blob) => {
    if (!blob) return;
    const fname = (title || 'mindmap').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60) || 'mindmap';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fname + '.png';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }, 'image/png');
}

/* ================= Mindmap trực tiếp từ chat: 1 lượt duy nhất =================
 * Kích hoạt khi isMindmapRequest(query) nhận diện người dùng đang chủ động xin vẽ mindmap/sơ đồ tóm
 * tắt (không phải giải 1 bài toán cụ thể) — cùng triết lý với handleOutlineOnlyTurn(): 1 lượt gọi AI
 * duy nhất tới POST /api/generate/mindmap, hiển thị NGAY sơ đồ trực quan trong khung chat, không có
 * bước "Xem cách giải chi tiết" nào ở giữa. Ngoài ra, nút "Mindmap trực quan" ở buildStudyActions vẫn
 * luôn có sẵn sau MỌI lời giải chi tiết để người dùng tự bấm vẽ khi cần, không bắt buộc phải gõ đúng
 * mẫu câu này.
 */
function isMindmapRequest(text) {
  const t = (text || '').toLowerCase().trim();
  if (!t || t.length > 200) return false;
  const hasProblemSignal = /[=]|\\frac|\btính\b|\bgiải\b(?!\s*(thích|nghĩa))|\bchứng minh\b|\brút gọn\b|\btìm x\b|\btìm y\b|\bcho tam giác\b|\bcho hình\b|\bcho hàm số\b|\bcho phương trình\b|\bcho biết\b/.test(t);
  if (hasProblemSignal) return false;
  return /(mindmap|mind map|sơ đồ tư duy|sơ đồ tóm tắt|vẽ sơ đồ|tóm tắt.*(bằng|dạng|thành).*sơ đồ|hệ thống hóa.*sơ đồ)/.test(t);
}

async function handleMindmapOnlyTurn(query, conv) {
  const contexts = retrieveContext(query, 4);
  const aiMsgObj = { id: uid(), role: 'ai', query, approach: '', detail: null, contexts: [], crossChecked: false, mindmapSpec: null };
  const aiRow = addAiMsg('Mindmap');
  aiRow.dataset.msgId = aiMsgObj.id;
  const contentEl = aiRow.querySelector('.content');
  conv.messages.push(aiMsgObj);
  touchConversation(conv);

  try {
    const sourceContent = contexts.length
      ? query + '\n\nNguồn tài liệu liên quan đã nạp:\n' + contexts.map((c, i) => `[${i + 1}] (${c.doc}) ${c.text}`).join('\n')
      : query;
    const spec = await apiPost('/api/generate/mindmap', { content: sourceContent });

    aiMsgObj.mindmapSpec = spec;
    aiMsgObj.approach = mindmapSpecToPlainText(spec);

    contentEl.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'mindmap-wrap';
    contentEl.appendChild(wrap);
    renderMindmap(wrap, spec);
    contentEl.appendChild(buildNoteBlock(aiMsgObj));
    touchConversation(conv);

    state.history.push({ role: 'user', content: query });
    state.history.push({ role: 'assistant', content: aiMsgObj.approach });
    if (state.history.length > 20) state.history = state.history.slice(-20);
  } catch (e) {
    const msg = (e && e.message) || 'Không tạo được mindmap, vui lòng thử lại.';
    const escaped = escapeHtml(msg).replace(/\n/g, '<br>');
    contentEl.innerHTML = `<p style="color:#c0392b;white-space:pre-wrap;">⚠️ ${escaped}</p>`;
    console.error(e);
  } finally {
    el('sendBtn').disabled = false;
    statusEl.textContent = 'SẴN SÀNG';
    threadEl.scrollTop = threadEl.scrollHeight;
  }
}

function mindmapSpecToPlainText(spec) {
  if (!spec) return '';
  const lines = [spec.title || ''];
  function walk(node, depth) {
    (node.children || []).forEach((c) => {
      lines.push('  '.repeat(depth) + '- ' + c.label);
      walk(c, depth + 1);
    });
  }
  walk({ children: spec.branches || [] }, 0);
  return lines.join('\n');
}

function welcome() {
  const row = document.createElement('div');
  row.className = 'msg-row msg-ai';
  row.innerHTML = '<div class="label">Trợ Giải</div><div class="content"><p>Chào bạn 👋 Thêm nguồn tài liệu ở tab <strong>Nguồn</strong> nếu muốn AI trích dẫn chính xác, chọn chế độ suy nghĩ ngay trong thanh chat, và mở ⚙️ Cài đặt để chọn khối lớp (dùng cho tab <strong>Công thức</strong>) hoặc thêm quy tắc riêng. AI sẽ đưa <strong>Hướng giải</strong> trước — bấm "Xem cách giải chi tiết" khi bạn đã thử mà chưa ra hoặc muốn xem lời giải đầy đủ. Sau mỗi lời giải, bạn có thể <strong>Lưu ghi chú</strong>, <strong>Xuất slide PPT</strong>, tạo <strong>Flashcard ôn tập</strong> hoặc vẽ <strong>Mindmap trực quan</strong> nhiều màu (gõ thẳng "vẽ sơ đồ tư duy..." cũng được). Dán đề bài hoặc đính kèm ảnh để bắt đầu.</p></div>';
  threadEl.appendChild(row);
}

/* ================= Đề xuất ôn tập (khung bên phải) =================
   Mỗi khi gửi câu hỏi, gọi POST /api/recommend để lấy danh sách link gợi ý các trang tài liệu/bài
   tập uy tín rồi hiển thị ở khung nổi bên phải màn hình. REWORK (lần 2): server (xem comment đầu
   file server/routes/recommend.js) giờ dùng AI + tìm kiếm web THẬT xoay tua qua mọi provider đã
   cấu hình hỗ trợ web search (không cố định phải là Claude), có fallback về link Google tĩnh khi
   AI thất bại. Vì lượt gọi AI này có thể mất vài giây, khung KHÔNG còn tự động mở (popup) mỗi lần
   gửi câu hỏi nữa — request chạy NGẦM, kết quả lặng lẽ nạp vào khung kèm 1 dấu chấm báo (badge)
   nhỏ trên nút mở; người dùng chủ động bấm nút để xem. Nếu câu hỏi CHỈ xin đề (không kèm bài toán
   cụ thể), sendMessage() ở trên vẫn bỏ qua bước gọi AI giải bài như trước. */
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Heuristic: câu hỏi CHỈ xin đề/bài tập ôn tập (không kèm 1 bài toán cụ thể cần giải) — ưu tiên
// AN TOÀN theo hướng "nếu còn nghi ngờ có bài toán thật thì vẫn giải bình thường" (false negative
// ở đây vô hại — vẫn giải + vẫn có khung đề xuất; false positive mới đáng ngại vì sẽ bỏ qua không
// giải 1 bài người dùng thực sự cần).
// LƯU Ý: KHÔNG nhận diện "đề cương" ở đây — "đề cương" là xin TÓM TẮT/HỆ THỐNG kiến thức (đã có cơ
// chế riêng ở isOutlineRequest() bên dưới, xem handleOutlineOnlyTurn()), khác hẳn "đề thi/đề ôn tập"
// (xin 1 bộ đề/bài tập để tự làm) — gộp chung 2 khái niệm này khiến yêu cầu xin đề cương trước đây
// chỉ nhận được link ở khung "Đề xuất ôn tập" mà không hề có đề cương nào được soạn ra cả.
function isExamOnlyRequest(text) {
  const t = (text || '').toLowerCase().trim();
  if (!t || t.length > 150) return false; // câu dài thường là đã dán nguyên đề bài -> luôn giải
  const hasProblemSignal = /[=]|\\frac|\btính\b|\bgiải\b|\bchứng minh\b|\brút gọn\b|\btìm x\b|\btìm y\b|\bcho tam giác\b|\bcho hình\b|\bcho hàm số\b|\bcho phương trình\b|\bcho biết\b/.test(t);
  if (hasProblemSignal) return false;
  const examSignal = /(đề\s*(thi|kiểm tra|ôn tập|ôn thi)|bài tập ôn tập|tài liệu ôn tập|nguồn (đề|bài tập)|bài tập tương tự)/;
  const askSignal = /\b(cho|tìm|gợi ý|xin|có|kiếm|đưa)\b/;
  return examSignal.test(t) && askSignal.test(t);
}

// Heuristic: câu hỏi xin SOẠN ĐỀ CƯƠNG / tóm tắt-hệ thống hóa lý thuyết (không phải 1 bài toán cụ
// thể cần giải từng bước). Cùng triết lý AN TOÀN với isExamOnlyRequest(): còn nghi ngờ có bài toán
// thật (có dấu "=", có "tính/giải/chứng minh/tìm x"...) thì KHÔNG nhận diện, cứ để luồng giải bài
// bình thường xử lý — false negative ở đây vô hại (vẫn giải bình thường, người dùng luôn có thể bấm
// nút "Đề cương .docx" thủ công sau khi có lời giải chi tiết); false positive mới đáng ngại.
function isOutlineRequest(text) {
  const t = (text || '').toLowerCase().trim();
  if (!t || t.length > 200) return false;
  const hasProblemSignal = /[=]|\\frac|\btính\b|\bgiải\b(?!\s*(thích|nghĩa))|\bchứng minh\b|\brút gọn\b|\btìm x\b|\btìm y\b|\bcho tam giác\b|\bcho hình\b|\bcho hàm số\b|\bcho phương trình\b|\bcho biết\b/.test(t);
  if (hasProblemSignal) return false;
  const outlineSignal = /(đề cương|soạn.*(tóm tắt|đề cương)|(tóm tắt|tổng hợp|hệ thống hóa|khái quát)\s*(lại\s*)?(lý thuyết|kiến thức|công thức|nội dung|chương|bài))/;
  return outlineSignal.test(t);
}

// Heuristic: câu hỏi xin LÀM/TẠO SLIDE POWERPOINT trực tiếp (không phải giải 1 bài toán cụ thể) —
// cùng triết lý AN TOÀN với isOutlineRequest() ở trên: còn nghi ngờ có bài toán thật thì KHÔNG nhận
// diện, cứ để luồng giải bài bình thường xử lý (người dùng luôn có thể bấm nút "Xuất slide PPT" thủ
// công sau khi có lời giải). Dùng chung "hasProblemSignal" để tránh 1 câu vừa có bài toán vừa nhắc
// "trình bày"/"slide" (vd "trình bày cách giải phương trình x+2=0") bị hiểu nhầm thành yêu cầu làm PPT.
function isPPTRequest(text) {
  const t = (text || '').toLowerCase().trim();
  if (!t || t.length > 200) return false;
  const hasProblemSignal = /[=]|\\frac|\btính\b|\bgiải\b(?!\s*(thích|nghĩa))|\bchứng minh\b|\brút gọn\b|\btìm x\b|\btìm y\b|\bcho tam giác\b|\bcho hình\b|\bcho hàm số\b|\bcho phương trình\b|\bcho biết\b/.test(t);
  if (hasProblemSignal) return false;
  const pptSignal = /(làm|tạo|soạn|xuất|thiết kế).*(ppt\b|powerpoint|slide|bài (giảng|thuyết trình)|bản thuyết trình)|slide\s*(bài giảng|thuyết trình)/;
  return pptSignal.test(t);
}

let recommendAbortController = null;
// Đưa 2 nút mở "Đề xuất ôn tập" / "Flashcard ôn tập" lên thanh trên cùng (topbar), cạnh nút đổi
// giao diện sáng/tối + Cài đặt AI — thay cho 2 nút tròn nổi (pill) trước đây chỉ hiện SAU KHI đóng
// panel. Giờ luôn có mặt sẵn trong topbar và hoạt động theo kiểu "bật/tắt" (bấm lần nữa để đóng),
// không cần đợi trạng thái đóng/mở như cơ chế reopen-btn cũ.
// mở panel = coi như người dùng đã "xem" kết quả mới nhất -> xoá luôn dấu chấm báo (badge) nếu có.
function openRecommendPanel() {
  el('recommendPanel').classList.add('open');
  el('recommendTopBtn').classList.remove('has-badge');
}
function closeRecommendPanel() { el('recommendPanel').classList.remove('open'); }
function toggleRecommendPanel() {
  if (el('recommendPanel').classList.contains('open')) closeRecommendPanel(); else openRecommendPanel();
}
el('recommendCloseBtn').onclick = closeRecommendPanel;
el('recommendTopBtn').onclick = toggleRecommendPanel;

// Khung "Flashcard ôn tập" — cùng cơ chế bật/tắt với #recommendPanel ở trên (xem handleFlashcards()
// phía trên).
function openFlashcardPanel() { el('flashcardPanel').classList.add('open'); }
function closeFlashcardPanel() { el('flashcardPanel').classList.remove('open'); }
function toggleFlashcardPanel() {
  if (el('flashcardPanel').classList.contains('open')) closeFlashcardPanel(); else openFlashcardPanel();
}
el('flashcardCloseBtn').onclick = closeFlashcardPanel;
el('flashcardTopBtn').onclick = toggleFlashcardPanel;

// REWORK (lần 2): route giờ gọi AI + tìm kiếm web thật (xem comment đầu server/routes/recommend.js)
// nên có thể mất vài giây — nhưng vì request chạy NGẦM (không tự mở panel), trạng thái "đang tìm"
// bên dưới chỉ hiển thị cho người dùng nào chủ động mở panel SỚM, trước khi kết quả kịp về.
function renderRecommendLoading() {
  el('recommendBody').innerHTML = '<div class="rec-empty">🔎 Đang tìm tài liệu liên quan…</div>';
}
function renderRecommendError(msg) {
  el('recommendBody').innerHTML = `<div class="rec-empty">⚠️ ${escapeHtml(msg)}</div>`;
}
function renderRecommendResults(topic, links) {
  el('recommendTopic').textContent = topic || '';
  if (!links || !links.length) {
    el('recommendBody').innerHTML = '<div class="rec-empty">Chưa có gợi ý trang tài liệu cho câu hỏi này.</div>';
    return;
  }
  const note = '<div class="rec-fallback-note">🔎 Bấm 1 trang bên dưới để mở link liên quan.</div>';
  el('recommendBody').innerHTML = note + links.map((l) => `
    <a class="rec-card" href="${escapeHtml(l.url)}" target="_blank" rel="noopener noreferrer">
      <div class="rec-card-domain">${escapeHtml(l.domain || '')}</div>
      <div class="rec-card-title">${escapeHtml(l.title || l.url)}</div>
      ${l.note ? `<div class="rec-card-note">${escapeHtml(l.note)}</div>` : ''}
    </a>`).join('');
}
// Báo "có gợi ý mới" cho người dùng — CHỈ hiện dấu chấm nếu panel đang ĐÓNG (nếu panel đang mở sẵn,
// người dùng đã thấy nội dung vừa cập nhật ngay trong khung, không cần thêm dấu hiệu nào khác).
function markRecommendUpdated() {
  if (!el('recommendPanel').classList.contains('open')) el('recommendTopBtn').classList.add('has-badge');
}
// scheduleRecommend() giờ chạy NGẦM: KHÔNG gọi openRecommendPanel() nữa (xem comment đầu mục này) —
// chỉ cập nhật nội dung khung (dù đang ẩn hay hiện) rồi báo badge nếu panel đang đóng.
async function scheduleRecommend(query) {
  el('recommendTopic').textContent = query.length > 70 ? query.slice(0, 70) + '…' : query;
  renderRecommendLoading();
  if (recommendAbortController) recommendAbortController.abort();
  const controller = new AbortController();
  recommendAbortController = controller;
  try {
    const res = await fetch('/api/recommend', {
      method: 'POST', headers: apiHeaders(), body: JSON.stringify({ query }), signal: controller.signal
    });
    let data; try { data = await res.json(); } catch (e) { data = null; }
    if (controller.signal.aborted) return;
    if (!res.ok) { renderRecommendError((data && data.error) || 'Không tìm được tài liệu liên quan.'); markRecommendUpdated(); return; }
    renderRecommendResults(data.topic, data.links);
    markRecommendUpdated();
  } catch (e) {
    if (controller.signal.aborted || e.name === 'AbortError') return;
    renderRecommendError('Không thể kết nối máy chủ để tìm tài liệu liên quan.');
    markRecommendUpdated();
  }
}

loadAll();
