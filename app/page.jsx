import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Script from 'next/script';

async function getLegacyBody() {
  const html = await readFile(join(process.cwd(), 'public/legacy/index.html'), 'utf8');
  const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? '';
  return body.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
}

export default async function HomePage() {
  const markup = await getLegacyBody();
  return (
    <>
      <div dangerouslySetInnerHTML={{ __html: markup }} />
      <Script src="/legacy/app.js" strategy="afterInteractive" />
      <Script src="/legacy/rescue.js" strategy="afterInteractive" />
      <Script src="/legacy/uploads.js" type="module" strategy="afterInteractive" />
    </>
  );
}
