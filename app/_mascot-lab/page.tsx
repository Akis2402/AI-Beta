import type { Metadata } from 'next';
import { MascotLab } from './MascotLab';

export const metadata: Metadata = {
  title: 'Akis lab — mọi tư thế theo tính năng',
  description: 'Xem trước các tạo hình và chuyển động của Akis cho từng tính năng của Trợ Giải.',
  robots: { index: false, follow: false }
};

export default function Page() {
  return <MascotLab />;
}
