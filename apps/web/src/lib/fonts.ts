import localFont from 'next/font/local';

export const gowunBatang = localFont({
  src: '../../public/fonts/gowun-batang/gowun-batang-korean-400-normal.woff2',
  weight: '400',
  style: 'normal',
  display: 'swap',
  fallback: ['Georgia', 'serif'],
});
