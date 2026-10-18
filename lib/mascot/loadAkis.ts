import gsap from 'gsap';

/** Nạp engine Akis (rig + poses + motion + API) đúng 1 lần ở client. Dùng chung code với các trang HTML => 1 nguồn sự thật. */
const FILES = ['akisRig', 'akisPoses', 'akisMotion', 'mascot'];
let ready: Promise<any> | null = null;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const old = document.querySelector<HTMLScriptElement>(`script[data-akis="${src}"]`);
    if (old) {
      if (old.dataset.done === '1') return resolve();
      old.addEventListener('load', () => resolve());
      old.addEventListener('error', () => reject(new Error('Không tải được ' + src)));
      return;
    }
    const s = document.createElement('script');
    s.src = src; s.async = false; s.dataset.akis = src;
    s.addEventListener('load', () => { s.dataset.done = '1'; resolve(); });
    s.addEventListener('error', () => reject(new Error('Không tải được ' + src)));
    document.head.appendChild(s);
  });
}

export function loadAkis(): Promise<any> {
  if (typeof window === 'undefined') return Promise.reject(new Error('loadAkis chỉ chạy ở client'));
  const w = window as any;
  w.gsap = w.gsap || gsap;                       // engine Akis dùng window.gsap — cấp bản gsap từ npm
  if (!ready) {
    ready = FILES.reduce((p, f) => p.then(() => loadScript(`/js/mascot/${f}.js`)), Promise.resolve()).then(() => w.AkisMascot);
    ready.catch(() => { ready = null; });         // cho phép thử lại nếu lỗi mạng
  }
  return ready;
}
