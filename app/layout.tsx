import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'SLATE DEVOPS OS - Master Control Dashboard',
  description: 'Production Zero-Touch DevOps Master Dashboard & GitHub Scaffolding Engine',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased bg-[#0a0d14] text-slate-100 min-h-screen w-full overflow-x-hidden">
        {children}
      </body>
    </html>
  );
}
