export const runtime = 'nodejs';
export const maxDuration = 240;

const maxPoints = 20;
const maxWays = 500;
const maxWayNodes = 12_000;
const analysesPerHour = 12;
const rateWindowMs = 60 * 60 * 1000;
const analysisTimes = new Map();
const overpassEndpoints = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass-api.de/api/interpreter'
];

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

function pointInPolygon(point, polygon) {
  const [lng, lat] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const crosses = ((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (crosses) inside = !inside;
  }
  return inside;
}

function validatePolygon(value) {
  if (!Array.isArray(value) || value.length < 3 || value.length > maxPoints) return null;
  const polygon = value.map((point) => {
    if (!Array.isArray(point) || point.length !== 2) return null;
    const [lat, lng] = point;
    return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 85 && Math.abs(lng) <= 180
      ? [lng, lat]
      : null;
  });
  if (polygon.some((point) => !point)) return null;

  const lats = polygon.map((point) => point[1]);
  const lngs = polygon.map((point) => point[0]);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const widthMeters = (Math.max(...lngs) - Math.min(...lngs)) * 111_320 * Math.cos(midLat * Math.PI / 180);
  const heightMeters = (Math.max(...lats) - Math.min(...lats)) * 111_320;
  let twiceArea = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [x1, y1] = polygon[i];
    const [x2, y2] = polygon[(i + 1) % polygon.length];
    twiceArea += x1 * y2 - x2 * y1;
  }
  const areaMeters = Math.abs(twiceArea / 2) * 111_320 * 111_320 * Math.cos(midLat * Math.PI / 180);
  if (widthMeters > 3_000 || heightMeters > 3_000 || areaMeters > 6_000_000) return null;
  return polygon;
}

async function fetchRoads(polygon) {
  const south=Math.min(...polygon.map((point)=>point[1])),north=Math.max(...polygon.map((point)=>point[1]));
  const west=Math.min(...polygon.map((point)=>point[0])),east=Math.max(...polygon.map((point)=>point[0]));
  const query = `[out:json][timeout:18];way["highway"](${south.toFixed(6)},${west.toFixed(6)},${north.toFixed(6)},${east.toFixed(6)});out body geom;`;
  const failures = [];
  for (const endpoint of overpassEndpoints) {
    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'User-Agent': 'RescueRoute/1.0 (OpenStreetMap map analysis)' },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(20_000)
      });
    } catch (error) {
      failures.push(`${new URL(endpoint).host}: ${error?.name === 'TimeoutError' ? 'timeout' : 'network error'}`);
      continue;
    }
    if (!response.ok) {
      failures.push(`${new URL(endpoint).host}: HTTP ${response.status}`);
      if (response.status >= 400 && response.status < 500 && ![406, 408, 413, 425, 429].includes(response.status)) {
        throw new Error(`OpenStreetMap rejected this selection (HTTP ${response.status}). Try drawing a smaller area.`);
      }
      continue;
    }
    let data;
    try {
      data = await response.json();
    } catch {
      failures.push(`${new URL(endpoint).host}: invalid response`);
      continue;
    }
    if(data.remark){failures.push(`${new URL(endpoint).host}: ${String(data.remark).slice(0,120)}`);continue;}
    const ways = (data.elements ?? []).filter((element) => element.type === 'way' && Array.isArray(element.nodes) && Array.isArray(element.geometry));
    const nodeCount = ways.reduce((sum, way) => sum + way.nodes.length, 0);
    if (ways.length > maxWays || nodeCount > maxWayNodes) throw new Error('This area has too many streets to analyze at once. Select a smaller area.');
    return ways;
  }
  console.error('All OpenStreetMap road-data endpoints failed', failures);
  if (failures.some((failure) => failure.includes('HTTP 429'))) throw new Error('OpenStreetMap is busy. Try again shortly.');
  throw new Error(`OpenStreetMap road servers did not return data (${failures.join('; ')}).`);
}

function classifyRoadType(highway = '') {
  if (['footway', 'pedestrian', 'steps', 'corridor'].includes(highway)) return 'foot';
  if (['cycleway', 'path', 'bridleway', 'track'].includes(highway)) return 'moto';
  return 'main';
}

