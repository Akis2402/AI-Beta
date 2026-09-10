'use strict';

/* =====================================================================================
   i18n.js — PHẦN W: tầng dịch UI DUY NHẤT. Mọi text hiển thị PHẢI qua t(key) thay vì
   hard-code trong HTML/JS. Đọc ngôn ngữ hiện tại từ window.languageStore (nguồn trung tâm
   duy nhất — PHẦN T), tra cứu window.TRANSLATIONS (translations.js).

   Cách dùng:
     t('chat.generating')                 -> "Đang trả lời..." / "Generating..."
     t('chat.background', { n: 3 })       -> thay {{n}} bằng 3
     applyStaticTranslations(root)        -> quét mọi phần tử [data-i18n]/[data-i18n-placeholder]/
                                              [data-i18n-title]/[data-i18n-aria-label] trong `root`
                                              (mặc định document) và điền text đúng ngôn ngữ hiện tại.

   Khi ngôn ngữ đổi (languageStore.subscribe), tự động re-áp toàn bộ data-i18n trong DOM — KHÔNG
   cần reload trang (PHẦN AH).
   ===================================================================================== */

function t(key, vars) {
  const lang = (window.languageStore && window.languageStore.getUILanguage()) || 'vi';
  const dict = (window.TRANSLATIONS && window.TRANSLATIONS[lang]) || {};
  let str = dict[key];
  if (str == null) {
    // Fallback: tiếng Việt rồi tới chính key (không bao giờ hiển thị "undefined" cho người dùng).
    str = (window.TRANSLATIONS && window.TRANSLATIONS.vi && window.TRANSLATIONS.vi[key]) || key;
  }
  if (vars) {
    Object.keys(vars).forEach((k) => { str = str.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(vars[k])); });
  }
  return str;
}

function applyStaticTranslations(root) {
  const scope = root || document;
  scope.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.getAttribute('data-i18n')); });
  // data-i18n-html: DÙNG RẤT HẠN CHẾ, chỉ cho chuỗi có markup cố định do CHÍNH translations.js
  // định nghĩa (vd <strong> trong hướng dẫn) — KHÔNG bao giờ dùng cho nội dung người dùng/AI nhập
  // vào (đó là lỗ XSS); mọi chuỗi động vẫn phải qua data-i18n/textContent.
  scope.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.getAttribute('data-i18n-html')); });
  scope.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.getAttribute('data-i18n-placeholder')); });
  scope.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.getAttribute('data-i18n-title')); });
  scope.querySelectorAll('[data-i18n-aria-label]').forEach((el) => { el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria-label'))); });
}

/* ---------------------------------------------------------------------------------------
   PHẦN AF/AG — ánh xạ ERROR CODE (ổn định, do backend trả về trong `code`) sang khoá dịch.
   Backend KHÔNG hard-code câu chữ hiển thị: server/utils/errorNormalize.js đã trả về
   { code, retryable } ổn định (INVALID_INPUT/TIMEOUT/RATE_LIMIT/...), frontend mới quyết định
   hiển thị câu gì, bằng ngôn ngữ nào. Nhờ vậy đổi Settings > Language là thông báo lỗi cũng đổi
   theo, không cần sửa backend và không cần duplicate message ở 2 tầng.
   Code lạ/không có trong map -> 'error.generic' (không bao giờ hiện "undefined").
   --------------------------------------------------------------------------------------- */
const ERROR_CODE_I18N_KEY = {
  INVALID_INPUT: 'error.invalidRequest',
  AUTH_CONFIG: 'error.auth',
  MODEL_NOT_FOUND: 'error.unavailable',
  TIMEOUT: 'error.timeout',
  RATE_LIMIT: 'error.rateLimit',
  CANCELLED: 'chat.stopped',
  SERVER_ERROR: 'error.serverConfig',
  PROVIDER_ERROR: 'error.unavailable',
  PROVIDER_UNAVAILABLE: 'error.overloaded',
  CONTENT_FILTER: 'error.contentFilter',
  NETWORK: 'error.network',
  UNKNOWN_ERROR: 'error.generic'
};

/** Trả về message ĐÃ DỊCH cho 1 error code backend. `fallbackText` (message thô của server) chỉ
 * dùng khi code không nhận diện được — vẫn hơn là không hiện gì, nhưng ưu tiên bản đã dịch. */
function tError(code, fallbackText) {
  const key = ERROR_CODE_I18N_KEY[code];
  if (key) return t(key);
  return fallbackText || t('error.generic');
}

window.t = t;
window.tError = tError;
window.ERROR_CODE_I18N_KEY = ERROR_CODE_I18N_KEY;
window.applyStaticTranslations = applyStaticTranslations;

document.addEventListener('DOMContentLoaded', () => applyStaticTranslations(document));
if (window.languageStore) {
  window.languageStore.subscribe(() => applyStaticTranslations(document));
}
