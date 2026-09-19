import { NextRequest } from 'next/server';
import { handleNextApiRequest } from '@/lib/server/expressBridge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  return handleNextApiRequest(req);
}
