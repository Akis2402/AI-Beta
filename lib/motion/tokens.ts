/**
 * Token chuyển động DÙNG CHUNG cho Framer Motion (React) và GSAP (SVG/timeline).
 * Một nguồn duy nhất => UI và mascot luôn cùng "nhịp". Muốn đổi cảm giác toàn web: sửa ở đây.
 */
type Bezier = [number, number, number, number];
export const EASE: { out: Bezier; inOut: Bezier; back: Bezier } = {
  out: [0.16, 1, 0.3, 1],
  inOut: [0.65, 0, 0.35, 1],
  back: [0.34, 1.56, 0.64, 1]
};

export const DUR = { fast: 0.18, base: 0.32, slow: 0.6 } as const;

export const SPRING = {
  soft: { type: 'spring', stiffness: 170, damping: 22 },
  snappy: { type: 'spring', stiffness: 420, damping: 30 },
  bouncy: { type: 'spring', stiffness: 300, damping: 14 }
} as const;

/** Tên easing tương đương cho GSAP. */
export const GSAP_EASE = { out: 'power3.out', inOut: 'power2.inOut', back: 'back.out(1.7)' } as const;
