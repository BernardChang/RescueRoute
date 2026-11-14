export const runtime = 'nodejs';

export async function GET() {
  const config = {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
    messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET
  };

  if (Object.values(config).some((value) => !value?.trim())) {
    return Response.json({ error: 'Firebase is not configured on this website.' }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' }
    });
  }

  return Response.json(config, { headers: { 'Cache-Control': 'no-store' } });
}
