(() => {
  'use strict';

  const bridge = window.rescueRouteMapBridge;
  const selectButton = document.getElementById('draw-osm-area');
  const analyzeButton = document.getElementById('analyze-selected-osm-area');
  const clearButton = document.getElementById('clear-osm-area');
  if (!bridge || !selectButton || !analyzeButton || !clearButton) return;

  const { map, L } = bridge;
  const selectionLayer = L.layerGroup().addTo(map);
  const outline = [];
  let drawing = false;
  let analyzing = false;
  const maxCorners = 60;

  function renderOutline() {
    selectionLayer.clearLayers();
    const coordinates = outline.map((point) => [point.lat, point.lng]);
    if (coordinates.length >= 3) {
      L.polygon(coordinates, {
        color: '#135fd1',
        weight: 3,
        opacity: .95,
        fillColor: '#3182f6',
        fillOpacity: .12,
        dashArray: '8 6',
        interactive: false
      }).addTo(selectionLayer);
    } else if (coordinates.length === 2) {
      L.polyline(coordinates, { color: '#135fd1', weight: 3, dashArray: '8 6', interactive: false }).addTo(selectionLayer);
    }
    for (const point of outline) {
      L.circleMarker([point.lat, point.lng], {
        radius: 5,
        color: '#fff',
        weight: 2,
        fillColor: '#135fd1',
        fillOpacity: 1,
        interactive: false
      }).addTo(selectionLayer);
    }
    analyzeButton.disabled = analyzing || outline.length < 3;
    clearButton.hidden = outline.length === 0;
    selectButton.disabled = analyzing;
    selectButton.textContent = drawing ? 'Finish drawing' : outline.length ? 'Continue selection' : 'Select OSM area';
  }

  function addOutlinePoint(value) {
    if (!drawing || analyzing || !Number.isFinite(value?.lat) || !Number.isFinite(value?.lng)) return;
    if (outline.length >= maxCorners) {
      bridge.setStatus(`This outline has reached ${maxCorners} corners. Finish it or clear it to redraw.`);
      bridge.setAreaToolActive(false);
      return;
    }
    const previous = outline.at(-1);
    if (previous && map.distance([previous.lat, previous.lng], [value.lat, value.lng]) < 2) return;
    outline.push({ lat: value.lat, lng: value.lng });
    renderOutline();
    bridge.setStatus(outline.length < 3
      ? `Area corner ${outline.length} added. Add ${3 - outline.length} more corner${outline.length === 1 ? 's' : ''}.`
      : `Selected area outlined with ${outline.length} corners. Finish drawing, then analyze only this OSM area.`);
  }

  function setDrawing(active) {
    if (analyzing) return;
    drawing = Boolean(active);
    bridge.setAreaToolActive(drawing);
    renderOutline();
    if (drawing) bridge.setStatus(outline.length
      ? 'Click the map to add more corners to this OSM selection. Click Finish drawing when it is ready.'
      : 'Click around the exact streets to outline the OSM area. Add at least three corners.');
    else if (outline.length >= 3) bridge.setStatus(`Area ready: ${outline.length} corners. Analyze to fetch roads clipped to this polygon.`);
    else bridge.setStatus('Add at least three corners to finish this OSM selection.');
  }

  function clearSelection() {
    if (analyzing) return;
    drawing = false;
    outline.length = 0;
    bridge.setAreaToolActive(false);
    renderOutline();
    bridge.setStatus('Area outline cleared.');
  }

  function explainResponse(payload, fallback) {
    const detail = payload?.error;
    if (typeof detail === 'string' && detail.trim()) return detail;
    return fallback;
  }

  selectButton.addEventListener('click', () => setDrawing(!drawing));
  clearButton.addEventListener('click', clearSelection);
  map.on('click', (event) => addOutlinePoint(event.latlng));
  window.addEventListener('rescue:osm-area-point', (event) => addOutlinePoint(event.detail));
  window.addEventListener('rescue:osm-area-mode', (event) => {
    if (event.detail?.active || !drawing) return;
    drawing = false;
    renderOutline();
  });

  analyzeButton.addEventListener('click', async () => {
    if (analyzing || outline.length < 3) return;
    if (!bridge.canSaveMap()) {
      bridge.setStatus('Sign in and wait for Firebase to finish syncing before analyzing an OSM area.');
      return;
    }
    const polygon = outline.map(({ lat, lng }) => [lat, lng]);
    analyzing = true;
    drawing = false;
    bridge.setAreaToolActive(false);
    analyzeButton.disabled = true;
    analyzeButton.textContent = 'Loading selected OSM roads…';
    selectButton.disabled = true;
    clearButton.disabled = true;
    bridge.setStatus('Requesting roads inside the outlined polygon, clipping their geometry to the selection, then asking AI to verify intersections and corners…');
    try {
      const token = await bridge.getIdToken();
      const response = await fetch('/api/map/selected-area', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ polygon })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(explainResponse(result, `Selected-area analysis failed (HTTP ${response.status}).`));
      if (result.nodes?.length || result.edges?.length) await bridge.addOSMGraph(result);
      bridge.setStatus(result.summary || `Created ${result.nodes?.length || 0} nodes and ${result.edges?.length || 0} edges from this OSM selection.`);
      outline.length = 0;
      selectionLayer.clearLayers();
    } catch (error) {
      bridge.setStatus(error?.message || 'The selected OSM area could not be analyzed. The map was not changed.');
    } finally {
      analyzing = false;
      analyzeButton.textContent = 'Analyze intersections with AI';
      clearButton.disabled = false;
      renderOutline();
    }
  });

  renderOutline();
})();
