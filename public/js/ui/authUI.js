/* ============================================================================================
 * authUI.js — Đăng nhập/đăng ký (Supabase qua server), hạn mức token + cooldown, Asset Manager. (vi + en)
 * ============================================================================================
 * NGUYÊN TẮC (Master prompt Phần 2, 3, 5):
 *  - Trình duyệt KHÔNG giữ token. Phiên nằm trong cookie HttpOnly do server đặt; file này chỉ gọi /api/auth/*.
 *  - SERVER là nguồn sự thật cho quota & cooldown. Countdown ở đây chỉ để hiển thị: khi về 0 nó hỏi lại
 *    server (/api/auth/quota) và CHỈ gỡ banner khi server nói "active". Không lưu gì vào localStorage.
 *  - Mọi chuỗi động đi vào DOM qua textContent (không innerHTML) => không XSS.
 *  - Không đụng tới app.js: bọc window.fetch để (1) mở khung đăng nhập khi 401, (2) hiện cooldown khi 429
 *    quota_cooldown, (3) làm mới số token sau mỗi lượt gọi AI.
 *  - i18n: bản dịch vi/en nằm NGAY TRONG file này và được nạp vào window.TRANSLATIONS (không sửa translations.js);
 *    mã lỗi (code) của server được ánh xạ sang chuỗi theo ngôn ngữ, không hiển thị chuỗi tiếng Việt cố định của server.
 *  - Đăng ký: giải proof-of-work (xem server/utils/auth/pow.js) ~1 giây bằng Web Crypto để chống tạo tài khoản hàng loạt.
 * ============================================================================================ */
