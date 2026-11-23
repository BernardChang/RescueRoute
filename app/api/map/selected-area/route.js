export const runtime = 'nodejs';
export const maxDuration = 240;

const maxOutlinePoints = 60;
const overpassTimeoutMs = 35_000;
const overpassEndpoints = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];
const requestsByUser = new Map();
const rateLimitWindowMs = 60 * 60 * 1000;
const maxRequestsPerWindow = 10;
const aiTimeoutMs = 24_000;
const aiBatchSize = 55;
const aiConcurrency = 3;

function jsonError(message, status) {
  return Response.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function identifyUser(token) {
  const apiKey = process.env.FIREBASE_API_KEY?.trim();
  if (!apiKey) throw new Error('Firebase sign-in validation is not configured on the server.');
  let response;
  try {
    response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: token }),
      signal: AbortSignal.timeout(12_000)
    });
  } catch {
    throw new Error('Firebase sign-in validation is temporarily unavailable.');
  }
  if (!response.ok) return null;
  const body = await response.json();
  return body.users?.[0]?.localId ?? null;
}

function withinRateLimit(userId) {
  const now = Date.now();
  const recent = (requestsByUser.get(userId) || []).filter((time) => now - time < rateLimitWindowMs);
  if (recent.length >= maxRequestsPerWindow) {
    requestsByUser.set(userId, recent);
    return false;
  }
  recent.push(now);
  requestsByUser.set(userId, recent);
  return true;
}

function pointOnSegment(point, a, b, epsilon = 1e-9) {
  const cross = (point[1] - a[1]) * (b[0] - a[0]) - (point[0] - a[0]) * (b[1] - a[1]);
  if (Math.abs(cross) > epsilon) return false;
  return point[0] >= Math.min(a[0], b[0]) - epsilon && point[0] <= Math.max(a[0], b[0]) + epsilon &&
    point[1] >= Math.min(a[1], b[1]) - epsilon && point[1] <= Math.max(a[1], b[1]) + epsilon;
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j], b = polygon[i];
    if (pointOnSegment(point, a, b)) return true;
    if (((a[1] > point[1]) !== (b[1] > point[1])) &&
        point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function cross2(a, b) { return a[0] * b[1] - a[1] * b[0]; }

function segmentIntersection(a, b, c, d) {
  const r = [b[0] - a[0], b[1] - a[1]];
  const s = [d[0] - c[0], d[1] - c[1]];
  const denominator = cross2(r, s);
  if (Math.abs(denominator) < 1e-12) return null;
  const q = [c[0] - a[0], c[1] - a[1]];
  const t = cross2(q, s) / denominator;
  const u = cross2(q, r) / denominator;
  const epsilon = 1e-8;
  if (t < -epsilon || t > 1 + epsilon || u < -epsilon || u > 1 + epsilon) return null;
  return { t: Math.max(0, Math.min(1, t)), u: Math.max(0, Math.min(1, u)), point: [a[0] + r[0] * t, a[1] + r[1] * t] };
}

function validateOutline(value) {
  if (!Array.isArray(value) || value.length < 3 || value.length > maxOutlinePoints) return null;
  const polygon = value.map((point) => {
    if (!Array.isArray(point) || point.length !== 2) return null;
    const lat = Number(point[0]), lng = Number(point[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 85 || Math.abs(lng) > 180) return null;
    return [lng, lat];
  });
  if (polygon.some((point) => !point)) return null;
  const unique = new Set(polygon.map((point) => `${point[0].toFixed(8)},${point[1].toFixed(8)}`));
  if (unique.size < 3) return null;
  let twiceArea = 0;
  for (let index = 0; index < polygon.length; index++) {
    const a = polygon[index], b = polygon[(index + 1) % polygon.length];
    twiceArea += a[0] * b[1] - b[0] * a[1];
  }
  if (Math.abs(twiceArea) < 1e-12) return null;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    for (let j = i + 1; j < polygon.length; j++) {
      if (j === i || j === (i + 1) % polygon.length || i === (j + 1) % polygon.length) continue;
      const c = polygon[j], d = polygon[(j + 1) % polygon.length];
      if (segmentIntersection(a, b, c, d)) return null;
    }
  }
  return polygon;
}

function polygonQueryValue(polygon) {
  return polygon.map(([lng, lat]) => `${lat.toFixed(7)} ${lng.toFixed(7)}`).join(' ');
}

async function loadSelectedRoadWays(polygon) {
  const poly = polygonQueryValue(polygon);
  const query = `[out:json][timeout:45];way["highway"](poly:"${poly}");out body geom;`;
  const failures = [];
  for (const endpoint of overpassEndpoints) {
    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'User-Agent': 'RescueRoute/2.0 (selected area road graph; OpenStreetMap data)'
        },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(overpassTimeoutMs)
      });
    } catch (error) {
      failures.push(`${new URL(endpoint).host}: ${error?.name === 'TimeoutError' ? 'timeout' : 'network error'}`);
      continue;
    }
    if (!response.ok) {
      failures.push(`${new URL(endpoint).host}: HTTP ${response.status}`);
      continue;
    }
    let body;
    try { body = await response.json(); }
    catch { failures.push(`${new URL(endpoint).host}: invalid JSON`); continue; }
    if (body.remark) {
      failures.push(`${new URL(endpoint).host}: ${String(body.remark).slice(0, 100)}`);
      continue;
    }
    const ways = (body.elements || []).filter((item) => item.type === 'way' && item.tags?.highway &&
      Array.isArray(item.nodes) && Array.isArray(item.geometry) && item.nodes.length >= 2 && item.geometry.length >= 2);
    return { ways, server: new URL(endpoint).host };
  }
  console.error('Selected-area OSM fetch failed', failures);
  throw new Error(`OSM could not return this selection (${failures.join('; ')}). The existing map was not changed.`);
}

