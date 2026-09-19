// ============================================================================================
// MINIMAL LAYOUT (V5)
// ============================================================================================
// Sau khi chuyển sang bridge legacy (middleware rewrite `/` -> `/index.html`), layout này chỉ áp
// dụng cho các App Router route KHÔNG phải static file (hiện tại chỉ có /api/* route handlers,
// mà chúng cũng không dùng layout). Vì vậy layout được giữ ở mức tối thiểu cần thiết cho Next.js
// App Router hợp lệ (Next 15+ bắt buộc phải có 1 root layout).
//
// Metadata + font Google + KaTeX/mathjs KHÔNG cần khai ở đây nữa vì `public/index.html` (được
// serve trực tiếp bằng middleware) đã khai đầy đủ. Nếu khai trùng ở đây sẽ sinh 2 lần load font
// và có thể conflict CSP.
// ============================================================================================

import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Trợ Giải — AI học tập',
  description:
    'Không gian học tập AI thông minh: giải bài, vẽ hình minh họa 2D/3D, tra cứu công thức, flashcard ôn tập và trích dẫn tài liệu học tập chuẩn xác.',
  icons: {
    icon: '/favicon.svg',
    shortcut: '/favicon.svg',
    apple: '/favicon.svg'
  }
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  viewportFit: 'cover',
  themeColor: '#4550E6'
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="vi" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
