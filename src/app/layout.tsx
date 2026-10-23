import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'Crop Studio | Batch WebP', description: 'Fast, private 16:9 batch cropper and WebP exporter.' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body>{children}</body></html>; }
