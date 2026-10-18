'use client';

import type { ReactNode } from 'react';
import { motion, type Variants } from 'framer-motion';
import { DUR, EASE } from '@/lib/motion/tokens';

const ease = EASE.out;

/** Hiện dần + trượt nhẹ khi cuộn tới (chạy 1 lần). */
export function Reveal({ children, delay = 0, y = 18, className }: { children: ReactNode; delay?: number; y?: number; className?: string }) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-8% 0px' }}
      transition={{ duration: DUR.slow, ease, delay }}
    >
      {children}
    </motion.div>
  );
}

const listV: Variants = { hidden: {}, show: { transition: { staggerChildren: 0.07, delayChildren: 0.05 } } };
const itemV: Variants = { hidden: { opacity: 0, y: 14 }, show: { opacity: 1, y: 0, transition: { duration: DUR.base, ease } } };

/** Danh sách con xuất hiện lần lượt. Dùng cùng <StaggerItem>. */
export function StaggerList({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div className={className} variants={listV} initial="hidden" whileInView="show" viewport={{ once: true, margin: '-8% 0px' }}>
      {children}
    </motion.div>
  );
}

export function StaggerItem({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div className={className} variants={itemV}>
      {children}
    </motion.div>
  );
}