function validRoad(way) {
  const highway = String(way.tags?.highway || '').toLowerCase();
  return highway && !['proposed', 'construction', 'abandoned', 'razed', 'disused', 'platform', 'raceway'].includes(highway);
}

function interpolate(a, b, t) {
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lon + (b.lon - a.lon) * t };
}

function coordinateKey(point) { return `${point.lat.toFixed(7)},${point.lng.toFixed(7)}`; }
function metersBetween(a, b, metersPerDegreeLng) {
  return Math.hypot((b.lng - a.lng) * metersPerDegreeLng, (b.lat - a.lat) * 111_320);
}

function clipRoadsToPolygon(ways, polygon) {
  const midLat = polygon.reduce((sum, point) => sum + point[1], 0) / polygon.length;
  const metersPerDegreeLng = 111_320 * Math.cos(midLat * Math.PI / 180);
  const fragments = [];
  for (const way of ways) {
    if (!validRoad(way)) continue;
    let active = null;
    const finish = () => {
      if (active?.vertices.length >= 2) fragments.push({ way, vertices: active.vertices });
      active = null;
    };
    const count = Math.min(way.nodes.length, way.geometry.length);
    for (let index = 0; index < count - 1; index++) {
      const a = way.geometry[index], b = way.geometry[index + 1];
      const start = [a.lon, a.lat], end = [b.lon, b.lat];
      const parameters = [0, 1];
      for (let edge = 0; edge < polygon.length; edge++) {
        const hit = segmentIntersection(start, end, polygon[edge], polygon[(edge + 1) % polygon.length]);
        if (hit && hit.t > 1e-8 && hit.t < 1 - 1e-8) parameters.push(hit.t);
      }
      parameters.sort((left, right) => left - right);
      for (let part = 0; part < parameters.length - 1; part++) {
        const t0 = parameters[part], t1 = parameters[part + 1];
        if (t1 - t0 < 1e-9) continue;
        const midpoint = interpolate(a, b, (t0 + t1) / 2);
        if (!pointInPolygon([midpoint.lng, midpoint.lat], polygon)) { finish(); continue; }
        const pointAt = (t) => {
          const point = interpolate(a, b, t);
          const atOriginal = t < 1e-8 || t > 1 - 1e-8;
          return { measure: index + t, ...point, osmId: atOriginal ? String(way.nodes[t < .5 ? index : index + 1]) : null };
        };
        const first = pointAt(t0), last = pointAt(t1);
        const previous = active?.vertices.at(-1);
        const joins = previous && Math.abs(previous.measure - first.measure) < 1e-7 && metersBetween(previous, first, metersPerDegreeLng) < .03;
        if (!joins) { finish(); active = { vertices: [first] }; }
        const currentLast = active.vertices.at(-1);
        if (metersBetween(currentLast, last, metersPerDegreeLng) >= .01) active.vertices.push(last);
      }
    }
    finish();
  }
  return { fragments, metersPerDegreeLng };
}

