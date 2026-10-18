'use client';

import { useState } from 'react';
import { AnimatePresence, LayoutGroup, motion } from 'framer-motion';
import { Akis } from '@/components/mascot/Akis';
import { MotionProvider, Reveal, StaggerItem, StaggerList, MagneticButton } from '@/components/motion';
import { FEATURE_POSES, STATE_POSES, type AkisPose, type PoseInfo } from '@/lib/mascot/poses';
import { DUR, EASE, SPRING } from '@/lib/motion/tokens';
import './lab.css';

function PoseButton({ p, active, onPick }: { p: PoseInfo; active: boolean; onPick: (id: AkisPose) => void }) {
  return (
    <motion.button
      type="button"
      className="lab-pose"
      data-active={active}
      aria-pressed={active}
      onClick={() => onPick(p.id)}
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.96 }}
      transition={SPRING.snappy}
    >
      {active && <motion.span layoutId="lab-pill" className="lab-pill" transition={SPRING.soft} />}
      <span className="lab-pose-t">{p.title}</span>
    </motion.button>
  );
}

export function MascotLab() {
  const [pose, setPose] = useState<AkisPose>('hint');
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const all = [...FEATURE_POSES, ...STATE_POSES];
  const info = all.find((p) => p.id === pose) || all[0];

  return (
    <MotionProvider>
      <link rel="stylesheet" href="/css/mascot.css" precedence="default" />
      <main className="lab" data-theme={theme}>
        <header className="lab-head">
          <div>
            <p className="lab-kicker">Akis · linh vật vector</p>
            <h1>Mỗi tính năng một tạo hình</h1>
          </div>
          <MagneticButton className="lab-btn" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label="Đổi nền xem thử">
            Nền: {theme === 'dark' ? 'tối' : 'sáng'}
          </MagneticButton>
        </header>

        <section className="lab-stage" aria-label="Xem trước">
          <div className="lab-akis"><Akis pose={pose} /></div>
          <AnimatePresence mode="wait">
            <motion.div
              key={info.id}
              className="lab-cap"
              role="status"
              aria-live="polite"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: DUR.base, ease: EASE.out }}
            >
              <h2>{info.title}</h2>
              <p>{info.desc}</p>
            </motion.div>
          </AnimatePresence>
        </section>

        <LayoutGroup>
          <Reveal>
            <h3 className="lab-h">Tính năng</h3>
            <StaggerList className="lab-grid">
              {FEATURE_POSES.map((p) => (
                <StaggerItem key={p.id}><PoseButton p={p} active={p.id === pose} onPick={setPose} /></StaggerItem>
              ))}
            </StaggerList>
          </Reveal>
          <Reveal delay={0.05}>
            <h3 className="lab-h">Trạng thái chung</h3>
            <StaggerList className="lab-grid">
              {STATE_POSES.map((p) => (
                <StaggerItem key={p.id}><PoseButton p={p} active={p.id === pose} onPick={setPose} /></StaggerItem>
              ))}
            </StaggerList>
          </Reveal>
        </LayoutGroup>
      </main>
    </MotionProvider>
  );
}
