import type { Metadata } from 'next';
import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
import './globals.css';

export const metadata: Metadata = { title: 'devfootnote', description: '개발 메모와 근거 자료를 위한 개인 자료함' };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ko"><body>{children}</body></html>;
}
