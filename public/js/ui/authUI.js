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

  // Bổ sung: quên mật khẩu, đặt mật khẩu mới, tên hiển thị, nút lưới/trục của bộ xem ảnh.
  Object.assign(DICT.vi, {
    'auth.forgot.link': 'Quên mật khẩu?', 'auth.forgot.title': 'Quên mật khẩu',
    'auth.forgot.sub': 'Nhập email của bạn, chúng tôi sẽ gửi liên kết đặt lại mật khẩu.',
    'auth.forgot.submit': 'Gửi liên kết', 'auth.forgot.back': 'Quay lại đăng nhập',
    'auth.forgot.sent': 'Nếu email có tài khoản, một liên kết đặt lại mật khẩu đã được gửi. Hãy kiểm tra hộp thư (kể cả thư rác).',
    'auth.reset.title': 'Đặt mật khẩu mới', 'auth.reset.sub': 'Nhập mật khẩu mới cho tài khoản của bạn.',
    'auth.reset.field': 'Mật khẩu mới', 'auth.reset.submit': 'Lưu mật khẩu',
    'auth.reset.done': 'Đã đổi mật khẩu. Hãy đăng nhập bằng mật khẩu mới.',
    'auth.err.reset_token_invalid': 'Liên kết đặt lại mật khẩu không hợp lệ hoặc đã hết hạn. Hãy yêu cầu liên kết mới.',
    'auth.err.same_password': 'Mật khẩu mới phải khác mật khẩu cũ.', 'auth.err.reset_failed': 'Không đặt lại được mật khẩu. Vui lòng thử lại.',
    'auth.err.forgot_rate_limited': 'Bạn yêu cầu đặt lại mật khẩu quá nhiều lần. Vui lòng thử lại sau ít giờ.',
    'auth.err.invalid_display_name': 'Tên hiển thị cần từ 1 đến 60 ký tự hợp lệ.', 'auth.err.profile_save_failed': 'Không lưu được tên hiển thị. Vui lòng thử lại.',
    'auth.acct.name': 'Tên hiển thị', 'auth.acct.nameSave': 'Lưu tên', 'auth.acct.nameSaved': 'Đã lưu tên hiển thị.',
    'viewer.grid': 'Lưới', 'viewer.axes': 'Trục'
  });
  Object.assign(DICT.en, {
    'auth.forgot.link': 'Forgot password?', 'auth.forgot.title': 'Forgot password',
    'auth.forgot.sub': 'Enter your email and we will send you a password reset link.',
    'auth.forgot.submit': 'Send link', 'auth.forgot.back': 'Back to sign in',
    'auth.forgot.sent': 'If the email has an account, a reset link has been sent. Check your inbox (and spam folder).',
    'auth.reset.title': 'Set a new password', 'auth.reset.sub': 'Enter a new password for your account.',
    'auth.reset.field': 'New password', 'auth.reset.submit': 'Save password',
    'auth.reset.done': 'Password updated. Sign in with your new password.',
    'auth.err.reset_token_invalid': 'The reset link is invalid or has expired. Please request a new one.',
    'auth.err.same_password': 'The new password must be different from the old one.', 'auth.err.reset_failed': 'Could not reset the password. Please try again.',
    'auth.err.forgot_rate_limited': 'Too many reset requests. Please try again in a few hours.',
    'auth.err.invalid_display_name': 'Display name must be 1–60 valid characters.', 'auth.err.profile_save_failed': 'Could not save your display name. Please try again.',
    'auth.acct.name': 'Display name', 'auth.acct.nameSave': 'Save name', 'auth.acct.nameSaved': 'Display name saved.',
    'viewer.grid': 'Grid', 'viewer.axes': 'Axes'
  });

  // ---- Hồ sơ (tab Hồ sơ / Cài đặt / Sử dụng / Bảo mật). Ghi đè 'auth.pill.aria' + 'auth.acct.title' vì pill không còn nói về token. ----
  Object.assign(DICT.vi, {
    'auth.pill.aria': 'Hồ sơ và cài đặt', 'auth.acct.title': 'Hồ sơ và cài đặt',
    'prof.title': 'Hồ sơ và cài đặt', 'prof.title.guest': 'Cài đặt',
    'prof.tab.profile': 'Hồ sơ', 'prof.tab.settings': 'Cài đặt', 'prof.tab.usage': 'Sử dụng', 'prof.tab.security': 'Bảo mật',
    'prof.settings.missing': 'Không tải được phần cài đặt AI. Hãy tải lại trang.',
    'prof.pref.title': 'Giao diện và nhắc nhở',
    'prof.pref.motion': 'Giảm chuyển động', 'prof.pref.motionD': 'Tắt hiệu ứng chuyển động và hoạt ảnh để dễ nhìn hơn.',
    'prof.pref.alert': 'Nhắc khi gần hết hạn mức', 'prof.pref.alertD': 'Hiện thông báo khi bạn đã dùng 80% hạn mức AI.',
    'prof.alert.msg': 'Bạn đã dùng 80% hạn mức AI.', 'prof.alert.view': 'Xem chi tiết',
    'prof.f.bio': 'Giới thiệu', 'prof.f.bioD': 'Tối đa 280 ký tự.', 'prof.f.phone': 'Số điện thoại', 'prof.f.phoneD': 'Không bắt buộc.', 'prof.f.email': 'Email',
    'prof.save': 'Lưu thay đổi', 'prof.saved': 'Đã lưu hồ sơ.', 'prof.nochange': 'Chưa có thay đổi nào để lưu.',
    'prof.usage.usedOf': 'Đã dùng {{used}} / {{limit}} token', 'prof.usage.loading': 'Đang tải…',
    'prof.usage.today': 'Hôm nay', 'prof.usage.week': '7 ngày qua', 'prof.usage.requests': 'Lượt gần đây',
    'prof.usage.chart': '7 ngày gần nhất', 'prof.usage.chartAria': 'Token dùng theo ngày: {{list}}', 'prof.usage.recent': 'Hoạt động gần đây',
    'prof.usage.empty': 'Chưa có lượt dùng nào. Khi bạn hỏi AI, mức dùng sẽ hiện ở đây.', 'prof.usage.refresh': 'Làm mới',
    'prof.usage.note': 'Khi dùng hết, tài khoản tạm khoá một lúc rồi tự mở lại.', 'prof.usage.inout': 'Vào {{i}} · Ra {{o}}',
    'prof.usage.col.time': 'Thời gian', 'prof.usage.col.type': 'Loại', 'prof.usage.col.tokens': 'Token',
    'prof.kind.chat': 'Hỏi đáp', 'prof.kind.vision': 'Đọc ảnh', 'prof.kind.image': 'Ảnh', 'prof.kind.generate': 'Tạo nội dung',
    'prof.sec.pwTitle': 'Đổi mật khẩu', 'prof.sec.current': 'Mật khẩu hiện tại', 'prof.sec.new': 'Mật khẩu mới', 'prof.sec.confirm': 'Nhập lại mật khẩu mới',
    'prof.sec.change': 'Đổi mật khẩu', 'prof.sec.changed': 'Đã đổi mật khẩu.',
    'prof.sec.googleOnly': 'Tài khoản này đăng nhập bằng Google nên chưa có mật khẩu. Muốn đặt mật khẩu, hãy dùng "Quên mật khẩu" ở trang đăng nhập.',
    'prof.sec.sessions': 'Phiên đăng nhập', 'prof.sec.logout': 'Đăng xuất', 'prof.sec.logoutAll': 'Đăng xuất mọi thiết bị',
    'prof.sec.logoutAllConfirm': 'Đăng xuất khỏi tất cả thiết bị? Bạn sẽ cần đăng nhập lại ở mọi nơi.',
    'prof.sec.logoutAllPartial': 'Đã đăng xuất trên thiết bị này. Chưa thu hồi được các thiết bị khác, hãy thử lại.',
    'auth.err.invalid_bio': 'Giới thiệu tối đa 280 ký tự, không chứa ký tự lạ.', 'auth.err.invalid_phone': 'Số điện thoại không hợp lệ.',
    'auth.err.nothing_to_update': 'Không có thông tin nào để lưu.', 'auth.err.invalid_current_password': 'Mật khẩu hiện tại không đúng.',
    'auth.err.no_password_account': 'Tài khoản này đăng nhập bằng Google và chưa có mật khẩu.', 'auth.err.same_password': 'Mật khẩu mới phải khác mật khẩu hiện tại.',
    'auth.err.password_change_failed': 'Không đổi được mật khẩu. Vui lòng thử lại.', 'auth.err.usage_unavailable': 'Không đọc được lịch sử sử dụng. Vui lòng thử lại sau.'
  });
  Object.assign(DICT.en, {
    'auth.pill.aria': 'Profile and settings', 'auth.acct.title': 'Profile and settings',
    'prof.title': 'Profile and settings', 'prof.title.guest': 'Settings',
    'prof.tab.profile': 'Profile', 'prof.tab.settings': 'Settings', 'prof.tab.usage': 'Usage', 'prof.tab.security': 'Security',
    'prof.settings.missing': 'Could not load the AI settings. Please reload the page.',
    'prof.pref.title': 'Appearance and reminders',
    'prof.pref.motion': 'Reduce motion', 'prof.pref.motionD': 'Turn off motion effects and animations to make things easier to see.',
    'prof.pref.alert': 'Warn me near the limit', 'prof.pref.alertD': 'Show a notice when you have used 80% of your AI allowance.',
    'prof.alert.msg': 'You have used 80% of your AI allowance.', 'prof.alert.view': 'View details',
    'prof.f.bio': 'About you', 'prof.f.bioD': 'Up to 280 characters.', 'prof.f.phone': 'Phone number', 'prof.f.phoneD': 'Optional.', 'prof.f.email': 'Email',
    'prof.save': 'Save changes', 'prof.saved': 'Profile saved.', 'prof.nochange': 'Nothing to save yet.',
    'prof.usage.usedOf': 'Used {{used}} / {{limit}} tokens', 'prof.usage.loading': 'Loading…',
    'prof.usage.today': 'Today', 'prof.usage.week': 'Last 7 days', 'prof.usage.requests': 'Recent requests',
    'prof.usage.chart': 'Last 7 days', 'prof.usage.chartAria': 'Tokens used per day: {{list}}', 'prof.usage.recent': 'Recent activity',
    'prof.usage.empty': 'No usage yet. When you ask the AI, your usage will show up here.', 'prof.usage.refresh': 'Refresh',
    'prof.usage.note': 'When the allowance runs out, the account pauses for a while and then reopens automatically.', 'prof.usage.inout': 'In {{i}} · Out {{o}}',
    'prof.usage.col.time': 'Time', 'prof.usage.col.type': 'Type', 'prof.usage.col.tokens': 'Tokens',
    'prof.kind.chat': 'Chat', 'prof.kind.vision': 'Image reading', 'prof.kind.image': 'Image', 'prof.kind.generate': 'Generation',
    'prof.sec.pwTitle': 'Change password', 'prof.sec.current': 'Current password', 'prof.sec.new': 'New password', 'prof.sec.confirm': 'Repeat new password',
    'prof.sec.change': 'Change password', 'prof.sec.changed': 'Password changed.',
    'prof.sec.googleOnly': 'This account signs in with Google, so it has no password yet. To set one, use "Forgot password" on the sign-in page.',
    'prof.sec.sessions': 'Sessions', 'prof.sec.logout': 'Sign out', 'prof.sec.logoutAll': 'Sign out of all devices',
    'prof.sec.logoutAllConfirm': 'Sign out of every device? You will need to sign in again everywhere.',
    'prof.sec.logoutAllPartial': 'Signed out on this device. Other devices could not be revoked, please try again.',
    'auth.err.invalid_bio': 'About you can be up to 280 characters, with no unusual characters.', 'auth.err.invalid_phone': 'Invalid phone number.',
    'auth.err.nothing_to_update': 'There is nothing to save.', 'auth.err.invalid_current_password': 'The current password is incorrect.',
    'auth.err.no_password_account': 'This account signs in with Google and has no password.', 'auth.err.same_password': 'The new password must be different from the current one.',
    'auth.err.password_change_failed': 'Could not change the password. Please try again.', 'auth.err.usage_unavailable': 'Could not load your usage history. Please try again later.'
  });

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
    '@media (prefers-reduced-motion:reduce){.tg-bar>i{transition:none}}',
    // ---- Hồ sơ: tab Hồ sơ / Cài đặt / Sử dụng / Bảo mật ----
    '.tg-pill[data-initial]>span[aria-hidden]{display:none}',
    '.tg-pill[data-initial]::before{content:attr(data-initial);display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:var(--tg-primary);color:var(--tg-primary-fg);font:700 13px/1 Inter,system-ui,sans-serif}',
    '.tg-prof{width:min(580px,100%);padding:18px 18px 14px}',
    '.tg-prof-head{display:flex;align-items:center;gap:12px;margin:0 48px 10px 0;min-height:44px}',
    '.tg-av{flex:none;display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:50%;background:var(--tg-primary);color:var(--tg-primary-fg);font-weight:700;font-size:18px}',
    '.tg-who{min-width:0}.tg-who h2{margin:0;font-size:18px;line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.tg-tabs{display:flex;gap:2px;border-bottom:1px solid var(--tg-line);margin:0 0 14px;overflow-x:auto}',
    '.tg-tab{flex:none;min-height:44px;padding:0 14px;border:0;border-bottom:2px solid transparent;background:none;color:var(--tg-muted);font:600 14px/1 Inter,system-ui,sans-serif;cursor:pointer}',
    '.tg-tab[aria-selected="true"]{color:var(--tg-fg);border-bottom-color:var(--tg-primary)}',
    '.tg-tab:focus-visible,.tg-pill:focus-visible,.tg-sw-in:focus-visible+.tg-sw-k{outline:2px solid var(--tg-primary);outline-offset:2px}',
    '.tg-panel[hidden]{display:none}.tg-panel:focus{outline:none}',
    '.tg-f{margin:0 0 12px}.tg-f label{display:block;margin:0 0 4px;font-size:13px;font-weight:600}.tg-f small{display:block;margin-top:4px;color:var(--tg-muted);font-size:12px}',
    '.tg-ta{min-height:84px;padding:10px 12px;resize:vertical;line-height:1.4}',
    '.tg-count{float:right}',
    '.tg-in[readonly]{opacity:.7}',
    '.tg-set{margin:0 0 14px;padding-bottom:6px}.tg-set h3,.tg-use h3,.tg-sec h3{margin:0 0 8px;font-size:14px}',
    '.tg-sw{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:48px;padding:6px 0;cursor:pointer}',
    '.tg-sw-t{display:flex;flex-direction:column;gap:2px}.tg-sw-t small{color:var(--tg-muted);font-size:12px}',
    '.tg-sw-in{position:absolute;opacity:0;width:1px;height:1px}',
    '.tg-sw-k{flex:none;position:relative;width:44px;height:26px;border-radius:99px;background:var(--tg-line);transition:background .2s}',
    '.tg-sw-k::after{content:"";position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:transform .2s}',
    '.tg-sw-in:checked+.tg-sw-k{background:var(--tg-primary)}.tg-sw-in:checked+.tg-sw-k::after{transform:translateX(18px)}',
    '.tg-panel .set-section{padding-left:0;padding-right:0}',
    '.tg-use-top{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap}.tg-use-n{font-size:20px}.tg-use-pct{font-weight:700;color:var(--tg-muted)}',
    '.tg-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:12px 0}',
    '.tg-stat{padding:10px;border:1px solid var(--tg-line);border-radius:12px}.tg-stat b{display:block;font-size:18px}.tg-stat span{color:var(--tg-muted);font-size:12px}',
    '.tg-chart{display:flex;align-items:flex-end;gap:6px;height:128px;margin:6px 0 14px}',
    '.tg-col{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;height:100%;min-width:0}',
    '.tg-cv{font-size:11px;color:var(--tg-muted);height:14px}.tg-cl{font-size:11px;color:var(--tg-muted)}',
    '.tg-cb{flex:1;width:100%;display:flex;align-items:flex-end;border-radius:6px 6px 0 0}.tg-cb>i{display:block;width:100%;border-radius:6px 6px 0 0;background:var(--tg-primary);min-height:2px;transition:height .3s}',
    '.tg-tbl{width:100%;border-collapse:collapse;font-size:13px}.tg-tbl th,.tg-tbl td{padding:8px 6px;text-align:left;border-bottom:1px solid var(--tg-line)}.tg-tbl th{color:var(--tg-muted);font-weight:600}.tg-tbl td.num,.tg-tbl th.num{text-align:right;font-variant-numeric:tabular-nums}',
    '.tg-tblwrap{overflow-x:auto}',
    '.tg-sec section{margin:0 0 18px}',
    '.tg-toast{position:fixed;left:50%;bottom:max(16px,env(safe-area-inset-bottom));transform:translateX(-50%);z-index:2147482000;display:flex;align-items:center;gap:12px;max-width:min(92vw,460px);padding:12px 14px;border-radius:12px;background:var(--tg-warn-bg);color:var(--tg-warn-fg);box-shadow:var(--tg-shadow);font-size:14px}',
    '.tg-toast[hidden]{display:none}.tg-toast button{flex:none;min-height:36px;padding:0 12px;border:1px solid currentColor;border-radius:8px;background:transparent;color:inherit;font:600 13px/1 Inter,system-ui,sans-serif;cursor:pointer}',
    'html.tg-reduce-motion *,html.tg-reduce-motion *::before,html.tg-reduce-motion *::after{animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important;scroll-behavior:auto!important}',
    '@media (max-width:480px){.tg-stats{grid-template-columns:1fr 1fr 1fr}.tg-prof{padding:16px 14px 12px}}',
    '@media (prefers-reduced-motion:reduce){.tg-sw-k,.tg-sw-k::after,.tg-cb>i{transition:none}}'
  ].join('\n');

  // ---------------------------------------------------------------- state / render
  function setStatus(status, user) {
    S.status = status; S.user = user || null;
    renderPill(); renderAccount(true);
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
    els.pill.removeAttribute('data-initial');
    if (S.status === 'disabled' || S.status === 'unconfigured') { els.pill.hidden = S.status === 'disabled'; t.textContent = tx('auth.pill.unconfigured'); els.pill.dataset.state = 'warn'; return; }
    els.pill.hidden = false;
    if (S.status === 'loading') { t.textContent = '…'; els.pill.dataset.state = ''; return; }
    if (S.status === 'unavailable') { t.textContent = tx('auth.pill.offline'); els.pill.dataset.state = 'warn'; return; }
    if (S.status !== 'authenticated') { t.textContent = tx('auth.pill.login'); els.pill.dataset.state = ''; els.pill.setAttribute('aria-label', tx('auth.pill.ariaLogin')); return; }
    var qs = quotaSummary();
    var cd = S.cooldownEndsAt > Date.now();
    els.pill.dataset.state = cd ? 'cooldown' : '';
    if (cd) t.textContent = tx('auth.pill.wait', { time: mmss((S.cooldownEndsAt - Date.now()) / 1000) });
    // SỐ TOKEN KHÔNG hiện ở đây nữa: chỉ xem được trong Hồ sơ -> Sử dụng (và banner khi bị khoá tạm thời).
    else t.textContent = displayLabel();
    els.pill.setAttribute('data-initial', initialOf());
    els.pill.setAttribute('aria-label', tx('auth.pill.aria'));
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

  // Cập nhật hộp thoại Hồ sơ. full=true: dựng lại tab + panel (mở hộp thoại, đổi trạng thái đăng nhập). full=false (mỗi lần quota
  // thay đổi): CHỈ cập nhật số liệu tại chỗ ở tab Sử dụng — không xóa chữ người dùng đang gõ ở tab khác.
  function renderAccount(full) {
    if (!els.account || els.account.hidden) return;
    renderProfHead();
    if (S.status !== 'authenticated' && prof.tab !== 'settings') prof.tab = 'settings';
    if (full === true) { renderTabs(); showPanel(); return; }
    if (prof.tab === 'usage') updateUsageSummary();
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
    renderPill(); renderBanner(); renderAccount(); checkQuotaAlert(q);
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
    var forgotLink = h('button', { class: 'tg-btn', type: 'button', style: 'min-height:40px;margin:-4px 0 12px;padding:0 4px;border:0;background:transparent;color:var(--tg-primary);text-decoration:underline', onclick: function () { switchMode('forgot'); }, text: tx('auth.forgot.link') });
    var backLink = h('button', { class: 'tg-btn', type: 'button', hidden: true, style: 'min-height:40px;margin:8px 0 0;padding:0 4px;border:0;background:transparent;color:var(--tg-primary);text-decoration:underline', onclick: function () { switchMode('login'); }, text: tx('auth.forgot.back') });
    var pwWrap = h('label', { class: 'tg-field' }, h('span', { text: tx('auth.field.password') }), h('div', { class: 'tg-row' }, pw, show));
    var rememberWrap = h('label', { class: 'tg-check' }, remember, h('span', { text: tx('auth.remember') }));
    var form = h('form', { novalidate: true, onsubmit: onSubmit },
      h('label', { class: 'tg-field' }, h('span', { text: tx('auth.field.email') }), email),
      pwWrap,
      confirmWrap,
      forgotLink,
      rememberWrap,
      msg, submit, backLink);
    var tabs = h('div', { class: 'tg-tabs', role: 'tablist' }, tabLogin, tabReg);
    var card = h('div', { class: 'tg-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tgAuthTitle' }, close, img, title, sub, tabs, form);
    var ov = h('div', { class: 'tg-overlay', hidden: true, onmousedown: function (e) { if (e.target === ov) closeAuth(); }, onkeydown: trapKeys }, card);
    els.auth = ov; els.authEls = { title: title, sub: sub, tabs: tabs, tabLogin: tabLogin, tabReg: tabReg, email: email, pw: pw, pw2: pw2, pwWrap: pwWrap, confirmWrap: confirmWrap, rememberWrap: rememberWrap, remember: remember, forgotLink: forgotLink, backLink: backLink, msg: msg, submit: submit, img: img };
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
  function submitLabel() { return tx(authMode === 'register' ? 'auth.submit.register' : (authMode === 'forgot' ? 'auth.forgot.submit' : 'auth.submit.login')); }
  function switchMode(mode) {
    authMode = mode;
    var E = els.authEls, reg = mode === 'register', forgot = mode === 'forgot';
    E.tabLogin.setAttribute('aria-selected', String(mode === 'login')); E.tabReg.setAttribute('aria-selected', String(reg));
    E.tabs.hidden = forgot; E.pwWrap.hidden = forgot; E.rememberWrap.hidden = forgot; E.forgotLink.hidden = mode !== 'login'; E.backLink.hidden = !forgot;
    E.confirmWrap.hidden = !reg; E.pw.autocomplete = reg ? 'new-password' : 'current-password';
    E.title.textContent = tx(forgot ? 'auth.forgot.title' : (reg ? 'auth.title.register' : 'auth.title.login'));
    E.sub.textContent = tx(forgot ? 'auth.forgot.sub' : 'auth.sub');
    E.submit.textContent = submitLabel();
    E.msg.textContent = ''; E.msg.className = 'tg-msg';
  }
  function setMsg(text, kind) { els.authEls.msg.textContent = text || ''; els.authEls.msg.className = 'tg-msg' + (kind ? ' ' + kind : ''); }
  function openAuth(mode, message) {
    // Đăng nhập/đăng ký/quên mật khẩu chạy ở trang /auth (Cloudflare Turnstile + Google + PoW). Hộp thoại cũ bên dưới (buildAuth
    // /switchMode/submit) KHÔNG còn được gọi: nó không gửi token captcha nên sẽ bị server từ chối khi đã bật Turnstile.
    var m = mode === 'signup' || mode === 'forgot' ? mode : 'login';
    location.assign('/auth?mode=' + m + '&next=' + encodeURIComponent('/index.html'));
  }
  function openAuthLegacyModal(mode, message) {
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
    E.submit.disabled = b; E.submit.textContent = b ? (label || tx('auth.busy')) : submitLabel();
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
    if (authMode === 'forgot') {
      setBusy(true, tx('auth.pow.working')); setMsg('');
      getPowSolution()
        .then(function (pow) { setBusy(true); return api('POST', '/api/auth/forgot', { email: email, challenge: pow.challenge, nonce: pow.nonce }); })
        .then(function (r) {
          setBusy(false);
          if (!r.ok) { setMsg(errText(r.json), 'err'); return; }
          setMsg(tx('auth.forgot.sent'), 'ok');
        })
        .catch(function (err) { setBusy(false); setMsg(err && err.json ? errText(err.json) : tx('auth.err.network'), 'err'); });
      return;
    }
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

  // ---------------------------------------------------------------- Hồ sơ: Hồ sơ · Cài đặt · Sử dụng · Bảo mật
  // SỐ TOKEN chỉ hiện ở tab "Sử dụng". Cài đặt AI cũ (#settingsModal trong index.html) được CHUYỂN NGUYÊN DOM vào tab "Cài đặt"
  // (giữ nguyên id + listener do app.js gắn) — không nhân đôi logic cài đặt.
  var PROF_TABS = ['profile', 'settings', 'usage', 'security'];
  var prof = { tab: 'profile', usage: { state: 'idle', items: [], error: '' }, usageNodes: null, alerted: false, toastTimer: 0 };
  var PREF_KEY = 'tg_prefs_v1';
  function readPrefs() { try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch (e) { return {}; } }
  function writePref(k, v) { try { var p = readPrefs(); p[k] = v; localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch (e) { /* trình duyệt chặn storage: bỏ qua */ } }
  function applyPrefs() { document.documentElement.classList.toggle('tg-reduce-motion', readPrefs().reduceMotion === true); }

  function displayLabel() { var u = S.user || {}; return u.displayName || (u.email ? u.email.split('@')[0] : '') || tx('auth.pill.account'); }
  function initialOf() { var a = Array.from(displayLabel()); return a.length ? a[0].toUpperCase() : '?'; }
  function pm(el, kind, text) { el.textContent = text || ''; el.className = 'tg-msg' + (kind ? ' ' + kind : ''); }
  function tgField(id, labelKey, control, hintKey) { return h('div', { class: 'tg-f' }, h('label', { for: id, text: tx(labelKey) }), control, hintKey ? h('small', { text: tx(hintKey) }) : null); }

  function showToast(msg, actionLabel, fn) {
    if (!els.toast) { els.toast = h('div', { class: 'tg-toast', role: 'status', hidden: true }); document.body.appendChild(els.toast); }
    els.toast.textContent = '';
    els.toast.appendChild(h('span', { text: msg }));
    if (actionLabel) els.toast.appendChild(h('button', { type: 'button', text: actionLabel, onclick: function () { els.toast.hidden = true; fn && fn(); } }));
    els.toast.hidden = false;
    clearTimeout(prof.toastTimer); prof.toastTimer = setTimeout(function () { els.toast.hidden = true; }, 9000);
  }
  // Nhắc 1 lần khi dùng ≥ 80% hạn mức (tuỳ chọn trong Cài đặt). ≥ 100% đã có banner khoá tạm thời nên không nhắc thêm.
  function checkQuotaAlert(q) {
    if (!q || q.status === 'disabled' || readPrefs().quotaAlert === false) return;
    var qs = quotaSummary();
    if (!qs || !qs.limit) return;
    var pct = (qs.used + qs.reserved) / qs.limit * 100;
    if (pct < 80) { prof.alerted = false; return; }
    if (prof.alerted || pct >= 100) return;
    prof.alerted = true;
    showToast(tx('prof.alert.msg'), tx('prof.alert.view'), function () { openAccount('usage'); });
  }

  // ---- cài đặt: chuyển DOM #settingsModal -> tab Cài đặt (và trả về khi gỡ hộp thoại) ----
  function settingSections() {
    var modal = document.getElementById('settingsModal');
    return modal ? Array.prototype.filter.call(modal.children, function (c) { return c.classList && c.classList.contains('set-section'); }) : [];
  }
  function mountSettings(panel) {
    panel.appendChild(buildPrefsSection());
    var secs = settingSections();
    if (!secs.length) panel.appendChild(h('p', { class: 'tg-sub', text: tx('prof.settings.missing') }));
    secs.forEach(function (s) { panel.appendChild(s); });
  }
  function unmountSettings() {
    var modal = document.getElementById('settingsModal');
    var panel = els.profPanels && els.profPanels.settings;
    if (!modal || !panel) return;
    Array.prototype.filter.call(panel.children, function (c) { return c.classList && c.classList.contains('set-section'); }).forEach(function (s) { modal.appendChild(s); });
  }
  function buildPrefsSection() {
    var prefs = readPrefs();
    function sw(id, labelKey, descKey, checked, onchange) {
      var inp = h('input', { type: 'checkbox', id: id, class: 'tg-sw-in', onchange: function () { onchange(inp.checked); } });
      inp.checked = !!checked;
      return h('label', { class: 'tg-sw', for: id }, h('span', { class: 'tg-sw-t' }, h('b', { text: tx(labelKey) }), h('small', { text: tx(descKey) })), inp, h('span', { class: 'tg-sw-k', 'aria-hidden': 'true' }));
    }
    return h('section', { class: 'tg-set' },
      h('h3', { text: tx('prof.pref.title') }),
      sw('tgPrefMotion', 'prof.pref.motion', 'prof.pref.motionD', prefs.reduceMotion === true, function (v) { writePref('reduceMotion', v); applyPrefs(); }),
      sw('tgPrefAlert', 'prof.pref.alert', 'prof.pref.alertD', prefs.quotaAlert !== false, function (v) { writePref('quotaAlert', v); if (v) prof.alerted = false; })
    );
  }
  // Nút Cài đặt cũ (thanh bên + thanh trên) mở Hồ sơ -> Cài đặt. app.js còn gọi trực tiếp openSettings() (vd. puterAuthUI) nên
  // theo dõi lớp .show của #settingsOverlay: vừa hiện => đóng bằng closeSettings() của app rồi mở tab Cài đặt.
  function installSettingsRedirect() {
    document.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('#settingsBtnTop,#settingsBtnSide') : null;
      if (!b) return;
      e.preventDefault(); e.stopPropagation();
      openAccount('settings');
    }, true);
    var so = document.getElementById('settingsOverlay');
    if (so && window.MutationObserver) {
      new MutationObserver(function () {
        if (!so.classList.contains('show')) return;
        try { if (typeof window.closeSettings === 'function') window.closeSettings(); } catch (e) { /* ignore */ }
        so.classList.remove('show');
        openAccount('settings');
      }).observe(so, { attributes: true, attributeFilter: ['class'] });
    }
  }

  // ---- khung hộp thoại + tab ----
  function buildAccount() {
    var close = h('button', { class: 'tg-x', type: 'button', 'aria-label': tx('auth.close'), onclick: closeAccount, text: '✕' });
    els.profHead = h('div', { class: 'tg-prof-head' });
    els.profTabs = h('div', { class: 'tg-tabs', role: 'tablist', 'aria-label': tx('prof.title'), onkeydown: onTabKey });
    els.profPanels = {};
    var panels = h('div', { class: 'tg-panels' });
    PROF_TABS.forEach(function (k) {
      var p = h('div', { class: 'tg-panel', role: 'tabpanel', id: 'tgPanel-' + k, 'aria-labelledby': 'tgTab-' + k, hidden: true, tabindex: '-1' });
      els.profPanels[k] = p; panels.appendChild(p);
    });
    var card = h('div', { class: 'tg-card tg-prof', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tgAcctTitle' }, close, els.profHead, els.profTabs, panels);
    var ov = h('div', { class: 'tg-overlay', hidden: true, onmousedown: function (e) { if (e.target === ov) closeAccount(); }, onkeydown: trapKeys }, card);
    els.account = ov; document.body.appendChild(ov);
    mountSettings(els.profPanels.settings);
  }
  function renderProfHead() {
    var head = els.profHead; if (!head) return;
    head.textContent = '';
    if (S.status === 'authenticated') {
      var u = S.user || {};
      head.appendChild(h('span', { class: 'tg-av', 'aria-hidden': 'true', text: initialOf() }));
      head.appendChild(h('div', { class: 'tg-who' }, h('h2', { id: 'tgAcctTitle', text: displayLabel() }), h('div', { class: 'tg-sub', text: (u.email || '') + (u.role === 'admin' ? tx('auth.acct.admin') : '') })));
    } else {
      head.appendChild(h('div', { class: 'tg-who' }, h('h2', { id: 'tgAcctTitle', text: tx('prof.title.guest') }),
        S.status === 'unauthenticated' ? h('button', { class: 'tg-btn', type: 'button', style: 'margin-top:8px', text: tx('auth.pill.login'), onclick: function () { closeAccount(); openAuth('login'); } }) : null));
    }
  }
  function renderTabs() {
    var tabs = els.profTabs; if (!tabs) return;
    tabs.textContent = '';
    var list = S.status === 'authenticated' ? PROF_TABS : ['settings'];
    tabs.hidden = list.length < 2;
    list.forEach(function (k) {
      var sel = prof.tab === k;
      tabs.appendChild(h('button', { class: 'tg-tab', type: 'button', role: 'tab', id: 'tgTab-' + k, 'aria-selected': sel ? 'true' : 'false', 'aria-controls': 'tgPanel-' + k, tabindex: sel ? '0' : '-1', 'data-k': k, onclick: function () { selectTab(k); }, text: tx('prof.tab.' + k) }));
    });
  }
  function showPanel() {
    PROF_TABS.forEach(function (k) { els.profPanels[k].hidden = k !== prof.tab; });
    if (prof.tab === 'profile') renderProfilePanel();
    else if (prof.tab === 'usage') { renderUsagePanel(); loadUsage(); }
    else if (prof.tab === 'security') renderSecurityPanel();
  }
  function selectTab(k) {
    prof.tab = k; renderTabs(); showPanel();
    var b = els.profTabs.querySelector('[aria-selected="true"]'); if (b) b.focus();
  }
  function onTabKey(e) {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].indexOf(e.key) < 0) return;
    var btns = Array.prototype.slice.call(els.profTabs.querySelectorAll('[role="tab"]'));
    var i = btns.indexOf(document.activeElement); if (i < 0) return;
    e.preventDefault();
    var n = e.key === 'Home' ? 0 : e.key === 'End' ? btns.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + btns.length) % btns.length;
    selectTab(btns[n].getAttribute('data-k'));
  }

  // ---- tab Hồ sơ ----
  function renderProfilePanel() {
    var p = els.profPanels.profile; p.textContent = '';
    var u = S.user || {};
    var name = h('input', { class: 'tg-in', id: 'tgfName', type: 'text', maxlength: '60', autocomplete: 'name', value: u.displayName || '' });
    var bio = h('textarea', { class: 'tg-in tg-ta', id: 'tgfBio', maxlength: '280', rows: '3', text: u.bio || '' });
    var cnt = h('small', { class: 'tg-count', 'aria-hidden': 'true', text: bio.value.length + '/280' });
    bio.addEventListener('input', function () { cnt.textContent = bio.value.length + '/280'; });
    var phone = h('input', { class: 'tg-in', id: 'tgfPhone', type: 'tel', maxlength: '20', autocomplete: 'tel', inputmode: 'tel', value: u.phone || '' });
    var email = h('input', { class: 'tg-in', id: 'tgfEmail', type: 'email', readonly: true, value: u.email || '' });
    var msg = h('div', { class: 'tg-msg', role: 'status', 'aria-live': 'polite' });
    var save = h('button', { class: 'tg-btn primary', type: 'button', text: tx('prof.save'), onclick: function () {
      var patch = {};
      var n = name.value.trim(); if (n !== (u.displayName || '')) patch.displayName = n;
      var b = bio.value.trim(); if (b !== (u.bio || '')) patch.bio = b;
      var ph = phone.value.trim(); if (ph !== (u.phone || '')) patch.phone = ph;
      if (!Object.keys(patch).length) { pm(msg, '', tx('prof.nochange')); return; }
      if ('displayName' in patch && !n) { pm(msg, 'err', tx('auth.err.invalid_display_name')); name.focus(); return; }
      save.disabled = true;
      api('PATCH', '/api/auth/profile', patch).then(function (r) {
        save.disabled = false;
        if (r.status === 401) { handleUnauthorized(r.json); return; }
        if (!r.ok) { pm(msg, 'err', errText(r.json)); return; }
        if (S.user) { S.user.displayName = r.json.displayName; S.user.bio = r.json.bio; S.user.phone = r.json.phone; u = S.user; }
        renderPill(); renderProfHead(); pm(msg, 'ok', tx('prof.saved'));
      }).catch(function () { save.disabled = false; pm(msg, 'err', tx('auth.err.network')); });
    } });
    p.appendChild(tgField('tgfName', 'auth.acct.name', name));
    p.appendChild(tgField('tgfBio', 'prof.f.bio', h('div', null, bio, cnt), 'prof.f.bioD'));
    p.appendChild(tgField('tgfPhone', 'prof.f.phone', phone, 'prof.f.phoneD'));
    p.appendChild(tgField('tgfEmail', 'prof.f.email', email));
    p.appendChild(msg); p.appendChild(save);
    if (u.role === 'admin') p.appendChild(h('div', { class: 'tg-row', style: 'margin-top:12px' }, h('button', { class: 'tg-btn', type: 'button', onclick: openAssets, text: tx('auth.acct.assets') })));
  }

  // ---- tab Sử dụng ----
  function pfCompact(n) { n = Number(n) || 0; return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k' : String(n); }
  function pfDayKey(d) { return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
  function renderUsagePanel() {
    var p = els.profPanels.usage; p.textContent = '';
    var n = prof.usageNodes = {};
    n.used = h('b', { class: 'tg-use-n' }); n.pct = h('span', { class: 'tg-use-pct' });
    n.fill = h('i');
    n.bar = h('div', { class: 'tg-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-label': tx('auth.acct.barLabel') }, n.fill);
    n.sub = h('div', { class: 'tg-sub' });
    n.cd = h('p', { class: 'tg-msg err', hidden: true }, tx('auth.cooldown.before'), h('b', { id: 'tgAcctTime', 'aria-hidden': 'true', text: '00:00' }), tx('auth.cooldown.after'));
    n.stats = h('div', { class: 'tg-stats' });
    n.chart = h('div', { class: 'tg-chart', role: 'img' });
    n.list = h('div');
    var refresh = h('button', { class: 'tg-btn', type: 'button', text: tx('prof.usage.refresh'), onclick: function () { refreshQuota(); loadUsage(); } });
    p.appendChild(h('section', { class: 'tg-use' },
      h('div', { class: 'tg-use-top' }, n.used, n.pct), n.bar, n.sub, n.cd,
      n.stats,
      h('h3', { text: tx('prof.usage.chart') }), n.chart,
      h('h3', { text: tx('prof.usage.recent') }), n.list,
      h('p', { class: 'tg-sub', text: tx('prof.usage.note') }),
      refresh));
    updateUsageSummary(); renderUsageHistory();
  }
  function updateUsageSummary() {
    var n = prof.usageNodes; if (!n) return;
    var qs = quotaSummary();
    if (!qs) { n.used.textContent = '…'; n.pct.textContent = ''; n.sub.textContent = tx('prof.usage.loading'); return; }
    var spent = qs.used + qs.reserved;
    var pct = qs.limit ? Math.min(100, Math.round(spent / qs.limit * 100)) : 0;
    var cd = S.cooldownEndsAt > Date.now();
    n.used.textContent = tx('prof.usage.usedOf', { used: fmtInt(qs.used), limit: fmtInt(qs.limit) });
    n.pct.textContent = pct + '%';
    n.fill.style.width = pct + '%';
    n.bar.setAttribute('aria-valuemax', String(qs.limit)); n.bar.setAttribute('aria-valuenow', String(qs.used));
    n.bar.setAttribute('data-hot', pct >= 80 ? '1' : ''); n.bar.setAttribute('data-full', pct >= 100 ? '1' : '');
    n.sub.textContent = cd ? tx('auth.acct.locked') : tx('auth.acct.remaining', { n: fmtInt(Math.max(0, qs.limit - spent)) });
    n.cd.hidden = !cd;
    if (cd) { var t = document.getElementById('tgAcctTime'); if (t) t.textContent = mmss((S.cooldownEndsAt - Date.now()) / 1000); }
  }
  function loadUsage() {
    if (S.status !== 'authenticated') return;
    prof.usage.state = 'loading'; renderUsageHistory();
    api('GET', '/api/auth/usage').then(function (r) {
      if (r.status === 401) { handleUnauthorized(r.json); return; }
      if (!r.ok) { prof.usage.state = 'error'; prof.usage.error = errText(r.json); }
      else { prof.usage.state = 'ready'; prof.usage.items = Array.isArray(r.json.items) ? r.json.items : []; }
      renderUsageHistory();
    }).catch(function () { prof.usage.state = 'error'; prof.usage.error = tx('auth.err.network'); renderUsageHistory(); });
  }
  function renderUsageHistory() {
    var n = prof.usageNodes; if (!n) return;
    var u = prof.usage;
    n.stats.textContent = ''; n.chart.textContent = ''; n.list.textContent = '';
    if (u.state === 'loading' && !u.items.length) { n.list.appendChild(h('p', { class: 'tg-sub', text: tx('prof.usage.loading') })); return; }
    if (u.state === 'error') { n.list.appendChild(h('p', { class: 'tg-msg err', text: u.error })); return; }
    var items = u.items;
    var now = new Date(), days = [], map = {};
    for (var i = 6; i >= 0; i--) { var d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i); var o = { d: d, total: 0 }; days.push(o); map[pfDayKey(d)] = o; }
    var week = 0;
    items.forEach(function (it) {
      var t = new Date(it.at); if (isNaN(t)) return;
      var o = map[pfDayKey(t)]; var v = Number(it.total) || 0;
      if (o) { o.total += v; week += v; }
    });
    [[days[6].total, 'prof.usage.today'], [week, 'prof.usage.week'], [items.length, 'prof.usage.requests']].forEach(function (s) {
      n.stats.appendChild(h('div', { class: 'tg-stat' }, h('b', { text: fmtInt(s[0]) }), h('span', { text: tx(s[1]) })));
    });
    var max = Math.max.apply(null, days.map(function (o) { return o.total; }).concat(1));
    var labels = [];
    days.forEach(function (o) {
      var wd = o.d.toLocaleDateString(numLocale(), { weekday: 'short' });
      var bar = h('i'); bar.style.height = Math.max(o.total ? 6 : 2, Math.round(o.total / max * 100)) + '%';
      n.chart.appendChild(h('div', { class: 'tg-col', 'aria-hidden': 'true' }, h('span', { class: 'tg-cv', text: o.total ? pfCompact(o.total) : '' }), h('span', { class: 'tg-cb' }, bar), h('span', { class: 'tg-cl', text: wd })));
      labels.push(wd + ' ' + fmtInt(o.total));
    });
    n.chart.setAttribute('aria-label', tx('prof.usage.chartAria', { list: labels.join(', ') }));
    if (!items.length) { n.list.appendChild(h('p', { class: 'tg-sub', text: tx('prof.usage.empty') })); return; }
    var tbody = h('tbody');
    items.slice(0, 10).forEach(function (it) {
      var t = new Date(it.at);
      var kindKey = 'prof.kind.' + it.kind; var kind = tx(kindKey); if (kind === kindKey) kind = it.kind || '—';
      tbody.appendChild(h('tr', null,
        h('td', { text: isNaN(t) ? '' : t.toLocaleString(numLocale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) }),
        h('td', { text: kind }),
        h('td', { class: 'num', title: tx('prof.usage.inout', { i: fmtInt(it.input), o: fmtInt(it.output) }), text: fmtInt(it.total) })));
    });
    n.list.appendChild(h('div', { class: 'tg-tblwrap' }, h('table', { class: 'tg-tbl' },
      h('thead', null, h('tr', null, h('th', { scope: 'col', text: tx('prof.usage.col.time') }), h('th', { scope: 'col', text: tx('prof.usage.col.type') }), h('th', { scope: 'col', class: 'num', text: tx('prof.usage.col.tokens') }))), tbody)));
  }

  // ---- tab Bảo mật ----
  function renderSecurityPanel() {
    var p = els.profPanels.security; p.textContent = '';
    var u = S.user || {};
    var hasPw = !Array.isArray(u.providers) || u.providers.indexOf('email') >= 0;
    var pw = h('section', null, h('h3', { text: tx('prof.sec.pwTitle') }));
    if (!hasPw) pw.appendChild(h('p', { class: 'tg-sub', text: tx('prof.sec.googleOnly') }));
    else {
      var cur = h('input', { class: 'tg-in', id: 'tgpCur', type: 'password', autocomplete: 'current-password', maxlength: '128' });
      var nw = h('input', { class: 'tg-in', id: 'tgpNew', type: 'password', autocomplete: 'new-password', maxlength: '128' });
      var cf = h('input', { class: 'tg-in', id: 'tgpCf', type: 'password', autocomplete: 'new-password', maxlength: '128' });
      var msg = h('div', { class: 'tg-msg', role: 'status', 'aria-live': 'polite' });
      var btn = h('button', { class: 'tg-btn primary', type: 'button', text: tx('prof.sec.change'), onclick: function () {
        if (!cur.value) { pm(msg, 'err', tx('auth.err.invalid_current_password')); cur.focus(); return; }
        if (nw.value !== cf.value) { pm(msg, 'err', tx('auth.err.password_mismatch')); cf.focus(); return; }
        btn.disabled = true;
        api('POST', '/api/auth/password', { currentPassword: cur.value, newPassword: nw.value, confirmPassword: cf.value }).then(function (r) {
          btn.disabled = false;
          if (r.status === 401) { handleUnauthorized(r.json); return; }
          if (!r.ok) { pm(msg, 'err', errText(r.json)); return; }
          cur.value = ''; nw.value = ''; cf.value = ''; pm(msg, 'ok', tx('prof.sec.changed'));
        }).catch(function () { btn.disabled = false; pm(msg, 'err', tx('auth.err.network')); });
      } });
      cf.addEventListener('keydown', function (e) { if (e.key === 'Enter') btn.click(); });
      pw.appendChild(tgField('tgpCur', 'prof.sec.current', cur));
      pw.appendChild(tgField('tgpNew', 'prof.sec.new', nw, 'auth.err.weak_password'));
      pw.appendChild(tgField('tgpCf', 'prof.sec.confirm', cf));
      pw.appendChild(msg); pw.appendChild(btn);
    }
    var sess = h('section', null, h('h3', { text: tx('prof.sec.sessions') }),
      h('div', { class: 'tg-row', style: 'flex-wrap:wrap' },
        h('button', { class: 'tg-btn danger', type: 'button', text: tx('prof.sec.logout'), onclick: doLogout }),
        h('button', { class: 'tg-btn danger', type: 'button', text: tx('prof.sec.logoutAll'), onclick: doLogoutAll })));
    p.appendChild(h('div', { class: 'tg-sec' }, pw, sess));
  }
  function doLogoutAll() {
    if (!window.confirm(tx('prof.sec.logoutAllConfirm'))) return;
    api('POST', '/api/auth/logout-all', {}).then(function (r) {
      if (r.status === 401) { handleUnauthorized(r.json); return; }
      var partial = r.ok && r.json && r.json.revoked === false;
      closeAccount(); setStatus('unauthenticated', null);
      if (partial) announce(tx('prof.sec.logoutAllPartial'));
    }).catch(function () { announce(tx('auth.err.network')); });
  }

  // ---- mở/đóng ----
  // tab: 'profile' | 'settings' | 'usage' | 'security'. Khách (chưa đăng nhập / tắt xác thực) chỉ mở được tab Cài đặt.
  function openAccount(tab) {
    var want = typeof tab === 'string' && PROF_TABS.indexOf(tab) >= 0 ? tab : 'profile';
    var authed = S.status === 'authenticated';
    if (!authed && want !== 'settings') { if (S.status === 'unavailable') { loadSession(); return; } openAuth('login'); return; }
    if (!els.account) buildAccount();
    prof.tab = authed ? want : 'settings';
    lastFocus = document.activeElement; els.account.hidden = false;
    renderAccount(true);
    if (authed) refreshQuota();
    setTimeout(function () { var b = els.profTabs.querySelector('[aria-selected="true"]') || els.account.querySelector('.tg-x'); if (b) b.focus(); }, 0);
  }
  function closeAccount() { prof.usageNodes = null; if (els.account) els.account.hidden = true; if (lastFocus && lastFocus.focus) try { lastFocus.focus(); } catch (e) {} }

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
    var wasOpen = !!(els.account && !els.account.hidden);
    unmountSettings(); // trả các mục cài đặt về #settingsModal trước khi gỡ hộp thoại (nếu không sẽ mất DOM cài đặt)
    ['auth', 'account', 'assets', 'reset'].forEach(function (k) { if (els[k]) { if (els[k].parentNode) els[k].parentNode.removeChild(els[k]); els[k] = null; } });
    renderBannerStatic(); renderPill(); renderBanner();
    if (pendingReset) openReset();
    if (wasOpen) openAccount(prof.tab);
  }

  // ---------------------------------------------------------------- đặt mật khẩu từ link email
  // Supabase đưa người dùng về Site URL kèm token trong FRAGMENT (#access_token=...&type=recovery). Token được đọc, XÓA KHỎİ URL
  // ngay (không rò qua Referer/lịch sử/chia sẻ link) và chỉ sống trong bộ nhớ đến khi gửi /api/auth/reset.
  var pendingReset = null;
  var suppressAutoLogin = false;
  function readRecoveryFromHash() {
    var hash = String(location.hash || '');
    if (hash.length < 2) return null;
    var params; try { params = new URLSearchParams(hash.slice(1)); } catch (e) { return null; }
    var tok = params.get('access_token'); var isRecovery = params.get('type') === 'recovery' && !!tok;
    var isError = !isRecovery && (params.has('error_code') || params.get('error') === 'access_denied');
    if (!isRecovery && !isError) return null;
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
    return isRecovery ? { token: tok } : { error: true };
  }
  function buildReset() {
    var pw = h('input', { class: 'tg-in', type: 'password', id: 'tgNewPw', autocomplete: 'new-password', maxlength: '72', required: true });
    var pw2 = h('input', { class: 'tg-in', type: 'password', id: 'tgNewPw2', autocomplete: 'new-password', maxlength: '72', required: true });
    var msg = h('div', { class: 'tg-msg', role: 'alert', 'aria-live': 'assertive' });
    var submit = h('button', { class: 'tg-btn primary', type: 'submit', text: tx('auth.reset.submit') });
    var form = h('form', { novalidate: true, onsubmit: function (e) {
      e.preventDefault();
      if (busy) return;
      var v = pw.value;
      if (v.length < 8 || !/[A-Za-z]/.test(v) || !/\d/.test(v)) { msg.textContent = tx('auth.v.pwWeak'); msg.className = 'tg-msg err'; pw.focus(); return; }
      if (v !== pw2.value) { msg.textContent = tx('auth.v.mismatch'); msg.className = 'tg-msg err'; pw2.focus(); return; }
      busy = true; submit.disabled = true; submit.textContent = tx('auth.busy'); msg.textContent = '';
      api('POST', '/api/auth/reset', { accessToken: pendingReset, password: v, confirmPassword: pw2.value }).then(function (r) {
        busy = false; submit.disabled = false; submit.textContent = tx('auth.reset.submit');
        if (!r.ok) { msg.textContent = errText(r.json); msg.className = 'tg-msg err'; return; }
        pendingReset = null; pw.value = ''; pw2.value = '';
        closeReset(); openAuth('login'); setMsg(tx('auth.reset.done'), 'ok');
      }).catch(function () { busy = false; submit.disabled = false; submit.textContent = tx('auth.reset.submit'); msg.textContent = tx('auth.err.network'); msg.className = 'tg-msg err'; });
    } },
    h('label', { class: 'tg-field' }, h('span', { text: tx('auth.reset.field') }), pw),
    h('label', { class: 'tg-field' }, h('span', { text: tx('auth.field.confirm') }), pw2), msg, submit);
    var close = h('button', { class: 'tg-x', type: 'button', 'aria-label': tx('auth.close'), onclick: function () { pendingReset = null; closeReset(); loadSession(); }, text: '✕' });
    var card = h('div', { class: 'tg-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tgResetTitle' }, close, h('h2', { id: 'tgResetTitle', text: tx('auth.reset.title') }), h('p', { class: 'tg-sub', text: tx('auth.reset.sub') }), form);
    var ov = h('div', { class: 'tg-overlay', hidden: true, onkeydown: trapKeys }, card);
    els.reset = ov; document.body.appendChild(ov);
  }
  function openReset() { if (!els.reset) buildReset(); els.reset.hidden = false; setTimeout(function () { var i = document.getElementById('tgNewPw'); if (i) i.focus(); }, 0); }
  function closeReset() { if (els.reset) els.reset.hidden = true; }

  // ---------------------------------------------------------------- bootstrap
  function loadSession() {
    return api('GET', '/api/auth/session').then(function (r) {
      var j = r.json || {};
      S.enforcement = j.enforcement !== false;
      if (j.status === 'authenticated') { setStatus('authenticated', j.user); refreshQuota(); }
      else if (j.status === 'disabled' || j.status === 'unconfigured') { setStatus(j.status, null); }
      else if (j.status === 'unavailable') { setStatus('unavailable', null); }
      else { var first = S.status === 'loading'; setStatus('unauthenticated', null); if (first && !suppressAutoLogin && !pendingReset) openAuth('login', j.status === 'expired' ? tx('auth.err.session_expired') : ''); }
    }).catch(function () { setStatus('unavailable', null); });
  }

  function init() {
    mergeDict();
    applyPrefs(); installSettingsRedirect();
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
    var rec = readRecoveryFromHash();
    if (rec && rec.token) { pendingReset = rec.token; openReset(); }
    else if (rec && rec.error) { suppressAutoLogin = true; setTimeout(function () { openAuth('forgot', tx('auth.err.reset_token_invalid')); }, 0); }
    loadAssets(); loadSession();
  }

  window.TGAuth = {
    getState: function () { return { status: S.status, user: S.user, quota: S.quota }; }, refreshQuota: refreshQuota, openLogin: function () { openAuth('login'); },
    _sha256: sha256Js, _leadingZeroBits: leadingZeroBits, _solvePow: solvePow, _dict: DICT
  };
  window.TGAssets = { get: function (k) { return S.assets[k] || null; } };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
