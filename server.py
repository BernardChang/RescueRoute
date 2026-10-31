#!/usr/bin/env python3
"""Local RescueRoute web server with an authenticated OpenAI photo-analysis endpoint."""
import base64
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DIST = ROOT / 'dist'
FIREBASE_PROJECT_ID = 'waicy-9666a'
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_ANALYSES_PER_HOUR = 30
RATE_WINDOW = 60 * 60
ANALYSIS_TIMES = {}


def load_api_key():
    key = os.environ.get('OPENAI_API_KEY', '').strip()
    if key:
        return key
    key_file = ROOT.parent / 'logncode.txt'
    if not key_file.is_file():
        return ''
    raw = key_file.read_text(encoding='utf-8').strip()
    if '=' in raw:
        raw = raw.split('=', 1)[1].strip()
    return raw.strip().strip('"').strip("'")


def json_bytes(payload):
    return json.dumps(payload, ensure_ascii=False).encode('utf-8')


def verify_firebase_token(token):
    # Firebase ID tokens are validated by Firebase Auth's account lookup API.
    # Google tokeninfo is intended for Google OAuth ID tokens and may reject
    # otherwise valid Firebase sessions.
    try:
        config = (DIST / 'firebase-config.js').read_text(encoding='utf-8')
        api_key = re.search(r'"apiKey"\s*:\s*"([^"]+)"', config).group(1)
    except (OSError, AttributeError):
        return None
    endpoint = 'https://identitytoolkit.googleapis.com/v1/accounts:lookup?' + urllib.parse.urlencode({'key': api_key})
    request = urllib.request.Request(
        endpoint,
        data=json_bytes({'idToken': token}),
        headers={'Accept': 'application/json', 'Content-Type': 'application/json'},
        method='POST',
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            result = json.loads(response.read().decode('utf-8'))
    except urllib.error.HTTPError:
        return None
    except (urllib.error.URLError, TimeoutError, ValueError):
        raise RuntimeError('Firebase sign-in validation is temporarily unavailable.')
    users = result.get('users', [])
    if not users or not users[0].get('localId'):
        return None
    return users[0]['localId']


def within_rate_limit(user_id):
    now = time.time()
    active = [stamp for stamp in ANALYSIS_TIMES.get(user_id, []) if now - stamp < RATE_WINDOW]
    if len(active) >= MAX_ANALYSES_PER_HOUR:
        ANALYSIS_TIMES[user_id] = active
        return False
    active.append(now)
    ANALYSIS_TIMES[user_id] = active
    return True


def analyze_image(image_bytes, content_type, api_key):
    prompt = (
        'Assess only what is visible in this image. Return three boolean answers and a list '
        'of objects visibly impeding the vehicle path. can_vehicles_pass is true only when '
        'a typical car appears able to pass through the visible route; use false when visibly '
        'blocked or unclear. obstruction_exists is true only when an object visibly impedes '
        'the route. dead_end is true only when the visible alley appears to terminate without '
        'an exit; do not infer unseen layout. List only visible objects that impede the path, '
        'with short names and no narrative. If none, return an empty list.'
    )
    image_url = f'data:{content_type};base64,' + base64.b64encode(image_bytes).decode('ascii')
    payload = {
        'model': 'gpt-4.1-mini',
        'max_output_tokens': 500,
        'text': {
            'format': {
                'type': 'json_schema',
                'name': 'alley_access_assessment',
                'strict': True,
                'schema': {
                    'type': 'object',
                    'properties': {
                        'can_vehicles_pass': {'type': 'boolean'},
                        'obstruction_exists': {'type': 'boolean'},
                        'dead_end': {'type': 'boolean'},
                        'obstructing_objects': {
                            'type': 'array',
                            'items': {'type': 'string'},
                        },
                    },
                    'required': ['can_vehicles_pass', 'obstruction_exists', 'dead_end', 'obstructing_objects'],
                    'additionalProperties': False,
                },
            },
        },
        'input': [{
            'role': 'user',
            'content': [
                {'type': 'input_text', 'text': prompt},
                {'type': 'input_image', 'detail': 'high', 'image_url': image_url},
            ],
        }],
    }
    request = urllib.request.Request(
        'https://api.openai.com/v1/responses',
        data=json_bytes(payload),
        headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'},
        method='POST',
    )
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            result = json.loads(response.read().decode('utf-8'))
    except urllib.error.HTTPError as error:
        return (None, 429 if error.code == 429 else 502)
    except (urllib.error.URLError, TimeoutError, ValueError):
        return None, 502
    analysis = result.get('output_text')
    if not analysis:
        chunks = []
        for item in result.get('output', []):
            for part in item.get('content', []):
                if part.get('type') == 'output_text':
                    chunks.append(part.get('text', ''))
        analysis = '\n'.join(chunks)
    try:
        parsed = json.loads(analysis)
        if (not isinstance(parsed, dict)
                or not all(isinstance(parsed.get(key), bool) for key in ('can_vehicles_pass', 'obstruction_exists', 'dead_end'))
                or not isinstance(parsed.get('obstructing_objects'), list)
                or not all(isinstance(item, str) for item in parsed['obstructing_objects'])):
            return None, 502
    except (TypeError, ValueError):
        return None, 502
    return parsed, 200


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DIST), **kwargs)

    def send_json(self, payload, status=200):
        body = json_bytes(payload)
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/api/health':
            return self.send_json({'status': 'ok', 'analysisConfigured': bool(load_api_key())})
        if self.path.startswith('/api/'):
            return self.send_json({'error': 'Not found'}, 404)
        return super().do_GET()

    def do_POST(self):
        if self.path != '/api/analyze':
            return self.send_json({'error': 'Not found'}, 404)
        api_key = load_api_key()
        if not api_key:
            return self.send_json({'error': 'Photo analysis is not configured on this website.'}, 503)
        authorization = self.headers.get('Authorization', '')
        match = re.fullmatch(r'Bearer\s+(.+)', authorization, flags=re.IGNORECASE)
        try:
            user_id = verify_firebase_token(match.group(1)) if match else None
        except RuntimeError as error:
            return self.send_json({'error': str(error)}, 503)
        if not user_id:
            return self.send_json({'error': 'Sign in again before analyzing a photo.'}, 401)
        if not within_rate_limit(user_id):
            return self.send_json({'error': 'Analysis limit reached. Please try again later.'}, 429)

        content_type = self.headers.get_content_type().lower()
        if content_type not in {'image/jpeg', 'image/png', 'image/webp'}:
            return self.send_json({'error': 'Choose a JPEG, PNG, or WebP photo.'}, 415)
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            return self.send_json({'error': 'Invalid photo size.'}, 400)
        if length <= 0 or length > MAX_IMAGE_BYTES:
            return self.send_json({'error': 'Photo is empty or larger than 10 MB.'}, 413)
        image_bytes = self.rfile.read(length)
        if len(image_bytes) != length:
            return self.send_json({'error': 'Photo upload was incomplete. Please retry.'}, 400)
        analysis, status = analyze_image(image_bytes, content_type, api_key)
        if not analysis:
            message = 'Photo analysis is busy. Try again later.' if status == 429 else 'Photo analysis is temporarily unavailable.'
            return self.send_json({'error': message}, status)
        return self.send_json({'analysis': analysis, 'model': 'gpt-4.1-mini'})

    def log_message(self, fmt, *args):
        # Avoid logging request headers, body bytes, API keys, or auth tokens.
        super().log_message(fmt, *args)


def main():
    server = ThreadingHTTPServer(('127.0.0.1', 4173), Handler)
    print('RescueRoute is serving at http://localhost:4173')
    server.serve_forever()


if __name__ == '__main__':
    main()
