'use client';

import { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { loadAkis } from '@/lib/mascot/loadAkis';
import type { AkisPose } from '@/lib/mascot/poses';
import { SPRING } from '@/lib/motion/tokens';

interface AkisProps {
  pose?: AkisPose;
  variant?: 'full' | 'body';
  /** Mắt nhìn theo con trỏ. */
  track?: boolean;
  className?: string;
  onClick?: () => void;
  onReady?: (mascot: any) => void;
}

/**
 * Akis cho React. PHÂN VAI: Framer Motion lo lớp NGOÀI (xuất hiện, hover, nhấn, layout) —
 * GSAP lo lớp TRONG (rig SVG: tư thế, vòng lặp theo tính năng). Cả hai tôn trọng "giảm chuyển động".
 */
export function Akis({ pose = 'idle', variant = 'full', track = true, className, onClick, onReady }: AkisProps) {
  const host = useRef<HTMLDivElement>(null);
  const mk = useRef<any>(null);
  const poseRef = useRef<AkisPose>(pose);
  poseRef.current = pose;

  useEffect(() => {
    let dead = false;
    loadAkis()
      .then((A) => {
        if (dead || !host.current) return;
        mk.current = A.create({ size: '100%', state: poseRef.current, variant, track });
        host.current.appendChild(mk.current.el);
        onReady?.(mk.current);
      })
      .catch(() => { /* hỏng mạng: vùng trống, UI xung quanh vẫn dùng được */ });
    return () => { dead = true; mk.current?.destroy(); mk.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant, track]);

  useEffect(() => { mk.current?.setState(pose); }, [pose]);

  return (
    <motion.div
      ref={host}
      className={className}
      aria-hidden="true"
      onClick={onClick}
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      whileHover={{ scale: 1.03 }}
      whileTap={{ scale: 0.97 }}
      transition={SPRING.soft}
    />
  );
}
