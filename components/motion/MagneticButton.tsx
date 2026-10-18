'use client';

import { useRef, type ButtonHTMLAttributes, type PointerEvent } from 'react';
import { motion, useMotionValue, useReducedMotion, useSpring } from 'framer-motion';
import { SPRING } from '@/lib/motion/tokens';

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onDrag' | 'onDragStart' | 'onDragEnd' | 'onAnimationStart'> & { strength?: number };

/** Nút "hút" nhẹ theo con trỏ (spring) + co lại khi nhấn. Tắt hút khi người dùng bật giảm chuyển động. */
export function MagneticButton({ strength = 8, children, ...rest }: Props) {
  const ref = useRef<HTMLButtonElement>(null);
  const reduce = useReducedMotion();
  const mx = useMotionValue(0), my = useMotionValue(0);
  const x = useSpring(mx, SPRING.soft), y = useSpring(my, SPRING.soft);

  function move(e: PointerEvent<HTMLButtonElement>) {
    if (reduce || e.pointerType === 'touch' || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    mx.set(((e.clientX - r.left) / r.width - 0.5) * 2 * strength);
    my.set(((e.clientY - r.top) / r.height - 0.5) * 2 * strength * 0.7);
  }
  function leave() { mx.set(0); my.set(0); }

  return (
    <motion.button ref={ref} style={{ x, y }} whileTap={reduce ? undefined : { scale: 0.96 }} onPointerMove={move} onPointerLeave={leave} {...rest}>
      {children}
    </motion.button>
  );
}
