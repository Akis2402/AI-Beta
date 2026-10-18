'use client';

import type { ReactNode } from 'react';
import { MotionConfig } from 'framer-motion';
import { DUR, EASE } from '@/lib/motion/tokens';

/**
 * Bọc toàn bộ cây React: áp token mặc định và TỰ ĐỘNG tôn trọng "giảm chuyển động" của hệ điều hành
 * (reducedMotion="user" => Framer Motion bỏ animation transform/layout, chỉ giữ đổi opacity).
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <MotionConfig reducedMotion="user" transition={{ duration: DUR.base, ease: EASE.out }}>
      {children}
    </MotionConfig>
  );
}