function wayIsGradeSeparated(first, second) {
  const firstLayer = Number(first.tags?.layer || 0);
  const secondLayer = Number(second.tags?.layer || 0);
  if (firstLayer !== secondLayer) return true;
  const yes = (value) => !['', 'no', '0', 'false'].includes(String(value || '').toLowerCase());
  if (yes(first.tags?.bridge) !== yes(second.tags?.bridge)) return true;
  if (yes(first.tags?.tunnel) !== yes(second.tags?.tunnel)) return true;
  return false;
}

function segmentCrossing(a, b, c, d) {
  const rx = b.x - a.x, ry = b.y - a.y;
  const sx = d.x - c.x, sy = d.y - c.y;
  const denominator = rx * sy - ry * sx;
  if (Math.abs(denominator) < 1e-7) return null;
  const qx = c.x - a.x, qy = c.y - a.y;
  const t = (qx * sy - qy * sx) / denominator;
  const u = (qx * ry - qy * rx) / denominator;
  const epsilon = 1e-8;
  if (t < -epsilon || t > 1 + epsilon || u < -epsilon || u > 1 + epsilon) return null;
  return { t: Math.max(0, Math.min(1, t)), u: Math.max(0, Math.min(1, u)), x: a.x + t * rx, y: a.y + t * ry };
}

