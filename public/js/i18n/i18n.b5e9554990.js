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

function i18nHasOwn(dict, key) {
  return !!dict && Object.prototype.hasOwnProperty.call(dict, key);
}

function i18nCurrentLang() {
  return (window.languageStore && window.languageStore.getUILanguage()) || 'vi';
}

/** true nếu `key` có bản dịch (ngôn ngữ hiện tại HOẶC fallback tiếng Việt). Chuỗi rỗng "" là bản dịch
 * HỢP LỆ (cố ý) — khác với "thiếu bản dịch", nên phải kiểm tra sự tồn tại của key chứ không phải độ "truthy". */
function i18nHasTranslation(key) {
  const all = window.TRANSLATIONS || {};
  return i18nHasOwn(all[i18nCurrentLang()], key) || i18nHasOwn(all.vi, key);
}

function translateKey(key, vars) {
  const lang = i18nCurrentLang();
  const dict = (window.TRANSLATIONS && window.TRANSLATIONS[lang]) || {};
  let str = dict[key];
  if (str == null) {
    // Fallback: tiếng Việt rồi tới chính key (không bao giờ hiển thị "undefined" cho người dùng).
    const vi = window.TRANSLATIONS && window.TRANSLATIONS.vi;
    str = i18nHasOwn(vi, key) && vi[key] != null ? vi[key] : key;
  }
  if (vars) {
    Object.keys(vars).forEach((k) => { str = str.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(vars[k])); });
  }
  return str;
}

/** Áp bản dịch cho mọi phần tử mang thuộc tính `attr`. THIẾU bản dịch (key không có ở ngôn ngữ hiện
 * tại lẫn tiếng Việt) thì GIỮ NGUYÊN giá trị sẵn có trong HTML (chính là fallback tiếng Việt viết tay)
 * thay vì ghi đè bằng chính chuỗi key thô (vd "sources.searchPlaceholder") ra giao diện. */
function i18nApplyToAttr(scope, attr, apply) {
  scope.querySelectorAll('[' + attr + ']').forEach((el) => {
    const key = el.getAttribute(attr);
    if (!i18nHasTranslation(key)) return;
    apply(el, translateKey(key));
  });
}

function applyStaticTranslations(root) {
  const scope = root || document;
  i18nApplyToAttr(scope, 'data-i18n', (el, s) => { el.textContent = s; });
  // data-i18n-html: DÙNG RẤT HẠN CHẾ, chỉ cho chuỗi có markup cố định do CHÍNH translations.js
  // định nghĩa (vd <strong> trong hướng dẫn) — KHÔNG bao giờ dùng cho nội dung người dùng/AI nhập
  // vào (đó là lỗ XSS); mọi chuỗi động vẫn phải qua data-i18n/textContent.
  i18nApplyToAttr(scope, 'data-i18n-html', (el, s) => { el.innerHTML = s; });
  i18nApplyToAttr(scope, 'data-i18n-placeholder', (el, s) => { el.placeholder = s; });
  i18nApplyToAttr(scope, 'data-i18n-title', (el, s) => { el.title = s; });
  i18nApplyToAttr(scope, 'data-i18n-aria-label', (el, s) => { el.setAttribute('aria-label', s); });
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
  // FIX: map lỗi 413 (body-parser, xem errorNormalize.js) sang khoá dịch RÕ NGUYÊN NHÂN, thay vì
  // rơi về 'error.generic' chung chung không giúp người dùng tự khắc phục được gì.
  PAYLOAD_TOO_LARGE: 'error.payloadTooLarge',
  UNKNOWN_ERROR: 'error.generic'
};

/** Trả về message ĐÃ DỊCH cho 1 error code backend. `fallbackText` (message thô của server) chỉ
 * dùng khi code không nhận diện được — vẫn hơn là không hiện gì, nhưng ưu tiên bản đã dịch. */
function tError(code, fallbackText) {
  const key = ERROR_CODE_I18N_KEY[code];
  if (key) return translateKey(key);
  return fallbackText || translateKey('error.generic');
}

window.t = translateKey;
window.tError = tError;
window.ERROR_CODE_I18N_KEY = ERROR_CODE_I18N_KEY;
window.applyStaticTranslations = applyStaticTranslations;

document.addEventListener('DOMContentLoaded', () => applyStaticTranslations(document));
if (window.languageStore) {
  window.languageStore.subscribe(() => applyStaticTranslations(document));
}
