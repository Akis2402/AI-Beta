// ============================================================================================
// LEGACY UI IS THE SOURCE OF TRUTH FOR BEHAVIOR (V5)
// ============================================================================================
// `middleware.ts` rewrite `/` -> `/index.html` NÊN component này thực tế KHÔNG bao giờ render.
// Giữ lại như fallback tuyệt đối trong trường hợp middleware bị vô hiệu (ví dụ Vercel Edge
// runtime disable, hoặc chạy `next start` với flag đặc biệt). Component chỉ chuyển hướng cứng
// sang `/index.html` để đảm bảo user luôn nhận được UI legacy đầy đủ (parity với bản B).
//
// React AppShell trước đây (components/app-shell/AppShell.tsx) được giữ nguyên như migration
// surface tương lai — sẽ được wire khi đạt parity đầy đủ với B (theo Definition of Done ở
// Section 29 của master prompt).
// ============================================================================================

import { redirect } from 'next/navigation';

export const dynamic = 'force-static';
export const revalidate = false;

export default function HomePage() {
  redirect('/index.html');
}