function wayIsGradeSeparated(a, b) {
  const layerA = Number(a.tags?.layer || 0), layerB = Number(b.tags?.layer || 0);
  if (layerA !== layerB) return true;
  const yes = (value) => !['', 'no', '0', 'false'].includes(String(value || '').toLowerCase());
  return yes(a.tags?.bridge) !== yes(b.tags?.bridge) || yes(a.tags?.tunnel) !== yes(b.tags?.tunnel);
}

function addCandidate(candidates, id, kind, point, hit, roads, evidence = {}) {
  let candidate = candidates.get(id);
  if (!candidate) {
    candidate = { id, kind, lat: point.lat, lng: point.lng, hits: [], roads: new Map(), evidence: {} };
    candidates.set(id, candidate);
  }
  Object.assign(candidate.evidence, evidence);
  if (hit && !candidate.hits.some((existing) => existing.wayId === hit.wayId && Math.abs(existing.measure - hit.measure) < 1e-6)) candidate.hits.push(hit);
  if (roads) candidate.roads.set(String(roads.id), {
    id: String(roads.id),
    name: String(roads.tags?.name || roads.tags?.ref || roads.tags?.highway || 'Unnamed road').slice(0, 70),
    highway: String(roads.tags?.highway || ''),
    oneWay: String(roads.tags?.oneway || '').toLowerCase(),
    bridge: String(roads.tags?.bridge || ''),
    tunnel: String(roads.tags?.tunnel || ''),
    layer: String(roads.tags?.layer || '0')
  });
  return candidate;
}

