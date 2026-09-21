// ==============================================================================================
// BUG-004 — MỘT CHÍNH SÁCH SECURITY HEADER DUY NHẤT (§13)
// ==============================================================================================
// Trước bản vá này có BA nơi khai security header và chúng KHÔNG khớp nhau:
//   - vercel.json                            : X-Frame-Options DENY + CSP (frame-ancestors 'none') + HSTS
//   - server/middleware/security.js (Helmet) : frameguard 'deny'   + CSP + HSTS
//   - next.config.mjs                        : X-Frame-Options SAMEORIGIN, KHÔNG CSP, KHÔNG HSTS  <-- LỆCH
// Hậu quả thật: tuỳ response do Next route handler phát ra hay do Vercel edge phát ra, trình duyệt
// nhận hai policy khác nhau (một bên cho phép nhúng iframe cùng-origin, một bên cấm tuyệt đối; một
// bên có CSP, một bên không). Đây đúng là lớp lỗi "không được để production và local mâu thuẫn" mà
// §13 yêu cầu chấm dứt, và nó không thể phát hiện bằng mắt vì cả ba file đều "trông hợp lý".
//
// NAY: giá trị được khai MỘT LẦN ở đây và test/header-policy-parity.test.js khoá cả ba nơi về đúng
// một giá trị (so khớp byte-for-byte, chạy được KHÔNG cần npm install) — sửa một nơi mà quên hai nơi
// kia sẽ FAIL ngay.
// ==============================================================================================

/**
 * CSP dùng chung. PHẢI khớp tuyệt đối với:
 *   - vercel.json -> headers[source="/(.*)"] -> Content-Security-Policy
 *   - server/middleware/security.js -> helmetConfig -> contentSecurityPolicy.directives
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' https://js.puter.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self' https://api.puter.com https://js.puter.com",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'"
].join('; ');

/** Bộ header bảo mật áp cho MỌI response do Next phát ra. */
export const SECURITY_HEADERS = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // Ứng dụng này không bao giờ cần bị nhúng trong iframe -> DENY (KHÔNG phải SAMEORIGIN).
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(self), geolocation=(), payment=(), usb=(), interest-cohort=()' },
  { key: 'Content-Security-Policy', value: CONTENT_SECURITY_POLICY }
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  compress: true,
  serverExternalPackages: [
    '@google/genai',
    'openai',
    'compression',
    'express',
    'helmet'
  ],
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: SECURITY_HEADERS
      }
    ];
  }
};

export default nextConfig;
