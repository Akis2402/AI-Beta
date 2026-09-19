import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Trợ Giải — AI học tập',
  description: 'Không gian học tập AI thông minh: giải bài, vẽ hình minh họa 2D/3D, tra cứu công thức, flashcard ôn tập và trích dẫn tài liệu học tập chuẩn xác.',
  keywords: ['học tập', 'giải bài', 'AI học tập', 'toán học', 'vật lý', 'hóa học', 'flashcards', 'công thức', 'trợ giải'],
  authors: [{ name: 'Trợ Giải Team' }],
  icons: {
    icon: '/favicon.svg',
    shortcut: '/favicon.svg',
    apple: '/favicon.svg',
  },
  openGraph: {
    title: 'Trợ Giải — AI học tập',
    description: 'Không gian học tập AI thông minh: giải bài, minh họa trực quan, ghi chú và flashcard ôn tập.',
    type: 'website',
    locale: 'vi_VN',
  }
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  viewportFit: 'cover',
  themeColor: '#4550E6'
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="vi" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Sora:wght@500;600;700;800&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&family=Itim&display=swap"
          rel="stylesheet"
        />
        <script src="/vendor/katex/katex.min.js" defer></script>
        <script src="/vendor/katex/contrib/auto-render.min.js" defer></script>
        <script src="/vendor/mathjs/math.js" defer></script>
      </head>
      <body>
        {children}
      </body>
    </html>
  );
}