function buildStreetGraph(ways, polygon) {
  const membership = new Map();
  const positions = new Map();
  const midLat = polygon.reduce((sum, point) => sum + point[1], 0) / polygon.length;
  const metersPerDegreeLng = 111_320 * Math.cos(midLat * Math.PI / 180);
  const toXY = (point) => ({ x: point.lon * metersPerDegreeLng, y: point.lat * 111_320 });
  const inArea = (point) => pointInPolygon([point.lng, point.lat], polygon);

  for (const way of ways) {
    const length = Math.min(way.nodes.length, way.geometry.length);
    for (let index = 0; index < length; index++) {
      const id = String(way.nodes[index]);
      const point = way.geometry[index];
      if (!Number.isFinite(point?.lat) || !Number.isFinite(point?.lon)) continue;
      positions.set(id, { lat: point.lat, lng: point.lon });
      if (!membership.has(id)) membership.set(id, new Set());
      membership.get(id).add(String(way.id));
    }
  }

  // OSM intersections normally share a node ID. Also catch at-grade crossings
  // whose ways cross geometrically but have not been split at a shared OSM node.
  const segments = [];
  const cells = new Map();
  const cellSize = 200;
  for (const way of ways) {
    for (let index = 0; index < Math.min(way.nodes.length, way.geometry.length) - 1; index++) {
      const start = way.geometry[index], end = way.geometry[index + 1];
      if (![start?.lat, start?.lon, end?.lat, end?.lon].every(Number.isFinite)) continue;
      const segment = { way, index, start: toXY({ lat: start.lat, lon: start.lon }), end: toXY({ lat: end.lat, lon: end.lon }), a: start, b: end };
      const segmentIndex = segments.push(segment) - 1;
      const minX = Math.floor(Math.min(segment.start.x, segment.end.x) / cellSize);
      const maxX = Math.floor(Math.max(segment.start.x, segment.end.x) / cellSize);
      const minY = Math.floor(Math.min(segment.start.y, segment.end.y) / cellSize);
      const maxY = Math.floor(Math.max(segment.start.y, segment.end.y) / cellSize);
      for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) {
        const key = `${x}:${y}`;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(segmentIndex);
      }
    }
  }

  const crossingByCoordinate = new Map();
  const checkedPairs = new Set();
  const coordinateKey = (point) => `${point.lat.toFixed(7)},${point.lng.toFixed(7)}`;
  for (const bucket of cells.values()) {
    for (let left = 0; left < bucket.length; left++) for (let right = left + 1; right < bucket.length; right++) {
      const firstIndex = bucket[left], secondIndex = bucket[right];
      const pairKey = firstIndex < secondIndex ? `${firstIndex}:${secondIndex}` : `${secondIndex}:${firstIndex}`;
      if (checkedPairs.has(pairKey)) continue;
      checkedPairs.add(pairKey);
      const first = segments[firstIndex], second = segments[secondIndex];
      if (String(first.way.id) === String(second.way.id) || wayIsGradeSeparated(first.way, second.way)) continue;
      const firstNodeIds = [String(first.way.nodes[first.index]), String(first.way.nodes[first.index + 1])];
      const secondNodeIds = [String(second.way.nodes[second.index]), String(second.way.nodes[second.index + 1])];
      if (firstNodeIds.some((id) => secondNodeIds.includes(id))) continue;
      const crossing = segmentCrossing(first.start, first.end, second.start, second.end);
      if (!crossing) continue;
      const point = { lat: crossing.y / 111_320, lng: crossing.x / metersPerDegreeLng };
      if (!inArea(point)) continue;
      const key = coordinateKey(point);
      if (!crossingByCoordinate.has(key)) crossingByCoordinate.set(key, { key, point, hits: [] });
      const record = crossingByCoordinate.get(key);
      record.hits.push({ wayId: String(first.way.id), at: first.index + crossing.t }, { wayId: String(second.way.id), at: second.index + crossing.u });
    }
  }

  const nodesById = new Map();
  const waysById = new Map(ways.map((way) => [String(way.id), way]));
  const splitsByWay = new Map(ways.map((way) => [String(way.id), []]));
  const addNode = (id, point, name, kind, osmId = null) => {
    if (!nodesById.has(id)) nodesById.set(id, { id, osmId, name, lat: point.lat, lng: point.lng, kind, weight: 0, source: 'openstreetmap' });
    else if (kind === 'intersection' && nodesById.get(id).kind !== 'intersection') {
      nodesById.get(id).name = name;
      nodesById.get(id).kind = 'intersection';
      nodesById.get(id).osmId ||= osmId;
    }
    return nodesById.get(id);
  };
  const crossingNodeId = (point) => {
    const crossing = crossingByCoordinate.get(coordinateKey(point));
    return crossing ? `osm-crossing-${crossing.key}` : null;
  };
  const addSplit = (way, at, nodeId, point) => splitsByWay.get(String(way.id)).push({ at, nodeId, point });
  const roadNames = new Map();
  for (const way of ways) {
    const name = String(way.tags?.name || way.tags?.ref || '').trim();
    if (!name) continue;
    for (const rawId of way.nodes) {
      const id = String(rawId);
      if (!roadNames.has(id)) roadNames.set(id, new Set());
      roadNames.get(id).add(name);
    }
  }

  for (const [id, wayIds] of membership) {
    const point = positions.get(id);
    if (wayIds.size < 2 || !point || !inArea(point)) continue;
    const directions = new Set();
    for (const wayId of wayIds) {
      const way = waysById.get(wayId);
      if (!way) continue;
      way.nodes.forEach((nodeId, index) => {
        if (String(nodeId) !== id) return;
        for (const neighborIndex of [index - 1, index + 1]) {
          const neighbor = way.geometry[neighborIndex];
          if (!neighbor || !Number.isFinite(neighbor.lat) || !Number.isFinite(neighbor.lon)) continue;
          const dx = (neighbor.lon - point.lng) * metersPerDegreeLng;
          const dy = (neighbor.lat - point.lat) * 111_320;
          const bearing = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
          directions.add(Math.round(bearing / 20) % 18);
        }
      });
    }
    // A straight join between two OSM ways is a road seam, not an intersection.
    if (directions.size < 3) continue;
    const graphId = crossingNodeId(point) || `osm-node-${id}`;
    const names = [...(roadNames.get(id) || [])].slice(0, 2);
    addNode(graphId, point, names.length ? names.join(' / ') : 'Street intersection', 'intersection', id);
    for (const wayId of wayIds) {
      const way = waysById.get(wayId);
      if (!way) continue;
      way.nodes.forEach((nodeId, index) => { if (String(nodeId) === id) addSplit(way, index, graphId, point); });
    }
  }

  for (const way of ways) {
    const lastIndex = Math.min(way.nodes.length, way.geometry.length) - 1;
    for (const index of [0, lastIndex]) {
      if (index < 0) continue;
      const rawId = String(way.nodes[index]);
      const point = positions.get(rawId);
      if (!point || !inArea(point)) continue;
      const graphId = crossingNodeId(point) || `osm-node-${rawId}`;
      const roadName = String(way.tags?.name || way.tags?.ref || 'Street').trim();
      addNode(graphId, point, `${roadName} endpoint`, 'endpoint', rawId);
      addSplit(way, index, graphId, point);
    }
  }

  for (const crossing of crossingByCoordinate.values()) {
    const id = `osm-crossing-${crossing.key}`;
    addNode(id, crossing.point, 'Street intersection', 'intersection');
    for (const hit of crossing.hits) {
      const way = waysById.get(hit.wayId);
      if (way) addSplit(way, hit.at, id, crossing.point);
    }
  }

  const edges = [];
  for (const way of ways) {
    const ordered = splitsByWay.get(String(way.id)).sort((a, b) => a.at - b.at);
    const splits = [];
    for (const split of ordered) {
      const previous = splits.at(-1);
      if (previous && (Math.abs(previous.at - split.at) < 1e-7 || previous.nodeId === split.nodeId)) {
        if (split.nodeId.startsWith('osm-crossing-')) splits[splits.length - 1] = split;
        continue;
      }
      splits.push(split);
    }
    for (let index = 0; index < splits.length - 1; index++) {
      const from = splits[index], to = splits[index + 1];
      if (from.nodeId === to.nodeId) continue;
      const points = [[from.point.lat, from.point.lng]];
      for (let vertex = Math.floor(from.at) + 1; vertex <= Math.floor(to.at); vertex++) {
        const point = way.geometry[vertex];
        if (point && Number.isFinite(point.lat) && Number.isFinite(point.lon)) points.push([point.lat, point.lon]);
      }
      points.push([to.point.lat, to.point.lng]);
      const compactPoints = points.filter((point, pointIndex) => pointIndex === 0 || point[0] !== points[pointIndex - 1][0] || point[1] !== points[pointIndex - 1][1]);
      if (compactPoints.length < 2) continue;
      let fromId = from.nodeId, toId = to.nodeId;
      const reverseOneWay = String(way.tags?.oneway || '').toLowerCase() === '-1';
      if (reverseOneWay) { [fromId, toId] = [toId, fromId]; compactPoints.reverse(); }
      const highway = String(way.tags?.highway || 'road');
      const oneWay = ['yes', '1', '-1', 'true'].includes(String(way.tags?.oneway || '').toLowerCase()) || way.tags?.junction === 'roundabout';
      edges.push({
        id: `osm-edge-${way.id}-${fromId}-${toId}-${index}`,
        from: fromId,
        to: toId,
        name: String(way.tags?.name || way.tags?.ref || highway).slice(0, 80),
        type: classifyRoadType(highway),
        weight: 0,
        points: compactPoints,
        oneway: oneWay,
        source: 'openstreetmap'
      });
    }
  }
  const nodes = [...nodesById.values()];
  return { nodes, edges, intersections: nodes.filter((node) => node.kind === 'intersection').length };
}

