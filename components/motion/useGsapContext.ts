'use client';

import { useEffect, type DependencyList, type RefObject } from 'react';
import gsap from 'gsap';

/**
 * Hook GSAP an toàn cho React: tạo gsap.context gắn với `scope`, TỰ dọn (revert) khi unmount/đổi deps,
 * và KHÔNG chạy khi người dùng bật giảm chuyển động. Callback nhận chính `gsap`.
 */
export function useGsapContext(fn: (g: typeof gsap) => void, scope: RefObject<HTMLElement | null>, deps: DependencyList = []) {
  useEffect(() => {
    if (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const ctx = gsap.context(() => fn(gsap), scope.current || undefined);
    return () => ctx.revert();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