function buildCandidateJunctions(fragments, polygon, metersPerDegreeLng) {
  const candidates = new Map();
  const occurrencesByOsmId = new Map();
  const segments = [];
  for (const fragment of fragments) {
    const wayId = String(fragment.way.id);
    for (let index = 0; index < fragment.vertices.length; index++) {
      const vertex = fragment.vertices[index];
      if (vertex.osmId) {
        if (!occurrencesByOsmId.has(vertex.osmId)) occurrencesByOsmId.set(vertex.osmId, []);
        occurrencesByOsmId.get(vertex.osmId).push({ fragment, index, vertex });
      }
      if (index > 0) segments.push({ fragment, index: index - 1, a: fragment.vertices[index - 1], b: vertex });
    }
  }

  const intersectionCoordinates = new Set();
  for (const [osmId, occurrences] of occurrencesByOsmId) {
    const distinctWays = new Set(occurrences.map((occurrence) => String(occurrence.fragment.way.id)));
    if (distinctWays.size < 2) continue;
    const crossingWays = [...new Map(occurrences.map((occurrence) => [String(occurrence.fragment.way.id), occurrence.fragment.way])).values()];
    if (crossingWays.some((first, index) => crossingWays.slice(index + 1).some((second) => wayIsGradeSeparated(first, second)))) continue;
    const sectors = new Set();
    for (const occurrence of occurrences) {
      const { fragment, index, vertex } = occurrence;
      for (const neighbor of [fragment.vertices[index - 1], fragment.vertices[index + 1]]) {
        if (!neighbor) continue;
        const dx = (neighbor.lng - vertex.lng) * metersPerDegreeLng;
        const dy = (neighbor.lat - vertex.lat) * 111_320;
        sectors.add(Math.round((((Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360) / 22.5)) % 16);
      }
    }
    const point = { lat: occurrences[0].vertex.lat, lng: occurrences[0].vertex.lng };
    if (sectors.size < 3) {
      const rays = [];
      for (const occurrence of occurrences) {
        const { fragment, index, vertex } = occurrence;
        for (const neighbor of [fragment.vertices[index - 1], fragment.vertices[index + 1]]) if (neighbor) {
          rays.push([(neighbor.lng - vertex.lng) * metersPerDegreeLng, (neighbor.lat - vertex.lat) * 111_320]);
        }
      }
      let turnDegrees = 0;
      for (let left = 0; left < rays.length; left++) for (let right = left + 1; right < rays.length; right++) {
        const cosine = Math.max(-1, Math.min(1, (rays[left][0] * rays[right][0] + rays[left][1] * rays[right][1]) / (Math.hypot(...rays[left]) * Math.hypot(...rays[right]))));
        turnDegrees = Math.max(turnDegrees, 180 - Math.acos(cosine) * 180 / Math.PI);
      }
      if (turnDegrees < 30) continue;
      const cornerId = `osm-corner-shared-${osmId}`;
      intersectionCoordinates.add(coordinateKey(point));
      for (const occurrence of occurrences) {
        const geometry = occurrence.fragment.vertices.slice(Math.max(0, occurrence.index - 2), occurrence.index + 3).map((vertex) => [vertex.lat, vertex.lng]);
        addCandidate(candidates, cornerId, 'corner', point,
          { wayId: String(occurrence.fragment.way.id), measure: occurrence.vertex.measure, point, geometry }, occurrence.fragment.way,
          { turnDegrees: Math.round(turnDegrees) });
      }
      continue;
    }
    const candidate = addCandidate(candidates, `osm-junction-${osmId}`, 'intersection', point, null, null, { distinctRoadCount: distinctWays.size, directionCount: sectors.size });
    intersectionCoordinates.add(coordinateKey(point));
    for (const occurrence of occurrences) {
      const fragment = occurrence.fragment;
      const geometry = fragment.vertices.slice(Math.max(0, occurrence.index - 2), occurrence.index + 3).map((vertex) => [vertex.lat, vertex.lng]);
      const hit = { wayId: String(fragment.way.id), measure: occurrence.vertex.measure, point, geometry };
      addCandidate(candidates, candidate.id, 'intersection', point, hit, fragment.way);
    }
  }

  const toXY = (point) => [point.lng * metersPerDegreeLng, point.lat * 111_320];
  const buckets = new Map();
  const cellSize = 120;
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
    const segment = segments[segmentIndex];
    const a = toXY(segment.a), b = toXY(segment.b);
    segment.xyA = a; segment.xyB = b;
    const minX = Math.floor(Math.min(a[0], b[0]) / cellSize), maxX = Math.floor(Math.max(a[0], b[0]) / cellSize);
    const minY = Math.floor(Math.min(a[1], b[1]) / cellSize), maxY = Math.floor(Math.max(a[1], b[1]) / cellSize);
    if ((maxX - minX + 1) * (maxY - minY + 1) > 300) continue;
    for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) {
      const key = `${x}:${y}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(segmentIndex);
    }
  }
  const checked = new Set();
  for (const bucket of buckets.values()) {
    for (let left = 0; left < bucket.length; left++) for (let right = left + 1; right < bucket.length; right++) {
      const firstIndex = bucket[left], secondIndex = bucket[right];
      const pair = firstIndex < secondIndex ? `${firstIndex}:${secondIndex}` : `${secondIndex}:${firstIndex}`;
      if (checked.has(pair)) continue;
      checked.add(pair);
      const first = segments[firstIndex], second = segments[secondIndex];
      if (String(first.fragment.way.id) === String(second.fragment.way.id) || wayIsGradeSeparated(first.fragment.way, second.fragment.way)) continue;
      const hit = segmentIntersection(first.xyA, first.xyB, second.xyA, second.xyB);
      if (!hit) continue;
      const point = { lat: hit.point[1] / 111_320, lng: hit.point[0] / metersPerDegreeLng };
      if (!pointInPolygon([point.lng, point.lat], polygon)) continue;
      const pointKey = coordinateKey(point);
      if (intersectionCoordinates.has(pointKey) && !candidates.has(`osm-crossing-${pointKey}`)) continue;
      const firstMeasure = first.a.measure + (first.b.measure - first.a.measure) * hit.t;
      const secondMeasure = second.a.measure + (second.b.measure - second.a.measure) * hit.u;
      const id = `osm-crossing-${pointKey}`;
      addCandidate(candidates, id, 'intersection', point, { wayId: String(first.fragment.way.id), measure: firstMeasure, point, geometry: [[first.a.lat, first.a.lng], [point.lat, point.lng], [first.b.lat, first.b.lng]] }, first.fragment.way);
      addCandidate(candidates, id, 'intersection', point, { wayId: String(second.fragment.way.id), measure: secondMeasure, point, geometry: [[second.a.lat, second.a.lng], [point.lat, point.lng], [second.b.lat, second.b.lng]] }, second.fragment.way);
      intersectionCoordinates.add(coordinateKey(point));
    }
  }

  for (const fragment of fragments) {
    const vertices = fragment.vertices;
    for (let index = 1; index < vertices.length - 1; index++) {
      const previous = vertices[index - 1], point = vertices[index], next = vertices[index + 1];
      if (!point.osmId || intersectionCoordinates.has(coordinateKey(point))) continue;
      if (metersBetween(previous, point, metersPerDegreeLng) < 4 || metersBetween(point, next, metersPerDegreeLng) < 4) continue;
      const first = [(previous.lng - point.lng) * metersPerDegreeLng, (previous.lat - point.lat) * 111_320];
      const second = [(next.lng - point.lng) * metersPerDegreeLng, (next.lat - point.lat) * 111_320];
      const cosine = Math.max(-1, Math.min(1, (first[0] * second[0] + first[1] * second[1]) / (Math.hypot(...first) * Math.hypot(...second))));
      const deflection = 180 - Math.acos(cosine) * 180 / Math.PI;
      if (deflection < 30) continue;
      const geometry = [[previous.lat, previous.lng], [point.lat, point.lng], [next.lat, next.lng]];
      addCandidate(candidates, `osm-corner-${fragment.way.id}-${point.osmId}`, 'corner', point,
        { wayId: String(fragment.way.id), measure: point.measure, point, geometry }, fragment.way, { turnDegrees: Math.round(deflection) });
    }
  }
  return { candidates: [...candidates.values()], metersPerDegreeLng };
}

function candidateForAI(candidate) {
  return {
    id: candidate.id,
    kind: candidate.kind,
    latitude: candidate.lat,
    longitude: candidate.lng,
    geometryEvidence: candidate.evidence,
    roads: [...candidate.roads.values()].slice(0, 6),
    nearbyRoadGeometry: candidate.hits.slice(0, 8).map((hit) => ({ roadId: hit.wayId, coordinates: hit.geometry }))
  };
}

async function haveAIReviewCandidates(candidates) {
  if (!candidates.length) return new Set();
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error('OpenAI analysis is not configured on the server. Add OPENAI_API_KEY to the deployment environment.');
  const batches = [];
  for (let offset = 0; offset < candidates.length; offset += aiBatchSize) batches.push(candidates.slice(offset, offset + aiBatchSize));
  const approved = new Set();
  let cursor = 0;
  let failure = null;
  async function worker() {
    while (!failure) {
      const batchIndex = cursor++;
      const batch = batches[batchIndex];
      if (!batch) return;
      let response;
      try {
        response = await fetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-4.1-mini',
            instructions: 'You are reviewing only OpenStreetMap geometry candidates from one user-drawn polygon. Return IDs only for genuine road intersections where distinct roads meet at grade, or for clear route corners where a road changes direction. Reject straight way seams, slight geometry noise, and grade-separated crossings. Do not invent, alter, or return IDs that are not in this batch. OSM road names may be absent; use geometry and supplied tags.',
            input: JSON.stringify({ candidates: batch.map(candidateForAI) }),
            text: { format: { type: 'json_schema', name: 'selected_osm_points', strict: true, schema: {
              type: 'object', additionalProperties: false,
              properties: { accepted_ids: { type: 'array', items: { type: 'string' } } },
              required: ['accepted_ids']
            } } }
          }),
          signal: AbortSignal.timeout(aiTimeoutMs)
        });
      } catch {
        failure = 'OpenAI could not review the selected OSM area in time. The map was not changed; try a smaller selection.';
        return;
      }
      if (!response.ok) {
        const details = await response.text().catch(() => '');
        console.error('Selected-area OpenAI review failed', response.status, details.slice(0, 350));
        failure = response.status === 401 || response.status === 403
          ? 'OpenAI rejected the server API key. Check OPENAI_API_KEY.'
          : 'OpenAI could not review the selected OSM area right now. Try again shortly.';
        return;
      }
      let parsed;
      try {
        const result = await response.json();
        const outputText = result.output_text || result.output?.flatMap((item) => item.content || []).find((item) => item.type === 'output_text')?.text;
        parsed = JSON.parse(outputText || '');
      } catch {
        failure = 'OpenAI returned an invalid OSM point review. The map was not changed.';
        return;
      }
      const valid = new Set(batch.map((candidate) => candidate.id));
      for (const id of parsed.accepted_ids || []) if (valid.has(id)) approved.add(id);
    }
  }
  await Promise.all(Array.from({ length: Math.min(aiConcurrency, batches.length) }, worker));
  if (failure) throw new Error(failure);
  return approved;
}

function roadType(way) {
  const highway = String(way.tags?.highway || '');
  if (['footway', 'pedestrian', 'steps', 'corridor'].includes(highway)) return 'foot';
  if (['cycleway', 'path', 'bridleway', 'track'].includes(highway)) return 'moto';
  return 'main';
}

function roadName(way) { return String(way.tags?.name || way.tags?.ref || way.tags?.highway || 'Street').slice(0, 80); }

function buildGeneratedGraph(fragments, candidates, approvedIds, metersPerDegreeLng) {
  const accepted = candidates.filter((candidate) => approvedIds.has(candidate.id));
  const candidateHitsByWay = new Map();
  for (const candidate of accepted) for (const hit of candidate.hits) {
    if (!candidateHitsByWay.has(hit.wayId)) candidateHitsByWay.set(hit.wayId, []);
    candidateHitsByWay.get(hit.wayId).push({ ...hit, nodeId: candidate.id, kind: candidate.kind, name: [...candidate.roads.values()].map((road) => road.name).slice(0, 2).join(' / ') || (candidate.kind === 'corner' ? 'Road corner' : 'Street intersection') });
  }
  const nodes = new Map();
  const edges = [];
  const addNode = (id, point, name, kind, osmId = null) => {
    if (!nodes.has(id)) nodes.set(id, { id, osmId, name, lat: point.lat, lng: point.lng, kind, weight: 0, source: 'openstreetmap' });
    return id;
  };
  for (let partIndex = 0; partIndex < fragments.length; partIndex++) {
    const fragment = fragments[partIndex];
    const way = fragment.way;
    const wayId = String(way.id);
    const vertices = fragment.vertices;
    const first = vertices[0], last = vertices.at(-1);
    const endpoint = (point) => {
      const isWayEnd = point.osmId && (point.measure < 1e-8 || point.measure > way.nodes.length - 1 - 1e-8);
      const id = point.osmId ? `osm-endpoint-${point.osmId}` : `osm-area-boundary-${coordinateKey(point)}`;
      const name = isWayEnd ? `${roadName(way)} endpoint` : 'Selected area boundary';
      return addNode(id, point, name, 'endpoint', point.osmId || null);
    };
    const splits = [
      { measure: first.measure, point: first, nodeId: endpoint(first), kind: 'endpoint' },
      { measure: last.measure, point: last, nodeId: endpoint(last), kind: 'endpoint' }
    ];
    for (const hit of candidateHitsByWay.get(wayId) || []) {
      if (hit.measure < first.measure - 1e-7 || hit.measure > last.measure + 1e-7) continue;
      const point = hit.point;
      addNode(hit.nodeId, point, hit.name, hit.kind, hit.nodeId.startsWith('osm-junction-') ? hit.nodeId.slice('osm-junction-'.length) : null);
      splits.push({ measure: hit.measure, point, nodeId: hit.nodeId, kind: hit.kind });
    }
    splits.sort((a, b) => a.measure - b.measure);
    const unique = [];
    for (const split of splits) {
      const previous = unique.at(-1);
      if (previous && Math.abs(previous.measure - split.measure) < 1e-6) {
        if (split.kind === 'intersection' || (split.kind === 'corner' && previous.kind === 'endpoint')) unique[unique.length - 1] = split;
      } else unique.push(split);
    }
    for (let index = 0; index < unique.length - 1; index++) {
      const from = unique[index], to = unique[index + 1];
      if (from.nodeId === to.nodeId || to.measure - from.measure < 1e-8) continue;
      const points = [[from.point.lat, from.point.lng]];
      for (const vertex of vertices) if (vertex.measure > from.measure + 1e-7 && vertex.measure < to.measure - 1e-7) points.push([vertex.lat, vertex.lng]);
      points.push([to.point.lat, to.point.lng]);
      const compact = points.filter((point, pointIndex) => pointIndex === 0 || metersBetween({ lat: points[pointIndex - 1][0], lng: points[pointIndex - 1][1] }, { lat: point[0], lng: point[1] }, metersPerDegreeLng) >= .01);
      if (compact.length < 2) continue;
      let fromId = from.nodeId, toId = to.nodeId;
      const reverse = String(way.tags?.oneway || '').toLowerCase() === '-1';
      if (reverse) { [fromId, toId] = [toId, fromId]; compact.reverse(); }
      const oneway = ['yes', '1', '-1', 'true'].includes(String(way.tags?.oneway || '').toLowerCase()) || way.tags?.junction === 'roundabout';
      edges.push({
        id: `osm-selection-edge-${wayId}-${partIndex}-${fromId}-${toId}`,
        from: fromId,
        to: toId,
        name: roadName(way),
        type: roadType(way),
        weight: 0,
        points: compact,
        oneway,
        source: 'openstreetmap',
        osmId: wayId
      });
    }
  }
  const usedNodeIds = new Set(edges.flatMap((edge) => [edge.from, edge.to]));
  const nodeItems = [...nodes.values()].filter((node) => usedNodeIds.has(node.id));
  return {
    nodes: nodeItems,
    edges,
    intersections: nodeItems.filter((node) => node.kind === 'intersection').length,
    corners: nodeItems.filter((node) => node.kind === 'corner').length,
    boundaryPoints: nodeItems.filter((node) => node.name === 'Selected area boundary').length
  };
}

export async function POST(request) {
  const token = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return jsonError('Sign in before analyzing a selected area.', 401);
  let userId;
  try { userId = await identifyUser(token); }
  catch (error) { return jsonError(error.message, 503); }
  if (!userId) return jsonError('Sign in again before analyzing a selected area.', 401);
  if (!withinRateLimit(userId)) return jsonError('The selected-area analysis limit was reached. Try again in an hour.', 429);
  if (!process.env.OPENAI_API_KEY?.trim()) return jsonError('OpenAI analysis is not configured on the server. Add OPENAI_API_KEY to the deployment environment.', 503);

  let body;
  try { body = await request.json(); }
  catch { return jsonError('Draw a valid outline around the map area first.', 400); }
  const polygon = validateOutline(body?.polygon);
  if (!polygon) return jsonError(`Draw a non-crossing area outline with 3–${maxOutlinePoints} corners.`, 400);

  let ways;
  let server;
  try { ({ ways, server } = await loadSelectedRoadWays(polygon)); }
  catch (error) { return jsonError(error.message || 'OpenStreetMap did not return roads for this selection.', 502); }
  if (!ways.length) return Response.json({ nodes: [], edges: [], intersections: 0, corners: 0, summary: 'OpenStreetMap has no mapped roads inside this outline.' }, { headers: { 'Cache-Control': 'no-store' } });

  const { fragments, metersPerDegreeLng } = clipRoadsToPolygon(ways, polygon);
  if (!fragments.length) return Response.json({ nodes: [], edges: [], intersections: 0, corners: 0, summary: 'No routable OSM road geometry falls inside this outline.' }, { headers: { 'Cache-Control': 'no-store' } });

  const { candidates } = buildCandidateJunctions(fragments, polygon, metersPerDegreeLng);
  let approvedIds;
  try { approvedIds = await haveAIReviewCandidates(candidates); }
  catch (error) { return jsonError(`${error.message || 'OpenAI could not review the OSM selection.'} No map changes were made.`, 502); }
  const graph = buildGeneratedGraph(fragments, candidates, approvedIds, metersPerDegreeLng);
  const selectionKey = polygon.map((point) => `${point[0].toFixed(5)},${point[1].toFixed(5)}`).join('|');
  return Response.json({
    ...graph,
    selectionKey,
    osmServer: server,
    summary: `Analyzed only the selected polygon using ${server}. OpenAI approved ${graph.intersections} intersections and ${graph.corners} corners; created ${graph.nodes.length} nodes and ${graph.edges.length} clipped OSM edges.`
  }, { headers: { 'Cache-Control': 'no-store' } });
}