(function () {
  'use strict';
  if (window.__tgAuthUI) return;
  window.__tgAuthUI = true;

  var nativeFetch = window.fetch.bind(window);
  var AI_PATH = /\/api\/(chat|generate|recommend|study|source|visual)(\/|\?|$)/;
  var ASSET_KEYS = ['favicon', 'logo', 'logo_light', 'logo_dark', 'app_icon', 'og_image', 'default_avatar', 'background', 'empty_state', 'auth_image'];

  // ---------------------------------------------------------------- i18n
  var DICT = {
    vi: {
      'auth.pill.login': 'Đăng nhập', 'auth.pill.unconfigured': 'Chưa cấu hình đăng nhập', 'auth.pill.offline': 'Mất kết nối',
      'auth.pill.account': 'Tài khoản', 'auth.pill.wait': 'Chờ {{time}}', 'auth.pill.aria': 'Tài khoản và hạn mức AI',
      'auth.pill.ariaUsed': ': đã dùng {{used}} trên {{limit}} token', 'auth.pill.ariaLogin': 'Đăng nhập hoặc đăng ký',
      'auth.cooldown.before': 'Bạn đã đạt giới hạn sử dụng AI. Vui lòng chờ ', 'auth.cooldown.after': ' trước khi tiếp tục.',
      'auth.cooldown.done': 'Đã hết thời gian chờ. Bạn có thể tiếp tục dùng AI.',
      'auth.cooldown.minutes': 'Còn khoảng {{m}} phút nữa bạn có thể tiếp tục dùng AI.',
      'auth.acct.title': 'Tài khoản & hạn mức AI', 'auth.acct.notSignedIn': 'Bạn chưa đăng nhập.', 'auth.acct.signedInAs': 'Đăng nhập: ',
      'auth.acct.admin': ' · Quản trị viên', 'auth.acct.used': 'Đã sử dụng {{used}} / {{limit}} tokens', 'auth.acct.barLabel': 'Token đã dùng',
      'auth.acct.locked': 'Trạng thái: đang khoá (cooldown)', 'auth.acct.remaining': 'Còn lại {{n}} tokens',
      'auth.acct.assets': 'Quản lý hình ảnh', 'auth.acct.logout': 'Đăng xuất', 'auth.close': 'Đóng',
      'auth.title.login': 'Đăng nhập', 'auth.title.register': 'Tạo tài khoản',
      'auth.sub': 'Đăng nhập để dùng trợ giảng AI và theo dõi hạn mức của bạn.',
      'auth.tab.login': 'Đăng nhập', 'auth.tab.register': 'Đăng ký',
      'auth.field.email': 'Email', 'auth.field.password': 'Mật khẩu', 'auth.field.confirm': 'Nhập lại mật khẩu',
      'auth.show': 'Hiện', 'auth.hide': 'Ẩn', 'auth.showAria': 'Hiện mật khẩu', 'auth.hideAria': 'Ẩn mật khẩu',
      'auth.remember': 'Ghi nhớ đăng nhập trên thiết bị này', 'auth.submit.login': 'Đăng nhập', 'auth.submit.register': 'Đăng ký',
      'auth.busy': 'Đang xử lý…', 'auth.pow.working': 'Đang xác minh chống lạm dụng…',
      'auth.v.email': 'Email không hợp lệ.', 'auth.v.pwEmpty': 'Vui lòng nhập mật khẩu.',
      'auth.v.pwWeak': 'Mật khẩu cần ít nhất 8 ký tự, gồm cả chữ và số.', 'auth.v.mismatch': 'Mật khẩu xác nhận không khớp.',
      'auth.signup.pending': 'Nếu email hợp lệ, bạn sẽ nhận được thư xác nhận (nếu dự án bật xác nhận email). Hãy kiểm tra hộp thư rồi đăng nhập.',
      'auth.err.generic': 'Không thực hiện được. Vui lòng thử lại.',
      'auth.err.network': 'Không kết nối được máy chủ. Vui lòng kiểm tra mạng và thử lại.',
      'auth.err.invalid_credentials': 'Email hoặc mật khẩu không đúng.',
      'auth.err.email_not_confirmed': 'Email chưa được xác nhận. Hãy mở thư xác nhận rồi đăng nhập lại.',
      'auth.err.weak_password': 'Mật khẩu cần ít nhất 8 ký tự, gồm cả chữ và số.', 'auth.err.invalid_email': 'Email không hợp lệ.',
      'auth.err.invalid_credentials_format': 'Vui lòng nhập email và mật khẩu hợp lệ.', 'auth.err.password_mismatch': 'Mật khẩu xác nhận không khớp.',
      'auth.err.auth_unavailable': 'Dịch vụ đăng nhập tạm thời không khả dụng. Vui lòng thử lại sau.',
      'auth.err.auth_rate_limited': 'Quá nhiều lần thử. Vui lòng thử lại sau ít phút.',
      'auth.err.signup_rate_limited': 'Bạn đăng ký quá nhiều tài khoản từ mạng này. Vui lòng thử lại sau ít giờ.',
      'auth.err.pow_invalid': 'Xác minh chống lạm dụng không hợp lệ. Vui lòng thử lại.', 'auth.err.pow_missing': 'Xác minh chống lạm dụng không hợp lệ. Vui lòng thử lại.',
      'auth.err.pow_weak': 'Xác minh chống lạm dụng không hợp lệ. Vui lòng thử lại.', 'auth.err.pow_replay': 'Xác minh chống lạm dụng không hợp lệ. Vui lòng thử lại.',
      'auth.err.pow_expired': 'Phiên xác minh đã hết hạn. Vui lòng thử lại.',
      'auth.err.auth_not_configured': 'Máy chủ chưa cấu hình đăng nhập. Vui lòng liên hệ quản trị viên.',
      'auth.err.bad_origin': 'Yêu cầu bị từ chối do nguồn gốc không hợp lệ.',
      'auth.err.session_expired': 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.', 'auth.err.auth_required': 'Bạn cần đăng nhập để dùng tính năng AI.',
      'auth.err.quota_unavailable': 'Không kiểm tra được hạn mức sử dụng. Vui lòng thử lại sau.',
      'auth.err.ai_concurrency_limit': 'Bạn đang có quá nhiều yêu cầu AI chạy cùng lúc. Hãy đợi một yêu cầu xong rồi gửi tiếp.',
      'auth.err.quota_busy': 'Hạn mức sắp hết và đang có yêu cầu khác xử lý. Vui lòng thử lại sau vài giây.',
      'auth.err.forbidden': 'Bạn không có quyền thực hiện thao tác này.',
      'auth.err.file_too_large': 'File quá lớn (tối đa 1MB).', 'auth.err.unsupported_type': 'Chỉ chấp nhận PNG, JPEG, WebP hoặc ICO (không nhận SVG).',
      'auth.err.bad_dimensions': 'Kích thước ảnh phải trong khoảng 1–4096px mỗi cạnh.', 'auth.err.bad_image': 'Không đọc được kích thước ảnh (file hỏng?).',
      'auth.err.empty_file': 'File rỗng.', 'auth.err.ico_only_favicon': 'ICO chỉ dùng cho favicon.',
      'auth.err.asset_save_failed': 'Không lưu được asset. Vui lòng thử lại.', 'auth.err.asset_reset_failed': 'Không đặt lại được asset. Vui lòng thử lại.',
      'assets.title': 'Quản lý hình ảnh website', 'assets.hint': 'PNG, JPEG, WebP (ICO cho favicon). Tối đa 1MB, mỗi cạnh ≤ 4096px. Xem trước trước khi lưu.',
      'assets.default': 'mặc định', 'assets.alt': 'Mô tả ảnh (alt)', 'assets.altFor': 'Mô tả ảnh cho {{name}}', 'assets.pickFor': 'Chọn ảnh cho {{name}}',
      'assets.save': 'Lưu', 'assets.reset': 'Đặt lại mặc định', 'assets.tooBig': 'File quá lớn (tối đa 1MB).',
      'assets.badType': 'Chỉ chấp nhận PNG, JPEG, WebP hoặc ICO.', 'assets.picked': 'Đã chọn "{{file}}". Bấm Lưu để áp dụng.',
      'assets.uploading': 'Đang tải lên…', 'assets.updated': 'Đã cập nhật "{{name}}".', 'assets.resetConfirm': 'Đặt lại "{{name}}" về mặc định?',
      'assets.resetDone': 'Đã đặt lại về mặc định.', 'assets.readErr': 'Không đọc được file.', 'assets.netErr': 'Lỗi mạng. Vui lòng thử lại.',
      'assets.saveErr': 'Không lưu được.', 'assets.resetErr': 'Không đặt lại được.',
      'assets.label.favicon': 'Favicon (tab trình duyệt)', 'assets.label.logo': 'Logo', 'assets.label.logo_light': 'Logo (nền sáng)',
      'assets.label.logo_dark': 'Logo (nền tối)', 'assets.label.app_icon': 'Icon ứng dụng', 'assets.label.og_image': 'Ảnh chia sẻ (Open Graph)',
      'assets.label.default_avatar': 'Avatar mặc định', 'assets.label.background': 'Ảnh nền', 'assets.label.empty_state': 'Ảnh trạng thái trống',
      'assets.label.auth_image': 'Ảnh khung đăng nhập',
      'viewer.stage': 'Vùng xem hình: dùng + − 0 và phím mũi tên để phóng to, thu nhỏ, di chuyển', 'viewer.out': 'Thu nhỏ', 'viewer.in': 'Phóng to', 'viewer.reset': 'Đặt lại khung nhìn'
    },
    en: {
      'auth.pill.login': 'Sign in', 'auth.pill.unconfigured': 'Sign-in not configured', 'auth.pill.offline': 'Offline',
      'auth.pill.account': 'Account', 'auth.pill.wait': 'Wait {{time}}', 'auth.pill.aria': 'Account and AI usage',
      'auth.pill.ariaUsed': ': {{used}} of {{limit}} tokens used', 'auth.pill.ariaLogin': 'Sign in or sign up',
      'auth.cooldown.before': 'You have reached the AI usage limit. Please wait ', 'auth.cooldown.after': ' before continuing.',
      'auth.cooldown.done': 'The wait is over. You can use AI again.',
      'auth.cooldown.minutes': 'About {{m}} minutes until you can use AI again.',
      'auth.acct.title': 'Account & AI usage', 'auth.acct.notSignedIn': 'You are not signed in.', 'auth.acct.signedInAs': 'Signed in as ',
      'auth.acct.admin': ' · Administrator', 'auth.acct.used': 'Used {{used}} / {{limit}} tokens', 'auth.acct.barLabel': 'Tokens used',
      'auth.acct.locked': 'Status: locked (cooldown)', 'auth.acct.remaining': '{{n}} tokens remaining',
      'auth.acct.assets': 'Manage images', 'auth.acct.logout': 'Sign out', 'auth.close': 'Close',
      'auth.title.login': 'Sign in', 'auth.title.register': 'Create account',
      'auth.sub': 'Sign in to use the AI tutor and track your usage.',
      'auth.tab.login': 'Sign in', 'auth.tab.register': 'Sign up',
      'auth.field.email': 'Email', 'auth.field.password': 'Password', 'auth.field.confirm': 'Confirm password',
      'auth.show': 'Show', 'auth.hide': 'Hide', 'auth.showAria': 'Show password', 'auth.hideAria': 'Hide password',
      'auth.remember': 'Keep me signed in on this device', 'auth.submit.login': 'Sign in', 'auth.submit.register': 'Sign up',
      'auth.busy': 'Working…', 'auth.pow.working': 'Running anti-abuse check…',
      'auth.v.email': 'Invalid email.', 'auth.v.pwEmpty': 'Please enter your password.',
      'auth.v.pwWeak': 'Password needs at least 8 characters, with letters and numbers.', 'auth.v.mismatch': 'Passwords do not match.',
      'auth.signup.pending': 'If the email is valid you will receive a confirmation message (if email confirmation is enabled). Check your inbox, then sign in.',
      'auth.err.generic': 'Something went wrong. Please try again.',
      'auth.err.network': 'Cannot reach the server. Check your connection and try again.',
      'auth.err.invalid_credentials': 'Incorrect email or password.',
      'auth.err.email_not_confirmed': 'Email not confirmed yet. Open the confirmation email, then sign in again.',
      'auth.err.weak_password': 'Password needs at least 8 characters, with letters and numbers.', 'auth.err.invalid_email': 'Invalid email.',
      'auth.err.invalid_credentials_format': 'Please enter a valid email and password.', 'auth.err.password_mismatch': 'Passwords do not match.',
      'auth.err.auth_unavailable': 'Sign-in service is temporarily unavailable. Please try again later.',
      'auth.err.auth_rate_limited': 'Too many attempts. Please try again in a few minutes.',
      'auth.err.signup_rate_limited': 'Too many accounts created from this network. Please try again in a few hours.',
      'auth.err.pow_invalid': 'The anti-abuse check failed. Please try again.', 'auth.err.pow_missing': 'The anti-abuse check failed. Please try again.',
      'auth.err.pow_weak': 'The anti-abuse check failed. Please try again.', 'auth.err.pow_replay': 'The anti-abuse check failed. Please try again.',
      'auth.err.pow_expired': 'The check expired. Please try again.',
      'auth.err.auth_not_configured': 'Sign-in is not configured on the server. Please contact the administrator.',
      'auth.err.bad_origin': 'Request rejected: invalid origin.',
      'auth.err.session_expired': 'Your session has expired. Please sign in again.', 'auth.err.auth_required': 'You need to sign in to use AI features.',
      'auth.err.quota_unavailable': 'Could not check your usage limit. Please try again later.',
      'auth.err.ai_concurrency_limit': 'You have too many AI requests running at once. Wait for one to finish, then send again.',
      'auth.err.quota_busy': 'Your limit is almost used up and another request is in progress. Please retry in a few seconds.',
      'auth.err.forbidden': 'You do not have permission to do this.',
      'auth.err.file_too_large': 'File is too large (max 1 MB).', 'auth.err.unsupported_type': 'Only PNG, JPEG, WebP or ICO are accepted (no SVG).',
      'auth.err.bad_dimensions': 'Image size must be between 1 and 4096 px per side.', 'auth.err.bad_image': 'Could not read the image size (corrupt file?).',
      'auth.err.empty_file': 'The file is empty.', 'auth.err.ico_only_favicon': 'ICO is only allowed for the favicon.',
      'auth.err.asset_save_failed': 'Could not save the asset. Please try again.', 'auth.err.asset_reset_failed': 'Could not reset the asset. Please try again.',
      'assets.title': 'Manage site images', 'assets.hint': 'PNG, JPEG, WebP (ICO for favicon). Max 1 MB, each side ≤ 4096 px. Preview before saving.',
      'assets.default': 'default', 'assets.alt': 'Image description (alt)', 'assets.altFor': 'Image description for {{name}}', 'assets.pickFor': 'Choose image for {{name}}',
      'assets.save': 'Save', 'assets.reset': 'Reset to default', 'assets.tooBig': 'File is too large (max 1 MB).',
      'assets.badType': 'Only PNG, JPEG, WebP or ICO are accepted.', 'assets.picked': 'Selected "{{file}}". Press Save to apply.',
      'assets.uploading': 'Uploading…', 'assets.updated': 'Updated "{{name}}".', 'assets.resetConfirm': 'Reset "{{name}}" to default?',
      'assets.resetDone': 'Reset to default.', 'assets.readErr': 'Could not read the file.', 'assets.netErr': 'Network error. Please try again.',
      'assets.saveErr': 'Could not save.', 'assets.resetErr': 'Could not reset.',
      'assets.label.favicon': 'Favicon (browser tab)', 'assets.label.logo': 'Logo', 'assets.label.logo_light': 'Logo (light background)',
      'assets.label.logo_dark': 'Logo (dark background)', 'assets.label.app_icon': 'App icon', 'assets.label.og_image': 'Share image (Open Graph)',
      'assets.label.default_avatar': 'Default avatar', 'assets.label.background': 'Background image', 'assets.label.empty_state': 'Empty-state image',
      'assets.label.auth_image': 'Sign-in dialog image',
      'viewer.stage': 'Image viewer: use + − 0 and arrow keys to zoom and pan', 'viewer.out': 'Zoom out', 'viewer.in': 'Zoom in', 'viewer.reset': 'Reset view'
    }
  };

  /** Nạp bản dịch vào window.TRANSLATIONS (không ghi đè key đã có) để dùng chung cơ chế t() của dự án. */
  function mergeDict() {
    var all = window.TRANSLATIONS = window.TRANSLATIONS || {};
    Object.keys(DICT).forEach(function (lang) {
      var dst = all[lang] = all[lang] || {};
      Object.keys(DICT[lang]).forEach(function (k) { if (!Object.prototype.hasOwnProperty.call(dst, k)) dst[k] = DICT[lang][k]; });
    });
  }
  function curLang() { try { return (window.languageStore && window.languageStore.getUILanguage && window.languageStore.getUILanguage()) || 'vi'; } catch (e) { return 'vi'; } }
  function interp(s, vars) {
    if (!vars) return s;
    Object.keys(vars).forEach(function (k) { s = s.split('{{' + k + '}}').join(String(vars[k])); });
    return s;
  }
  /** Tra bản dịch: window.t (nếu có) -> từ điển nội bộ theo ngôn ngữ hiện tại -> tiếng Việt -> chính key. */
  function tx(key, vars) {
    var lang = curLang();
    var s = null;
    if (typeof window.t === 'function') { var r = window.t(key, vars); if (r != null && r !== key) s = r; }
    if (s == null) { var d = DICT[lang] && DICT[lang][key]; if (d == null) d = DICT.vi[key]; s = d == null ? key : interp(d, vars); }
    return s;
  }
  function numLocale() { return curLang() === 'en' ? 'en-US' : 'vi-VN'; }
  /** Văn bản lỗi: ưu tiên ánh xạ theo `code` (đa ngôn ngữ), rồi mới tới chuỗi server, rồi chuỗi chung. */
  function errText(json, fallbackKey) {
    var code = json && json.code;
    if (code) { var k = 'auth.err.' + code; var s = tx(k); if (s !== k) return s; }
    return (json && json.error) || tx(fallbackKey || 'auth.err.generic');
  }

  var S = { status: 'loading', enforcement: true, user: null, quota: null, cooldownEndsAt: 0, assets: {}, assetKeys: [] };
  var els = {};
  var tickTimer = null;
  var lastMinuteAnnounced = -1;
  var refreshTimer = null;
  var originalIcons = null;

  // ---------------------------------------------------------------- helpers
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.indexOf('on') === 0 && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  }
  function fmtInt(n) { return Number(n || 0).toLocaleString(numLocale()); }
  function mmss(sec) {
    sec = Math.max(0, Math.round(sec));
    var m = Math.floor(sec / 60), s = sec % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  function api(method, path, body) {
    return nativeFetch(path, {
      method: method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, json: j || {} }; });
    });
  }

  // ---------------------------------------------------------------- proof-of-work (đăng ký)
  var K256 = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  /** SHA-256 thuần JS (dự phòng khi trang chạy ở ngữ cảnh KHÔNG bảo mật, vd http://192.168.x.x — crypto.subtle không tồn tại). */
  function sha256Js(bytes) {
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var l = bytes.length, bitLen = l * 8;
    var padded = new Uint8Array(((l + 9 + 63) >> 6) << 6);
    padded.set(bytes); padded[l] = 0x80;
    var dv = new DataView(padded.buffer);
    dv.setUint32(padded.length - 8, Math.floor(bitLen / 4294967296)); dv.setUint32(padded.length - 4, bitLen >>> 0);
    var w = new Array(64);
    for (var off = 0; off < padded.length; off += 64) {
      for (var i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
      for (i = 16; i < 64; i++) {
        var s0 = ((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^ ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^ (w[i - 15] >>> 3);
        var s1 = ((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^ ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], hh = H[7];
      for (i = 0; i < 64; i++) {
        var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        var ch = (e & f) ^ (~e & g);
        var t1 = (hh + S1 + ch + K256[i] + w[i]) | 0;
        var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + hh) | 0;
    }
    var out = new Uint8Array(32), ov = new DataView(out.buffer);
    for (i = 0; i < 8; i++) ov.setUint32(i * 4, H[i]);
    return out;
  }
  function leadingZeroBits(u8) {
    var bits = 0;
    for (var i = 0; i < u8.length; i++) {
      if (u8[i] === 0) { bits += 8; continue; }
      bits += Math.clz32(u8[i]) - 24; break;
    }
    return bits;
  }
  /** Tìm nonce sao cho SHA-256(`${salt}:${nonce}`) có >= bits bit 0 đầu. Không chặn luồng UI. */
  async function solvePow(salt, bits) {
    var enc = new TextEncoder();
    var subtle = window.crypto && window.crypto.subtle;
    var n = 0, LIMIT = 1 << 27;
    if (subtle) {
      var BATCH = 512;
      while (n < LIMIT) {
        var jobs = [];
        for (var i = 0; i < BATCH; i++) jobs.push(subtle.digest('SHA-256', enc.encode(salt + ':' + (n + i))));
        var res = await Promise.all(jobs);
        for (i = 0; i < BATCH; i++) if (leadingZeroBits(new Uint8Array(res[i])) >= bits) return n + i;
        n += BATCH;
      }
    } else {
      var t0 = Date.now();
      while (n < LIMIT) {
        if (leadingZeroBits(sha256Js(enc.encode(salt + ':' + n))) >= bits) return n;
        n += 1;
        if (Date.now() - t0 > 40) { await new Promise(function (r) { setTimeout(r, 0); }); t0 = Date.now(); }
      }
    }
    throw new Error('pow_unsolved');
  }

  // ---------------------------------------------------------------- styles
  var CSS = [
    ':root{--tg-bg:#fff;--tg-fg:#111827;--tg-muted:#6b7280;--tg-line:#e5e7eb;--tg-primary:#2563eb;--tg-primary-fg:#fff;--tg-danger:#b91c1c;--tg-ok:#15803d;--tg-warn-bg:#fef3c7;--tg-warn-fg:#78350f;--tg-shadow:0 20px 50px rgba(0,0,0,.25)}',
    '@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--tg-bg:#1f2937;--tg-fg:#f3f4f6;--tg-muted:#9ca3af;--tg-line:#374151;--tg-primary:#60a5fa;--tg-primary-fg:#0b1220;--tg-danger:#fca5a5;--tg-ok:#86efac;--tg-warn-bg:#422006;--tg-warn-fg:#fde68a}}',
    ':root[data-theme="dark"],body.dark{--tg-bg:#1f2937;--tg-fg:#f3f4f6;--tg-muted:#9ca3af;--tg-line:#374151;--tg-primary:#60a5fa;--tg-primary-fg:#0b1220;--tg-danger:#fca5a5;--tg-ok:#86efac;--tg-warn-bg:#422006;--tg-warn-fg:#fde68a}',
    '.tg-pill{display:inline-flex;align-items:center;gap:6px;min-height:36px;padding:0 12px;border:1px solid var(--tg-line);border-radius:999px;background:var(--tg-bg);color:var(--tg-fg);font:600 12.5px/1 Inter,system-ui,sans-serif;cursor:pointer;margin-right:8px;max-width:46vw;white-space:nowrap}',
    '.tg-pill:hover{border-color:var(--tg-primary)}.tg-pill .tg-pill-t{overflow:hidden;text-overflow:ellipsis}',
    '.tg-pill[data-state="cooldown"]{background:var(--tg-warn-bg);color:var(--tg-warn-fg);border-color:transparent}',
    '.tg-pill:focus-visible,.tg-btn:focus-visible,.tg-in:focus-visible,.tg-tab:focus-visible,.tg-x:focus-visible{outline:3px solid var(--tg-primary);outline-offset:2px}',
    '.tg-overlay{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:max(12px,env(safe-area-inset-top)) 12px max(12px,env(safe-area-inset-bottom))}',
    '.tg-overlay[hidden]{display:none}',
    '.tg-card{width:min(420px,100%);max-height:calc(100dvh - 24px);overflow:auto;background:var(--tg-bg);color:var(--tg-fg);border-radius:16px;box-shadow:var(--tg-shadow);padding:20px;font:400 14px/1.5 Inter,system-ui,sans-serif;position:relative}',
    '.tg-card h2{margin:0 0 4px;font:700 20px/1.3 Sora,Inter,system-ui,sans-serif}.tg-sub{color:var(--tg-muted);margin:0 0 14px;font-size:13px}',
    '.tg-x{position:absolute;top:8px;right:8px;width:44px;height:44px;border:0;border-radius:10px;background:transparent;color:var(--tg-muted);font-size:20px;cursor:pointer}',
    '.tg-tabs{display:flex;gap:6px;margin:0 0 14px;background:var(--tg-line);padding:4px;border-radius:12px}',
    '.tg-tab{flex:1;min-height:40px;border:0;border-radius:9px;background:transparent;color:var(--tg-fg);font-weight:600;cursor:pointer}.tg-tab[aria-selected="true"]{background:var(--tg-bg);box-shadow:0 1px 3px rgba(0,0,0,.15)}',
    '.tg-field{display:block;margin:0 0 12px}.tg-field>span{display:block;font-weight:600;font-size:13px;margin-bottom:4px}',
    '.tg-in{width:100%;box-sizing:border-box;min-height:44px;padding:0 12px;border:1px solid var(--tg-line);border-radius:10px;background:var(--tg-bg);color:var(--tg-fg);font:inherit;font-size:16px}',
    '.tg-row{display:flex;gap:8px;align-items:center}.tg-row .tg-in{flex:1}',
    '.tg-check{display:flex;gap:8px;align-items:center;margin:0 0 14px;font-size:13px;min-height:32px}.tg-check input{width:18px;height:18px}',
    '.tg-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;padding:0 16px;border-radius:10px;border:1px solid var(--tg-line);background:var(--tg-bg);color:var(--tg-fg);font:600 14px/1 Inter,system-ui,sans-serif;cursor:pointer}',
    '.tg-btn.primary{background:var(--tg-primary);color:var(--tg-primary-fg);border-color:transparent;width:100%}.tg-btn[disabled]{opacity:.6;cursor:not-allowed}',
    '.tg-btn.danger{color:var(--tg-danger)}.tg-msg{min-height:20px;margin:0 0 10px;font-size:13px}.tg-msg.err{color:var(--tg-danger)}.tg-msg.ok{color:var(--tg-ok)}',
    '.tg-bar{height:10px;background:var(--tg-line);border-radius:99px;overflow:hidden;margin:8px 0}.tg-bar>i{display:block;height:100%;background:var(--tg-primary);width:0;transition:width .3s}',
    '.tg-bar[data-hot="1"]>i{background:#d97706}.tg-bar[data-full="1"]>i{background:var(--tg-danger)}',
    '.tg-banner{position:fixed;left:0;right:0;top:0;z-index:2147482000;background:var(--tg-warn-bg);color:var(--tg-warn-fg);padding:calc(10px + env(safe-area-inset-top)) 16px 10px;text-align:center;font:600 14px/1.4 Inter,system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.2)}',
    '.tg-banner[hidden]{display:none}.tg-banner b{font-variant-numeric:tabular-nums}',
    '.tg-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}',
    '.tg-asset{display:grid;grid-template-columns:64px 1fr;gap:10px;padding:10px 0;border-top:1px solid var(--tg-line)}.tg-asset img{width:64px;height:64px;object-fit:contain;background:repeating-conic-gradient(#0001 0 25%,#0000 0 50%) 0/16px 16px;border-radius:8px}',
    '.tg-asset .tg-acts{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}.tg-asset .tg-btn{min-height:40px;padding:0 12px;font-size:13px}.tg-asset small{color:var(--tg-muted)}',
    '.tg-authimg{display:block;max-width:100%;max-height:120px;margin:0 auto 12px;object-fit:contain}',
    '@media (prefers-reduced-motion:reduce){.tg-bar>i{transition:none}}'
  ].join('\n');

  // ---------------------------------------------------------------- state / render
  function setStatus(status, user) {
    S.status = status; S.user = user || null;
    renderPill(); renderAccount();
    if (status !== 'authenticated') { S.quota = null; S.cooldownEndsAt = 0; renderBanner(); }
  }

  function quotaSummary() {
    var q = S.quota;
    if (!q || q.status === 'disabled') return null;
    return { used: q.tokensUsed || 0, limit: q.tokenLimit || 0, reserved: q.tokensReserved || 0 };
  }

  function renderPill() {
    if (!els.pill) return;
    var t = els.pill.querySelector('.tg-pill-t');
    if (S.status === 'disabled' || S.status === 'unconfigured') { els.pill.hidden = S.status === 'disabled'; t.textContent = tx('auth.pill.unconfigured'); els.pill.dataset.state = 'warn'; return; }
    els.pill.hidden = false;
    if (S.status === 'loading') { t.textContent = '…'; els.pill.dataset.state = ''; return; }
    if (S.status === 'unavailable') { t.textContent = tx('auth.pill.offline'); els.pill.dataset.state = 'warn'; return; }
    if (S.status !== 'authenticated') { t.textContent = tx('auth.pill.login'); els.pill.dataset.state = ''; els.pill.setAttribute('aria-label', tx('auth.pill.ariaLogin')); return; }
    var qs = quotaSummary();
    var cd = S.cooldownEndsAt > Date.now();
    els.pill.dataset.state = cd ? 'cooldown' : '';
    if (cd) t.textContent = tx('auth.pill.wait', { time: mmss((S.cooldownEndsAt - Date.now()) / 1000) });
    else if (qs) t.textContent = fmtInt(qs.used) + ' / ' + fmtInt(qs.limit);
    else t.textContent = S.user && S.user.email ? S.user.email.split('@')[0] : tx('auth.pill.account');
    els.pill.setAttribute('aria-label', tx('auth.pill.aria') + (qs ? tx('auth.pill.ariaUsed', { used: fmtInt(qs.used), limit: fmtInt(qs.limit) }) : ''));
  }

  function renderBanner() {
    if (!els.banner) return;
    var cd = S.status === 'authenticated' && S.cooldownEndsAt > Date.now();
    els.banner.hidden = !cd;
    if (!cd) return;
    els.bannerTime.textContent = mmss((S.cooldownEndsAt - Date.now()) / 1000);
  }
  function renderBannerStatic() {
    if (!els.banner) return;
    els.bannerBefore.textContent = tx('auth.cooldown.before');
    els.bannerAfter.textContent = tx('auth.cooldown.after');
  }

  function renderAccount() {
    if (!els.account || els.account.hidden) return;
    var body = els.accountBody; body.textContent = '';
    if (S.status !== 'authenticated') { body.appendChild(h('p', { class: 'tg-sub', text: tx('auth.acct.notSignedIn') })); return; }
    var u = S.user || {};
    body.appendChild(h('p', { class: 'tg-sub' }, tx('auth.acct.signedInAs'), h('b', { text: u.email || '' }), u.role === 'admin' ? tx('auth.acct.admin') : ''));
    var qs = quotaSummary();
    if (qs) {
      var pct = qs.limit ? Math.min(100, Math.round((qs.used + qs.reserved) / qs.limit * 100)) : 0;
      var cd = S.cooldownEndsAt > Date.now();
      var bar = h('div', { class: 'tg-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(qs.limit), 'aria-valuenow': String(qs.used), 'aria-label': tx('auth.acct.barLabel'), 'data-hot': pct >= 80 ? '1' : '', 'data-full': pct >= 100 ? '1' : '' }, h('i', { style: 'width:' + pct + '%' }));
      body.appendChild(h('div', { text: tx('auth.acct.used', { used: fmtInt(qs.used), limit: fmtInt(qs.limit) }) }));
      body.appendChild(bar);
      body.appendChild(h('div', { class: 'tg-sub', text: cd ? tx('auth.acct.locked') : tx('auth.acct.remaining', { n: fmtInt(Math.max(0, qs.limit - qs.used - qs.reserved)) }) }));
      if (cd) {
        body.appendChild(h('p', { class: 'tg-msg err' }, tx('auth.cooldown.before'), h('b', { id: 'tgAcctTime', 'aria-hidden': 'true', text: mmss((S.cooldownEndsAt - Date.now()) / 1000) }), tx('auth.cooldown.after')));
      }
    }
    var acts = h('div', { class: 'tg-row', style: 'margin-top:12px;flex-wrap:wrap' });
    if (u.role === 'admin') acts.appendChild(h('button', { class: 'tg-btn', type: 'button', onclick: openAssets, text: tx('auth.acct.assets') }));
    acts.appendChild(h('button', { class: 'tg-btn danger', type: 'button', onclick: doLogout, text: tx('auth.acct.logout') }));
    body.appendChild(acts);
  }

  // Cập nhật 1 giây/lần chỉ phần hiển thị. Thông báo cho screen reader thưa (mỗi phút + khi kết thúc).
  function tick() {
    if (S.cooldownEndsAt) {
      var left = (S.cooldownEndsAt - Date.now()) / 1000;
      if (left <= 0) {
        S.cooldownEndsAt = 0;
        refreshQuota(); // SERVER quyết định đã hết cooldown thật chưa
        announce(tx('auth.cooldown.done'));
        lastMinuteAnnounced = -1;
      } else {
        var m = Math.ceil(left / 60);
        if (m !== lastMinuteAnnounced) { lastMinuteAnnounced = m; announce(tx('auth.cooldown.minutes', { m: m })); }
        if (els.bannerTime) els.bannerTime.textContent = mmss(left);
        var a = document.getElementById('tgAcctTime'); if (a) a.textContent = mmss(left);
      }
      renderPill(); renderBanner();
    }
  }
  function announce(msg) { if (els.live) { els.live.textContent = ''; setTimeout(function () { els.live.textContent = msg; }, 30); } }

  // ---------------------------------------------------------------- quota
  function applyQuota(q) {
    if (!q || q.status === 'disabled') { S.quota = q || null; return; }
    S.quota = q;
    var ra = Number(q.retryAfterSeconds) || 0;
    S.cooldownEndsAt = q.status === 'cooldown' && ra > 0 ? Date.now() + ra * 1000 : 0; // đếm theo GIÂY còn lại do server báo (không tin đồng hồ máy)
    renderPill(); renderBanner(); renderAccount();
  }
  function refreshQuota() {
    if (S.status !== 'authenticated') return Promise.resolve();
    return api('GET', '/api/auth/quota').then(function (r) {
      if (r.status === 401) { handleUnauthorized(r.json); return; }
      if (r.ok) applyQuota(r.json);
    }).catch(function () { /* mạng lỗi: giữ số liệu cũ, không tự mở khoá */ });
  }
  function scheduleRefresh(ms) { clearTimeout(refreshTimer); refreshTimer = setTimeout(refreshQuota, ms); }

  // ---------------------------------------------------------------- fetch interceptor
  function handleUnauthorized(j) {
    var expired = j && j.code === 'session_expired';
    setStatus('unauthenticated', null);
    openAuth('login', tx(expired ? 'auth.err.session_expired' : 'auth.err.auth_required'));
  }
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    return nativeFetch(input, init).then(function (res) {
      try {
        if (url.indexOf('/api/') !== -1 && url.indexOf('/api/auth/') === -1 && url.indexOf('/api/assets/') === -1) {
          if (res.status === 401) {
            res.clone().json().then(handleUnauthorized).catch(function () { handleUnauthorized({}); });
          } else if (res.status === 429) {
            res.clone().json().then(function (j) {
              if (j && j.code === 'quota_cooldown') {
                S.cooldownEndsAt = Date.now() + (Number(j.retryAfterSeconds) || 0) * 1000;
                renderPill(); renderBanner(); renderAccount(); refreshQuota();
              }
            }).catch(function () {});
          } else if (res.ok && method !== 'GET' && AI_PATH.test(url) && S.status === 'authenticated') {
            // Token chỉ được chốt khi response KẾT THÚC (stream xong) -> đợi clone đọc hết rồi mới hỏi server.
            res.clone().arrayBuffer().then(function () { scheduleRefresh(700); }).catch(function () { scheduleRefresh(2500); });
          }
        }
      } catch (e) { /* interceptor không bao giờ được làm hỏng request gốc */ }
      return res;
    });
  };

  // ---------------------------------------------------------------- auth dialog
  var authMode = 'login';
  var busy = false;
  var lastFocus = null;

  function buildAuth() {
    var title = h('h2', { id: 'tgAuthTitle', text: tx('auth.title.login') });
    var sub = h('p', { class: 'tg-sub', id: 'tgAuthSub', text: tx('auth.sub') });
    var tabLogin = h('button', { class: 'tg-tab', type: 'button', role: 'tab', id: 'tgTabLogin', 'aria-selected': 'true', onclick: function () { switchMode('login'); }, text: tx('auth.tab.login') });
    var tabReg = h('button', { class: 'tg-tab', type: 'button', role: 'tab', id: 'tgTabReg', 'aria-selected': 'false', onclick: function () { switchMode('register'); }, text: tx('auth.tab.register') });
    var email = h('input', { class: 'tg-in', type: 'email', id: 'tgEmail', name: 'email', autocomplete: 'email', inputmode: 'email', required: true, maxlength: '254', autocapitalize: 'none', spellcheck: 'false' });
    var pw = h('input', { class: 'tg-in', type: 'password', id: 'tgPw', name: 'password', autocomplete: 'current-password', required: true, maxlength: '72' });
    var pw2 = h('input', { class: 'tg-in', type: 'password', id: 'tgPw2', name: 'confirm', autocomplete: 'new-password', maxlength: '72' });
    var show = h('button', { class: 'tg-btn', type: 'button', 'aria-label': tx('auth.showAria'), 'aria-pressed': 'false', style: 'min-width:44px;padding:0 10px', onclick: function () {
      var on = pw.type === 'password'; pw.type = on ? 'text' : 'password'; pw2.type = pw.type; show.setAttribute('aria-pressed', String(on)); show.setAttribute('aria-label', tx(on ? 'auth.hideAria' : 'auth.showAria')); show.textContent = tx(on ? 'auth.hide' : 'auth.show');
    }, text: tx('auth.show') });
    var remember = h('input', { type: 'checkbox', id: 'tgRemember', checked: true });
    var msg = h('div', { class: 'tg-msg', id: 'tgAuthMsg', role: 'alert', 'aria-live': 'assertive' });
    var submit = h('button', { class: 'tg-btn primary', type: 'submit', id: 'tgSubmit', text: tx('auth.submit.login') });
    var close = h('button', { class: 'tg-x', type: 'button', 'aria-label': tx('auth.close'), onclick: closeAuth, text: '✕' });
    var img = h('img', { class: 'tg-authimg', alt: '', hidden: true });
    var confirmWrap = h('label', { class: 'tg-field', hidden: true }, h('span', { text: tx('auth.field.confirm') }), pw2);
    var form = h('form', { novalidate: true, onsubmit: onSubmit },
      h('label', { class: 'tg-field' }, h('span', { text: tx('auth.field.email') }), email),
      h('label', { class: 'tg-field' }, h('span', { text: tx('auth.field.password') }), h('div', { class: 'tg-row' }, pw, show)),
      confirmWrap,
      h('label', { class: 'tg-check' }, remember, h('span', { text: tx('auth.remember') })),
      msg, submit);
    var card = h('div', { class: 'tg-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tgAuthTitle' }, close, img, title, sub, h('div', { class: 'tg-tabs', role: 'tablist' }, tabLogin, tabReg), form);
    var ov = h('div', { class: 'tg-overlay', hidden: true, onmousedown: function (e) { if (e.target === ov) closeAuth(); }, onkeydown: trapKeys }, card);
    els.auth = ov; els.authEls = { title: title, sub: sub, tabLogin: tabLogin, tabReg: tabReg, email: email, pw: pw, pw2: pw2, confirmWrap: confirmWrap, remember: remember, msg: msg, submit: submit, img: img };
    document.body.appendChild(ov);
  }
  function trapKeys(e) {
    var ov = e.currentTarget;
    if (e.key === 'Escape') { e.stopPropagation(); if (ov === els.auth) closeAuth(); else if (ov === els.account) closeAccount(); else if (ov === els.assets) closeAssets(); return; }
    if (e.key !== 'Tab') return;
    var f = ov.querySelectorAll('button:not([disabled]),input:not([disabled]),select,a[href],[tabindex]:not([tabindex="-1"])');
    f = Array.prototype.filter.call(f, function (n) { return n.offsetParent !== null; });
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  function switchMode(mode) {
    authMode = mode;
    var E = els.authEls, reg = mode === 'register';
    E.tabLogin.setAttribute('aria-selected', String(!reg)); E.tabReg.setAttribute('aria-selected', String(reg));
    E.confirmWrap.hidden = !reg; E.pw.autocomplete = reg ? 'new-password' : 'current-password';
    E.title.textContent = tx(reg ? 'auth.title.register' : 'auth.title.login');
    E.submit.textContent = tx(reg ? 'auth.submit.register' : 'auth.submit.login');
    E.msg.textContent = ''; E.msg.className = 'tg-msg';
  }
  function setMsg(text, kind) { els.authEls.msg.textContent = text || ''; els.authEls.msg.className = 'tg-msg' + (kind ? ' ' + kind : ''); }
  function openAuth(mode, message) {
    if (!els.auth) buildAuth();
    lastFocus = document.activeElement;
    switchMode(mode || 'login');
    setMsg(message || '', message ? 'err' : '');
    var a = S.assets.auth_image; var img = els.authEls.img;
    if (a) { img.src = a.url; img.alt = a.alt || ''; img.hidden = false; } else { img.hidden = true; }
    els.auth.hidden = false;
    setTimeout(function () { els.authEls.email.focus(); }, 0);
  }
  function closeAuth() { if (els.auth) els.auth.hidden = true; if (lastFocus && lastFocus.focus) try { lastFocus.focus(); } catch (e) {} }
  function setBusy(b, label) {
    busy = b; var E = els.authEls;
    E.submit.disabled = b; E.submit.textContent = b ? (label || tx('auth.busy')) : tx(authMode === 'register' ? 'auth.submit.register' : 'auth.submit.login');
    E.submit.setAttribute('aria-busy', String(b));
  }
  /** Lấy challenge + giải PoW. Trả {challenge, nonce} hoặc {} nếu server tắt PoW. */
  async function getPowSolution() {
    var r = await api('GET', '/api/auth/challenge');
    if (!r.ok) { var e = new Error('challenge_failed'); e.json = r.json; throw e; }
    if (!r.json || !r.json.enabled) return {};
    var nonce = await solvePow(r.json.salt, r.json.bits);
    return { challenge: r.json.token, nonce: String(nonce) };
  }
  function onSubmit(e) {
    e.preventDefault();
    if (busy) return; // chống double-submit
    var E = els.authEls;
    var email = E.email.value.trim(), pw = E.pw.value;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { setMsg(tx('auth.v.email'), 'err'); E.email.focus(); return; }
    if (!pw) { setMsg(tx('auth.v.pwEmpty'), 'err'); E.pw.focus(); return; }
    var reg = authMode === 'register';
    if (reg) {
      if (pw.length < 8 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) { setMsg(tx('auth.v.pwWeak'), 'err'); E.pw.focus(); return; }
      if (pw !== E.pw2.value) { setMsg(tx('auth.v.mismatch'), 'err'); E.pw2.focus(); return; }
    }
    setBusy(true, reg ? tx('auth.pow.working') : null); setMsg('');
    (reg ? getPowSolution() : Promise.resolve({}))
      .then(function (pow) {
        setBusy(true);
        return api('POST', reg ? '/api/auth/signup' : '/api/auth/login', { email: email, password: pw, confirmPassword: reg ? E.pw2.value : undefined, remember: E.remember.checked, challenge: pow.challenge, nonce: pow.nonce });
      })
      .then(function (r) {
        setBusy(false);
        if (!r.ok) { setMsg(errText(r.json), 'err'); return; }
        E.pw.value = ''; E.pw2.value = '';
        if (r.json.status === 'confirmation_pending') { switchMode('login'); setMsg(tx('auth.signup.pending'), 'ok'); return; }
        closeAuth(); loadSession();
      })
      .catch(function (err) {
        setBusy(false);
        setMsg(err && err.json ? errText(err.json) : tx('auth.err.network'), 'err');
      });
  }
  function doLogout() {
    setStatus('signing_out', S.user); renderPill();
    api('POST', '/api/auth/logout').finally(function () { closeAccount(); setStatus('unauthenticated', null); });
  }

  // ---------------------------------------------------------------- account dialog
  function buildAccount() {
    var body = h('div'); var close = h('button', { class: 'tg-x', type: 'button', 'aria-label': tx('auth.close'), onclick: closeAccount, text: '✕' });
    var card = h('div', { class: 'tg-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tgAcctTitle' }, close, h('h2', { id: 'tgAcctTitle', text: tx('auth.acct.title') }), body);
    var ov = h('div', { class: 'tg-overlay', hidden: true, onmousedown: function (e) { if (e.target === ov) closeAccount(); }, onkeydown: trapKeys }, card);
    els.account = ov; els.accountBody = body; document.body.appendChild(ov);
  }
  function openAccount() {
    if (S.status !== 'authenticated') { if (S.status === 'unavailable') { loadSession(); return; } openAuth('login'); return; }
    if (!els.account) buildAccount();
    lastFocus = document.activeElement; els.account.hidden = false; renderAccount(); refreshQuota();
    setTimeout(function () { var b = els.account.querySelector('.tg-x'); b && b.focus(); }, 0);
  }
  function closeAccount() { if (els.account) els.account.hidden = true; if (lastFocus && lastFocus.focus) try { lastFocus.focus(); } catch (e) {} }

  // ---------------------------------------------------------------- assets (apply + admin)
  function captureOriginalIcons() {
    if (originalIcons) return;
    originalIcons = Array.prototype.map.call(document.querySelectorAll('link[rel~="icon"],link[rel="apple-touch-icon"]'), function (l) {
      return { rel: l.getAttribute('rel'), href: l.getAttribute('href'), type: l.getAttribute('type') };
    });
  }
  function setMeta(sel, attr, val) { var m = document.querySelector(sel); if (m) m.setAttribute(attr, val); }
  function applyAssets(map) {
    S.assets = map || {};
    captureOriginalIcons();
    var root = document.documentElement;
    ['background', 'default_avatar', 'empty_state', 'auth_image', 'logo', 'logo_light', 'logo_dark', 'app_icon', 'og_image', 'favicon'].forEach(function (k) {
      if (S.assets[k]) root.style.setProperty('--tg-asset-' + k.replace(/_/g, '-'), 'url("' + S.assets[k].url + '")'); else root.style.removeProperty('--tg-asset-' + k.replace(/_/g, '-'));
    });
    // favicon: đổi THẬT. URL kèm ?v=<version> nên trình duyệt buộc tải bản mới; reset => quay về icon gốc.
    var fav = S.assets.favicon; var icon = S.assets.app_icon || S.assets.favicon;
    document.querySelectorAll('link[rel~="icon"]').forEach(function (l) { l.parentNode.removeChild(l); });
    document.querySelectorAll('link[rel="apple-touch-icon"]').forEach(function (l) { l.parentNode.removeChild(l); });
    if (fav) {
      document.head.appendChild(h('link', { rel: 'icon', href: fav.url, type: fav.contentType || 'image/png' }));
    } else {
      originalIcons.filter(function (o) { return /icon/.test(o.rel) && o.rel !== 'apple-touch-icon'; }).forEach(function (o) { document.head.appendChild(h('link', { rel: o.rel, href: o.href, type: o.type })); });
    }
    if (icon) document.head.appendChild(h('link', { rel: 'apple-touch-icon', href: icon.url }));
    else originalIcons.filter(function (o) { return o.rel === 'apple-touch-icon'; }).forEach(function (o) { document.head.appendChild(h('link', { rel: o.rel, href: o.href })); });
    if (S.assets.og_image) setMeta('meta[property="og:image"]', 'content', location.origin + S.assets.og_image.url);
    // logo thương hiệu trong sidebar (thay icon bút chì mặc định khi có logo)
    var brand = document.querySelector('#sidebar .brand h1'); var logo = S.assets.logo;
    if (brand) {
      var old = brand.querySelector('img.tg-logo'); if (old) old.parentNode.removeChild(old);
      var pencil = brand.querySelector('.brand-pencil');
      if (logo) { brand.insertBefore(h('img', { class: 'tg-logo', src: logo.url, alt: logo.alt || '', style: 'height:1.2em;width:auto;vertical-align:-0.2em;margin-right:.35em' }), brand.firstChild); if (pencil) pencil.style.display = 'none'; }
      else if (pencil) pencil.style.display = '';
    }
  }
  function loadAssets() {
    return nativeFetch('/api/assets/config', { credentials: 'same-origin' }).then(function (r) { return r.json(); })
      .then(function (j) { S.assetKeys = j.keys || []; applyAssets(j.assets || {}); })
      .catch(function () { /* lỗi asset không được chặn app: giữ asset mặc định */ });
  }
  function assetLabel(key) { var k = 'assets.label.' + key; var s = tx(k); return s === k ? key : s; }

  function buildAssets() {
    var list = h('div'); var msg = h('div', { class: 'tg-msg', role: 'status', 'aria-live': 'polite' });
    var close = h('button', { class: 'tg-x', type: 'button', 'aria-label': tx('auth.close'), onclick: closeAssets, text: '✕' });
    var card = h('div', { class: 'tg-card', style: 'width:min(560px,100%)', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tgAstTitle' }, close, h('h2', { id: 'tgAstTitle', text: tx('assets.title') }),
      h('p', { class: 'tg-sub', text: tx('assets.hint') }), msg, list);
    var ov = h('div', { class: 'tg-overlay', hidden: true, onmousedown: function (e) { if (e.target === ov) closeAssets(); }, onkeydown: trapKeys }, card);
    els.assets = ov; els.assetList = list; els.assetMsg = msg; document.body.appendChild(ov);
  }
  function assetMsg(t, kind) { els.assetMsg.textContent = t || ''; els.assetMsg.className = 'tg-msg' + (kind ? ' ' + kind : ''); }
  function renderAssetList() {
    var list = els.assetList; list.textContent = '';
    (S.assetKeys.length ? S.assetKeys : ASSET_KEYS).forEach(function (key) {
      var cur = S.assets[key]; var pending = null; var objUrl = null; var name = assetLabel(key);
      var img = h('img', { alt: '', src: cur ? cur.url : 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==' });
      var alt = h('input', { class: 'tg-in', type: 'text', maxlength: '200', placeholder: tx('assets.alt'), 'aria-label': tx('assets.altFor', { name: name }), value: cur ? cur.alt : '', style: 'min-height:40px;font-size:14px' });
      var save = h('button', { class: 'tg-btn primary', type: 'button', disabled: true, style: 'width:auto', text: tx('assets.save') });
      var reset = h('button', { class: 'tg-btn', type: 'button', disabled: !cur, text: tx('assets.reset') });
      var file = h('input', { type: 'file', accept: key === 'favicon' ? 'image/png,image/jpeg,image/webp,image/x-icon,.ico' : 'image/png,image/jpeg,image/webp', 'aria-label': tx('assets.pickFor', { name: name }) });
      file.addEventListener('change', function () {
        var f = file.files && file.files[0]; pending = null; save.disabled = true;
        if (objUrl) { URL.revokeObjectURL(objUrl); objUrl = null; }
        if (!f) return;
        if (f.size > 1024 * 1024) { assetMsg(tx('assets.tooBig'), 'err'); file.value = ''; return; }
        if (!/^image\/(png|jpeg|webp|x-icon|vnd\.microsoft\.icon)$/.test(f.type) && !/\.ico$/i.test(f.name)) { assetMsg(tx('assets.badType'), 'err'); file.value = ''; return; }
        pending = f; objUrl = URL.createObjectURL(f); img.src = objUrl; save.disabled = false; assetMsg(tx('assets.picked', { file: f.name }), '');
      });
      save.addEventListener('click', function () {
        if (!pending) return; save.disabled = true; assetMsg(tx('assets.uploading'), '');
        var fr = new FileReader();
        fr.onload = function () {
          var b64 = String(fr.result).split(',')[1] || '';
          api('PUT', '/api/assets/' + key, { dataBase64: b64, alt: alt.value }).then(function (r) {
            if (!r.ok) { assetMsg(errText(r.json, 'assets.saveErr'), 'err'); save.disabled = false; return; }
            assetMsg(tx('assets.updated', { name: name }), 'ok'); loadAssets().then(renderAssetList);
          }).catch(function () { assetMsg(tx('assets.netErr'), 'err'); save.disabled = false; });
        };
        fr.onerror = function () { assetMsg(tx('assets.readErr'), 'err'); save.disabled = false; };
        fr.readAsDataURL(pending);
      });
      reset.addEventListener('click', function () {
        if (!window.confirm(tx('assets.resetConfirm', { name: name }))) return;
        api('DELETE', '/api/assets/' + key).then(function (r) {
          if (!r.ok) { assetMsg(errText(r.json, 'assets.resetErr'), 'err'); return; }
          assetMsg(tx('assets.resetDone'), 'ok'); loadAssets().then(renderAssetList);
        });
      });
      list.appendChild(h('div', { class: 'tg-asset' }, img, h('div', null,
        h('b', { text: name }), ' ', h('small', { text: cur ? 'v' + cur.version : tx('assets.default') }), h('div', null, file), h('div', { style: 'margin-top:6px' }, alt),
        h('div', { class: 'tg-acts' }, save, reset))));
    });
  }
  function openAssets() {
    if (!S.user || S.user.role !== 'admin') return;
    closeAccount(); if (!els.assets) buildAssets();
    lastFocus = document.activeElement; assetMsg(''); els.assets.hidden = false;
    loadAssets().then(renderAssetList);
  }
  function closeAssets() { if (els.assets) els.assets.hidden = true; }

  // ---------------------------------------------------------------- đổi ngôn ngữ: dựng lại hộp thoại, cập nhật chữ cố định
  function onLanguageChange() {
    ['auth', 'account', 'assets'].forEach(function (k) { if (els[k]) { if (els[k].parentNode) els[k].parentNode.removeChild(els[k]); els[k] = null; } });
    renderBannerStatic(); renderPill(); renderBanner();
  }

  // ---------------------------------------------------------------- bootstrap
  function loadSession() {
    return api('GET', '/api/auth/session').then(function (r) {
      var j = r.json || {};
      S.enforcement = j.enforcement !== false;
      if (j.status === 'authenticated') { setStatus('authenticated', j.user); refreshQuota(); }
      else if (j.status === 'disabled' || j.status === 'unconfigured') { setStatus(j.status, null); }
      else if (j.status === 'unavailable') { setStatus('unavailable', null); }
      else { var first = S.status === 'loading'; setStatus('unauthenticated', null); if (first) openAuth('login', j.status === 'expired' ? tx('auth.err.session_expired') : ''); }
    }).catch(function () { setStatus('unavailable', null); });
  }

  function init() {
    mergeDict();
    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    els.live = h('div', { class: 'tg-sr', 'aria-live': 'polite', role: 'status' });
    els.bannerTime = h('b', { text: '00:00' });
    els.bannerBefore = document.createTextNode(tx('auth.cooldown.before'));
    els.bannerAfter = document.createTextNode(tx('auth.cooldown.after'));
    els.banner = h('div', { class: 'tg-banner', hidden: true, role: 'alert' }, els.bannerBefore, els.bannerTime, els.bannerAfter);
    // renderBannerStatic() cập nhật nội dung TEXT NODE (không phải phần tử)
    els.bannerBefore.textContent = tx('auth.cooldown.before'); els.bannerAfter.textContent = tx('auth.cooldown.after');
    els.pill = h('button', { class: 'tg-pill', type: 'button', 'aria-haspopup': 'dialog', onclick: openAccount }, h('span', { 'aria-hidden': 'true', text: '👤' }), h('span', { class: 'tg-pill-t', text: '…' }));
    var right = document.querySelector('#topbar .right');
    if (right) right.insertBefore(els.pill, right.firstChild);
    else { els.pill.style.cssText = 'position:fixed;top:max(8px,env(safe-area-inset-top));right:8px;z-index:2147481000'; document.body.appendChild(els.pill); }
    document.body.appendChild(els.banner); document.body.appendChild(els.live);
    tickTimer = setInterval(tick, 1000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) { tick(); if (S.status === 'authenticated') refreshQuota(); } });
    try { if (window.languageStore && typeof window.languageStore.subscribe === 'function') window.languageStore.subscribe(onLanguageChange); } catch (e) { /* ignore */ }
    loadAssets(); loadSession();
  }

  window.TGAuth = {
    getState: function () { return { status: S.status, user: S.user, quota: S.quota }; }, refreshQuota: refreshQuota, openLogin: function () { openAuth('login'); },
    _sha256: sha256Js, _leadingZeroBits: leadingZeroBits, _solvePow: solvePow, _dict: DICT
  };
  window.TGAssets = { get: function (k) { return S.assets[k] || null; } };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
