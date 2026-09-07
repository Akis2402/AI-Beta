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

  // Chỉ bắt lỗi TOÀN CỤC không được xử lý (script chết ngay khi parse/chạy top-level) — các lỗi
  // runtime bình thường bên trong try/catch của app.js (vd 1 provider AI lỗi, 1 thư viện optional
  // thiếu...) không lọt tới đây vì đã được app.js tự xử lý cục bộ, không throw ra window.
  window.addEventListener('error', function () { showBootError(); });
  window.addEventListener('unhandledrejection', function () { showBootError(); });
})();
