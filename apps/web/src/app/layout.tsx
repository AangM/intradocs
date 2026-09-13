import type { Metadata } from 'next';
import './mentor.css';
import './globals.css';
import './milestones.css';
import './theme.css';
import './chat.css';
export const metadata: Metadata = {
  title: { default: 'IntraDocs — Knowledge Hub', template: '%s · IntraDocs' },
  description: 'Portal dokumentasi lokal dengan kontrol akses. Build M3, data sintetis.',
  robots: { index: false, follow: false },
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
