// ============================================================================================
// MIGRATION COMPATIBILITY BRIDGE (V5.2) — Next 16 `proxy` file convention
// ============================================================================================
// Next 16 đổi tên file convention `middleware.ts` → `proxy.ts`. Nội dung + signature giữ nguyên
// (vẫn dùng `NextRequest` / `NextResponse` từ 'next/server', vẫn export function default với tên
// bất kỳ). Xem: https://nextjs.org/docs/app/api-reference/file-conventions/proxy
//
// Root cause của regression sau khi chuyển sang Next.js:
//   - `app/page.tsx` (React AppShell) chiếm quyền render tại `/`, nhưng shell mới CHƯA đạt parity
//     với legacy engine `public/js/app.js` (7,020 dòng) và `public/index.html` (437 dòng full DOM).
//   - Sai contract `/api/chat` (message vs query, dataURL vs {mediaType,base64}, thiếu contexts/
//     sourceStatus/settings), SSE parser không phân biệt event, source upload dùng `file.text()` cho
//     PDF/DOCX, không có approach/detail state machine, thiếu visual/3D wiring.
//
// Fix theo compatibility-first (Section 1.3, 3.2, 26 của master prompt):
//   - Route `/` -> `/index.html` (Next.js serve trực tiếp public/index.html — file này đã có full
//     DOM cũ + <script src="/js/boot..."> + <script src="/js/app...">, và app.js đã fetch trực tiếp
//     `/api/chat` với contract chuẩn của server/utils/validators.js).
//   - Các endpoint /api/* tiếp tục được xử lý bởi Next App Router (`app/api/**/route.ts` bridge sang
//     Express `server/app.js` qua `lib/server/expressBridge.ts`).
//   - React shell `components/*` được GIỦ NGUYÊN như migration surface tương lai, nhưng KHÔNG wire
//     vào production để tránh regression parity — đúng nguyên tắc "React implementation coi là chưa
//     đạt parity cho đến khi chứng minh ngược lại" (Section 28 master prompt).
//
// Không ảnh hưởng tới bất kỳ endpoint /api/* nào (matcher chỉ khớp đúng `/`).
// ============================================================================================

import { NextResponse, type NextRequest } from 'next/server';

export default function proxy(req: NextRequest) {
  const p = req.nextUrl.pathname;
  // Chỉ rewrite đúng "/" (không đụng /index.html, /api/*, /js/*, /css/*, /vendor/*).
  if (p === '/' || p === '') {
    const url = req.nextUrl.clone();
    url.pathname = '/index.html';
    return NextResponse.rewrite(url);
  }
  return NextResponse.next();
}

export const config = {
  // Proxy chỉ chạy cho root path — mọi asset tĩnh (/js/*, /css/*, /vendor/*), API route
  // (/api/*) và Next internals (/_next/*) đều bypass tự động.
  matcher: '/'
};
