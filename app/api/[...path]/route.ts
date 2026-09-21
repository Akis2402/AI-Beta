// ============================================================================================
// CATCH-ALL API BRIDGE (V5)
// ============================================================================================
// Bất kỳ endpoint /api/* nào KHÔNG có route.ts riêng đều rơi vào file này và được forward tới
// Express app (server/app.js) qua lib/server/expressBridge. Điều này bảo toàn tất cả endpoint
// legacy mà frontend engine `public/js/app.js` có thể gọi, kể cả những endpoint chưa được liệt
// kê rõ trong app/api/ (ví dụ /api/health, /api/generate/mindmap phụ, hoặc endpoint mới sinh ra
// trong tương lai).
//
// Cần thiết vì trước đây `api/index.js` + `api/[...path].js` (Vercel legacy file-based routing)
// đảm nhận việc này — chúng đã bị loại bỏ để tránh 2 cơ chế routing tranh chấp trên Vercel
// (Section 2.6 master prompt). Catch-all Next App Router thay thế đúng chức năng đó nhưng nằm
// trong MỘT source of truth duy nhất (app/api/*).
// ============================================================================================

import type { NextRequest } from 'next/server';
import { handleNextApiRequest } from '@/lib/server/expressBridge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  return handleNextApiRequest(req);
}
export async function POST(req: NextRequest) {
  return handleNextApiRequest(req);
}
export async function PUT(req: NextRequest) {
  return handleNextApiRequest(req);
}
export async function DELETE(req: NextRequest) {
  return handleNextApiRequest(req);
}
export async function PATCH(req: NextRequest) {
  return handleNextApiRequest(req);
}
export async function OPTIONS(req: NextRequest) {
  return handleNextApiRequest(req);
}
export async function HEAD(req: NextRequest) {
  return handleNextApiRequest(req);
}
