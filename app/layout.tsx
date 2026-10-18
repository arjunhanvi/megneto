import type { Metadata, Viewport } from 'next';
import Script from 'next/script';
import './globals.css';

export const metadata: Metadata = {
  title: 'Megneto · Spatial Digital Twin',
  description:
    'Macro-to-micro spatial digital twin: a CesiumJS orbital view that dives into a live, instanced React Three Fiber micro-factory.',
};

export const viewport: Viewport = {
  themeColor: '#eaf4fd',
  colorScheme: 'light',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/*
          Cesium resolves its Workers, Assets and Widgets at runtime from this
          global. It must be set before the Cesium chunk evaluates, which is why
          it is an inline beforeInteractive script rather than an import.
          The folder itself is mirrored into /public by scripts/copy-static-assets.mjs.
        */}
        <Script id="cesium-base-url" strategy="beforeInteractive">
          {`window.CESIUM_BASE_URL = '/cesium';`}
        </Script>
      </head>
      <body className="bg-frost-200 text-ink-800 antialiased">{children}</body>
    </html>
  );
}
