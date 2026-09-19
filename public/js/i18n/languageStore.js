'use strict';

/* =====================================================================================
   languageStore.js — PHẦN T/U/V: nguồn ngôn ngữ TRUNG TÂM duy nhất cho toàn bộ web.

   - uiLanguage: điều khiển MỌI text giao diện (qua i18n.js/t()).
   - Khi user đổi Settings > Language, languageStore là nơi DUY NHẤT ghi nhận thay đổi đó —
     mọi nơi khác (app.js, scene3d.js, i18n.js) chỉ ĐỌC qua getUILanguage()/subscribe(),
     không tự giữ biến ngôn ngữ riêng (PHẦN T: "Không để từng component tự chọn ngôn ngữ riêng").
   - Persist bằng localStorage (PHẦN V) — key riêng, không đụng state.settings hiện có của
     app.js để tránh xung đột nguồn ghi (nhưng khởi tạo ban đầu ĐỌC từ state.settings.lang cũ
     nếu có, để không phá trải nghiệm người dùng cũ đã từng chọn English/Tiếng Việt).
   - Mã ngôn ngữ dùng chuẩn ngắn 'vi' | 'en' (PHẦN U), có thể mở rộng thêm mã khác sau này chỉ
     bằng cách thêm entry vào translations.js — không phải sửa file này.
   ===================================================================================== */

const LANG_STORE_KEY = 'trogiai.uiLanguage.v1';
const SUPPORTED_LANGS = ['vi', 'en'];
const DEFAULT_LANG = 'vi';

// Map qua lại với nhãn cũ đã dùng trong state.settings.lang (public/js/app.js) — PHẦN AB/AA:
// answerLanguage/explanationLanguage của request AI vẫn dùng đúng nhãn cũ ('Tiếng Việt'/'English')
// để KHÔNG phải sửa lại toàn bộ promptBuilder.js (giảm rủi ro regression trên hệ thống ngôn ngữ
// AI vốn đã hoạt động đúng) — languageStore chỉ thêm 1 tầng mã ngắn 'vi'/'en' dùng cho UI + cho
// AI language contract nén (PHẦN AA).
const LEGACY_LABEL_TO_CODE = { 'Tiếng Việt': 'vi', 'English': 'en', 'tự động theo câu hỏi': null };
const CODE_TO_LEGACY_LABEL = { vi: 'Tiếng Việt', en: 'English' };

function lsGetRaw(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}
function lsSetRaw(key, val) {
  try { localStorage.setItem(key, val); } catch (e) { /* ignore (quota/private mode) */ }
}

function detectInitialLanguage() {
  const stored = lsGetRaw(LANG_STORE_KEY);
  if (stored && SUPPORTED_LANGS.includes(stored)) return stored;
  // Tương thích ngược: nếu app.js đã từng lưu settings.lang trong localStorage, dùng nó làm khởi
  // tạo lần đầu (không tự dịch lịch sử, chỉ đọc để không phá trải nghiệm người dùng cũ — PHẦN V).
  try {
    const legacy = JSON.parse(localStorage.getItem('trogiai_settings_v1') || localStorage.getItem('mathAiSettings') || 'null');
    if (legacy && legacy.lang && LEGACY_LABEL_TO_CODE[legacy.lang]) return LEGACY_LABEL_TO_CODE[legacy.lang];
  } catch (e) { /* ignore */ }
  const browserLang = (navigator.language || '').toLowerCase();
  if (browserLang.startsWith('en')) return 'en';
  return DEFAULT_LANG;
}

let currentLang = detectInitialLanguage();
const subscribers = new Set();

const languageStore = {
  SUPPORTED_LANGS,
  getUILanguage() { return currentLang; },
  /** PHẦN AB: nhãn tương thích ngược để truyền vào request settings.lang hiện có (promptBuilder.js). */
  getLegacyLabel() { return CODE_TO_LEGACY_LABEL[currentLang] || 'Tiếng Việt'; },
  setUILanguage(code) {
    if (!SUPPORTED_LANGS.includes(code) || code === currentLang) return;
    currentLang = code;
    lsSetRaw(LANG_STORE_KEY, code);
    // PHẦN AI: đổi UI language KHÔNG dịch lại lịch sử chat cũ — chỉ phát sự kiện để UI hiện tại
    // (menu/nút/placeholder...) rerender; các message đã lưu giữ nguyên ngôn ngữ gốc của chúng.
    subscribers.forEach((cb) => { try { cb(currentLang); } catch (e) { console.error('[languageStore] subscriber lỗi:', e); } });
    document.dispatchEvent(new CustomEvent('uilanguagechange', { detail: { lang: currentLang } }));
  },
  /** PHẦN AH: component đăng ký để tự rerender khi ngôn ngữ đổi — không cần reload trang. */
  subscribe(cb) { subscribers.add(cb); return () => subscribers.delete(cb); }
};

window.languageStore = languageStore;