export async function POST(request) {
  const token = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return jsonError('Sign in before analyzing an area.', 401);

  let userId;
  try {
    userId = await verifyFirebaseToken(token);
  } catch (error) {
    return jsonError(error.message, 503);
  }
  if (!userId) return jsonError('Sign in before analyzing an area.', 401);
  if (!isWithinRateLimit(userId)) return jsonError('Area analysis limit reached. Try again later.', 429);

  let body;
  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (declaredLength > 32_000) return jsonError('Map selection is too large. Draw a simpler area outline.', 413);
  try {
    body = await request.json();
  } catch {
    return jsonError('Choose a valid map area to analyze.', 400);
  }
  const polygon = validatePolygon(body?.polygon);
  if (!polygon) return jsonError('Draw a smaller area with at least three corners.', 400);

  let ways;
  try {
    ways = await fetchRoads(polygon);
  } catch (error) {
    return jsonError(`${error.message || 'Could not load OpenStreetMap road data.'} No nodes were created because street intersections must come from OpenStreetMap data.`, 502);
  }
  if (!ways.length){
    return Response.json({ nodes: [], edges: [], intersections: 0, summary: 'No mapped streets were found inside the selected area.' }, { headers: { 'Cache-Control': 'no-store' } });
  }
  const graph = buildStreetGraph(ways, polygon);
  if (graph.nodes.length > 1_800 || graph.edges.length > 3_500) return jsonError('This area has too many streets to save as one graph. Select a smaller area.', 413);
  return Response.json({
    ...graph,
    summary: `OpenStreetMap has ${graph.intersections} road ${graph.intersections === 1 ? 'crossing' : 'crossings'} and ${graph.edges.length} connecting ${graph.edges.length === 1 ? 'edge' : 'edges'} in this area.`
  }, { headers: { 'Cache-Control': 'no-store' } });
}
