import './globals.css';

export const metadata = {
  title: 'TaxThaiPro - ระบบจัดการภาษีอัจฉริยะ',
  description: 'ส่งบิลเข้า LINE คำนวณภาษีอัตโนมัติ',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="th">
      <body>{children}</body>
    </html>
  );
}
