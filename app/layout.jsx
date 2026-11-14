import './globals.css';
import Script from 'next/script';

export const metadata = {
  title: 'RescueRoute · City access map',
  description: 'Explore street access and connect intersections on the RescueRoute map.'
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <meta name="rescue-map-tile-url" content="https://tile.openstreetmap.org/{z}/{x}/{y}.png" />
        <link rel="stylesheet" href="/legacy/styles.css" />
        <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" crossOrigin="" />
        <link rel="stylesheet" href="/legacy/rescue.css" />
        <Script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" strategy="beforeInteractive" crossOrigin="" />
      </head>
      <body>{children}</body>
    </html>
  );
}
