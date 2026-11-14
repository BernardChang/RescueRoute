export const runtime = 'nodejs';

export async function GET() {
  const firebaseConfigured = Boolean(
    process.env.NEXT_PUBLIC_FIREBASE_API_KEY?.trim() &&
    process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN?.trim() &&
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID?.trim() &&
    process.env.NEXT_PUBLIC_FIREBASE_APP_ID?.trim()
  );

  return Response.json({
    status: 'ok',
    analysisConfigured: Boolean(process.env.OPENAI_API_KEY?.trim()),
    firebaseConfigured
  }, { headers: { 'Cache-Control': 'no-store' } });
}
