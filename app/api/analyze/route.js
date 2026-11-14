export const runtime = 'nodejs';
export const maxDuration = 120;

const maxImageBytes = 10 * 1024 * 1024;
const analysesPerHour = 30;
const rateWindowMs = 60 * 60 * 1000;
const analysisTimes = new Map();

function jsonError(message, status) {
  return Response.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function verifyFirebaseToken(token) {
  const apiKey = process.env.FIREBASE_API_KEY?.trim() || '';
  if (!apiKey) return null;

  let response;
  try {
    response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: token }),
      signal: AbortSignal.timeout(15_000)
    });
  } catch {
    throw new Error('Firebase sign-in validation is temporarily unavailable.');
  }
  if (!response.ok) return null;
  const result = await response.json();
  return result.users?.[0]?.localId ?? null;
}

function isWithinRateLimit(userId) {
  const now = Date.now();
  const activeTimes = (analysisTimes.get(userId) ?? []).filter((time) => now - time < rateWindowMs);
  if (activeTimes.length >= analysesPerHour) {
    analysisTimes.set(userId, activeTimes);
    return false;
  }
  activeTimes.push(now);
  analysisTimes.set(userId, activeTimes);
  return true;
}

async function analyzeImage(image, contentType, apiKey) {
  const imageData = Buffer.from(image).toString('base64');
  const prompt = 'Assess only what is visible in this image. Return three boolean answers and a list of objects visibly impeding the vehicle path. can_vehicles_pass is true only when a typical car appears able to pass through the visible route; use false when visibly blocked or unclear. obstruction_exists is true only when an object visibly impedes the route. dead_end is true only when the visible alley appears to terminate without an exit; do not infer unseen layout. List only visible objects that impede the path, with short names and no narrative. If none, return an empty list.';

  let response;
  try {
    response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        max_output_tokens: 500,
        text: {
          format: {
            type: 'json_schema',
            name: 'alley_access_assessment',
            strict: true,
            schema: {
              type: 'object',
              properties: {
                can_vehicles_pass: { type: 'boolean' },
                obstruction_exists: { type: 'boolean' },
                dead_end: { type: 'boolean' },
                obstructing_objects: { type: 'array', items: { type: 'string' } }
              },
              required: ['can_vehicles_pass', 'obstruction_exists', 'dead_end', 'obstructing_objects'],
              additionalProperties: false
            }
          }
        },
        input: [{
          role: 'user',
          content: [
            { type: 'input_text', text: prompt },
            { type: 'input_image', detail: 'high', image_url: `data:${contentType};base64,${imageData}` }
          ]
        }]
      }),
      signal: AbortSignal.timeout(90_000)
    });
  } catch {
    return { error: 'Photo analysis is temporarily unavailable.', status: 502 };
  }

  if (!response.ok) {
    return {
      error: response.status === 429 ? 'Photo analysis is busy. Try again later.' : 'Photo analysis is temporarily unavailable.',
      status: response.status === 429 ? 429 : 502
    };
  }

  const result = await response.json();
  let assessment;
  try {
    const output = result.output_text ?? result.output?.flatMap((item) => item.content ?? [])
      .filter((part) => part.type === 'output_text').map((part) => part.text).join('\n');
    assessment = JSON.parse(output);
  } catch {
    return { error: 'Photo analysis returned an invalid result.', status: 502 };
  }

  if (!assessment || typeof assessment.can_vehicles_pass !== 'boolean' ||
      typeof assessment.obstruction_exists !== 'boolean' || typeof assessment.dead_end !== 'boolean' ||
      !Array.isArray(assessment.obstructing_objects) ||
      !assessment.obstructing_objects.every((item) => typeof item === 'string')) {
    return { error: 'Photo analysis returned an invalid result.', status: 502 };
  }
  return { analysis: assessment };
}

export async function POST(request) {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return jsonError('Photo analysis is not configured on this website.', 503);

  const authorization = request.headers.get('authorization') ?? '';
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return jsonError('Sign in again before analyzing a photo.', 401);

  let userId;
  try {
    userId = await verifyFirebaseToken(token);
  } catch (error) {
    return jsonError(error.message, 503);
  }
  if (!userId) return jsonError('Sign in again before analyzing a photo.', 401);
  if (!isWithinRateLimit(userId)) return jsonError('Analysis limit reached. Please try again later.', 429);

  const contentType = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) {
    return jsonError('Choose a JPEG, PNG, or WebP photo.', 415);
  }

  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (declaredLength <= 0 || declaredLength > maxImageBytes) {
    return jsonError('Photo is empty or larger than 10 MB.', 413);
  }
  const image = await request.arrayBuffer();
  if (image.byteLength === 0 || image.byteLength > maxImageBytes) {
    return jsonError('Photo is empty or larger than 10 MB.', 413);
  }

  const result = await analyzeImage(image, contentType, apiKey);
  if (result.error) return jsonError(result.error, result.status);
  return Response.json({ analysis: result.analysis, model: 'gpt-4.1-mini' }, { headers: { 'Cache-Control': 'no-store' } });
}
