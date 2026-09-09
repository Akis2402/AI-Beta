'use strict';
// FIX ROOT CAUSE (CSP inline-script violation): đoạn này TRƯỚC ĐÂY nằm trong 1 thẻ <script> nội
// tuyến (inline) ngay trong <head> của index.html. Nhưng vercel.json + server/middleware/security.js
// đều khai báo Content-Security-Policy với:
//   script-src 'self' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net;
// — KHÔNG có 'unsafe-inline'. Trên production (Vercel) và cả local (Express/helmet), trình duyệt sẽ
// TỪ CHỐI thực thi bất kỳ <script> nội tuyến nào (kể cả handler bắt lỗi boot này), ném:
//   Executing inline script violates the following Content Security Policy directive: "script-src ..."
// Vì đây CHÍNH LÀ script chịu trách nhiệm hiển thị màn hình lỗi khi app không boot được, nếu bản
// thân nó bị CSP chặn thì người dùng sẽ thấy trang trắng/im lặng khi có sự cố — tệ hơn cả không có gì.
//
// FIX ĐÚNG KIẾN TRÚC: tách thành file ngoài (/js/boot.js), nạp bằng <script src="/js/boot.js"></script>
// — vì CSP đã cho phép 'self', file JS nội bộ tải qua <script src> luôn được phép chạy, không cần
// thêm 'unsafe-inline' (tránh làm giảm bảo mật) và không cần nonce/hash phức tạp.
//
// File này CHẠY CỰC SỚM (nạp ngay đầu <head>, trước mọi CDN script và trước app.js) và:
// - Không phụ thuộc app.js.
// - Không phụ thuộc bất kỳ thư viện CDN nào (pdf.js/mammoth/katex/mathjs/three/docx).
// - Không phụ thuộc DOM ngoài <body> (tự đợi DOMContentLoaded nếu cần append vào body).
(function () {
  window.__appBooted = false;

  function showBootError() {
    // Không hiển thị lỗi nếu app đã boot xong thành công (window.__appBooted = true được set ở
    // cuối public/js/app.js) — tránh coi nhầm 1 lỗi runtime bình thường SAU KHI app đã chạy là
    // "boot failure". Cũng không tạo 2 màn hình lỗi chồng nhau nếu hàm này bị gọi nhiều lần.
    if (window.__appBooted || document.getElementById('bootErrorScreen')) return;

    var isDev = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
    var box = document.createElement('div');
    box.id = 'bootErrorScreen';
    box.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#faf7f2;color:#1a1a1a;'
      + 'display:flex;align-items:center;justify-content:center;padding:24px;'
      + 'font-family:system-ui,-apple-system,sans-serif;text-align:center;';
    box.innerHTML =
      '<div style="max-width:420px;">'
      + '<div style="font-size:40px;margin-bottom:12px;">⚠️</div>'
      + '<h2 style="margin:0 0 8px;font-size:18px;">Không thể khởi động ứng dụng</h2>'
      + '<p style="margin:0 0 16px;color:#555;font-size:14px;line-height:1.5;">Một thư viện cần '
      + 'thiết chưa tải được (mạng chậm, trình chặn quảng cáo, hoặc tường lửa mạng đang chặn tài '
      + 'nguyên bên ngoài). Hãy tắt trình chặn quảng cáo hoặc thử mạng khác rồi tải lại trang.</p>'
      + (isDev ? '<p style="font-size:12px;color:#999;margin:0 0 16px;">Chế độ dev: mở Console (F12) để xem lỗi chi tiết.</p>' : '')
      + '<button id="bootReloadBtn" style="background:#2955FF;color:#fff;border:none;border-radius:8px;'
      + 'padding:10px 20px;font-size:14px;cursor:pointer;">Tải lại trang</button>'
      + '</div>';

    if (document.body) {
      document.body.appendChild(box);
    } else {
      // boot.js nạp trong <head>, trước <body> tồn tại — nếu lỗi xảy ra cực sớm (trước cả khi
      // body được parse), đợi DOMContentLoaded rồi mới append thay vì crash ở đây.
      window.addEventListener('DOMContentLoaded', function () { document.body.appendChild(box); });
    }
    var btn = box.querySelector('#bootReloadBtn');
    if (btn) btn.onclick = function () { location.reload(); };
  }

  // FIX ROOT CAUSE (mục 5 trong yêu cầu audit): TRƯỚC ĐÂY boot.js coi CẢ 'error' LẪN
  // 'unhandledrejection' là boot failure. Về mặt kỹ thuật, 'unhandledrejection' KHÔNG BAO GIỜ là tín
  // hiệu đáng tin cho "core app không khởi động được": theo đúng vòng lặp sự kiện của JS (event
  // loop), 1 Promise rejection chỉ được xử lý (và sự kiện 'unhandledrejection' chỉ được bắn ra) SAU
  // KHI toàn bộ đoạn code đồng bộ (synchronous) của app.js đã chạy xong hết — tức là SAU khi dòng
  // cuối cùng "window.__appBooted = true" (public/js/app.js) đã chạy. Nói cách khác: nếu app "boot"
  // được định nghĩa là "chạy hết phần code đồng bộ mà không bị crash", thì mọi unhandledrejection
  // XẢY RA SAU thời điểm đó về bản chất luôn là lỗi RUNTIME bình thường (1 fetch API lỗi, 1 tính
  // năng phụ thất bại...), không phải lỗi boot — dù có filter theo __appBooted hay không.
  // Vì vậy: CHỈ giữ lại 'error' (bắt lỗi đồng bộ thực sự — ReferenceError/SyntaxError/TypeError chết
  // ngay khi parse/chạy script, ví dụ core app.js tự nó lỗi cú pháp) làm tín hiệu boot failure DUY
  // NHẤT. 'unhandledrejection' KHÔNG còn kích hoạt màn hình lỗi khởi động nữa — chỉ log ra console
  // để dev debug (không làm phiền người dùng, không có nguy cơ "1 API lỗi mạng làm tưởng cả app sập").
  // FIX ROOT CAUSE (PHẦN VII audit — mobile chậm do tải hết 4.4MB vendor lib ngay từ đầu dù chưa
  // dùng): loader dùng chung để nạp on-demand pdf.js/mammoth/three.js/docx.js CHỈ khi feature tương
  // ứng thực sự được gọi (upload PDF, upload DOCX, vẽ khối 3D, xuất đề cương .docx). Đặt ở boot.js
  // (không phải app.js) vì đây là utility lõi, không phụ thuộc gì khác, cần sẵn sàng sớm nhất.
  // - Không race condition: cache Promise theo src, gọi nhiều lần cùng lúc chỉ tạo 1 thẻ <script>.
  // - Không load trùng: kiểm tra querySelector trước khi tạo thẻ mới (vd script đã có sẵn do lần
  //   gọi trước, hoặc do version cũ nào đó chèn tay).
  // - Không tạo CSP violation: src luôn cùng-origin ('/vendor/...'), khớp `script-src 'self'` đã
  //   khai báo — không khác gì thẻ <script> tĩnh trong index.html, chỉ khác thời điểm chèn.
  // - Có error state: reject rõ ràng khi script 404/parse lỗi, KHÔNG tự ý showBootError() (đây là
  //   optional dependency — đúng nguyên tắc PHẦN VI, lỗi tải phải chỉ làm feature đó báo lỗi riêng).
  var __vendorPromises = Object.create(null);
  window.__loadVendorScript = function (src) {
    if (__vendorPromises[src]) return __vendorPromises[src];
    var existing = document.querySelector('script[src="' + src + '"]');
    if (existing && existing.getAttribute('data-loaded') === '1') {
      __vendorPromises[src] = Promise.resolve();
      return __vendorPromises[src];
    }
    __vendorPromises[src] = new Promise(function (resolve, reject) {
      var s = existing || document.createElement('script');
      s.src = src;
      function onLoad() { s.setAttribute('data-loaded', '1'); resolve(); }
      function onError() {
        delete __vendorPromises[src]; // cho phép thử lại lần sau (vd người dùng bật lại mạng)
        reject(new Error('Không tải được: ' + src));
      }
      s.addEventListener('load', onLoad, { once: true });
      s.addEventListener('error', onError, { once: true });
      if (!existing) document.body.appendChild(s);
    });
    return __vendorPromises[src];
  };

  window.addEventListener('error', function () { showBootError(); });
  window.addEventListener('unhandledrejection', function (ev) {
    // Chỉ ghi log để debug — KHÔNG gọi showBootError(). Xem giải thích chi tiết ở comment phía trên.
    try { console.error('[unhandledrejection – không phải boot failure]', ev && ev.reason); } catch (e) {}
  });
})();
