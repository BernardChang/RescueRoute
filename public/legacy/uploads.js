import { photoAdminEmail } from './photo-config.js';

const $ = (id) => document.getElementById(id);
const form = $('photo-upload-form');
const DATABASE_NAME = 'rescueroute-local-photos';
const STORE_NAME = 'photos';

function openPhotoDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('uploadedAt', 'uploadedAt');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Photo storage is busy in another tab.'));
  });
}

async function withPhotoStore(mode, operation) {
  const database = await openPhotoDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);
    let result;
    try { result = operation(store); }
    catch (error) { database.close(); reject(error); return; }
    transaction.oncomplete = () => { database.close(); resolve(result); };
    transaction.onerror = () => { database.close(); reject(transaction.error || new Error('Local photo storage failed.')); };
    transaction.onabort = () => { database.close(); reject(transaction.error || new Error('Local photo storage was interrupted.')); };
  });
}

function savePhoto(photo) {
  return withPhotoStore('readwrite', (store) => store.put(photo));
}
async function analyzePhoto(blob, activeUser) {
  if (!activeUser) throw new Error('Sign in again before analyzing a photo.');
  const token = await activeUser.getIdToken();
  const response = await fetch('/api/analyze', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': blob.type || 'application/octet-stream' },
    body: blob,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Photo analysis is temporarily unavailable.');
  const assessment = result.analysis;
  if (!assessment || typeof assessment.can_vehicles_pass !== 'boolean' ||
      typeof assessment.obstruction_exists !== 'boolean' || typeof assessment.dead_end !== 'boolean' ||
      !Array.isArray(assessment.obstructing_objects) ||
      (assessment.can_motorcycles_pass !== undefined && typeof assessment.can_motorcycles_pass !== 'boolean') ||
      (assessment.can_pedestrians_pass !== undefined && typeof assessment.can_pedestrians_pass !== 'boolean') ||
      (assessment.stairs_visible !== undefined && typeof assessment.stairs_visible !== 'boolean') ||
      (assessment.street_stalls_visible !== undefined && typeof assessment.street_stalls_visible !== 'boolean') ||
      (assessment.parked_vehicles_visible !== undefined && typeof assessment.parked_vehicles_visible !== 'boolean') ||
      (assessment.low_hanging_wires_visible !== undefined && typeof assessment.low_hanging_wires_visible !== 'boolean') ||
      (assessment.road_visible !== undefined && typeof assessment.road_visible !== 'boolean') ||
      (assessment.recommended_weight !== undefined && (!Number.isInteger(assessment.recommended_weight) || assessment.recommended_weight < 0 || assessment.recommended_weight > 10)) ||
      (assessment.weight_reason !== undefined && typeof assessment.weight_reason !== 'string')) {
    throw new Error('The photo assessment returned an invalid result. Please retry.');
  }
  return assessment;
}
function normalizeAssessment(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== 'object') return null;
  return typeof value.can_vehicles_pass === 'boolean' &&
    typeof value.obstruction_exists === 'boolean' && typeof value.dead_end === 'boolean' &&
    Array.isArray(value.obstructing_objects) ? value : null;
}
function renderAssessment(container, assessment) {
  const table = document.createElement('table'); table.className = 'assessment-table';
  const tbody = document.createElement('tbody');
  const rows = [
    ...(typeof assessment.road_visible === 'boolean' ? [['Is a road clearly visible?', assessment.road_visible]] : []),
    ['Can cars enter?', assessment.can_vehicles_pass],
    ...(typeof assessment.can_motorcycles_pass === 'boolean' ? [['Can motorcycles pass?', assessment.can_motorcycles_pass]] : []),
    ...(typeof assessment.can_pedestrians_pass === 'boolean' ? [['Can pedestrians pass?', assessment.can_pedestrians_pass]] : []),
    ['Is a path obstruction visible?', assessment.obstruction_exists],
    ...(typeof assessment.stairs_visible === 'boolean' ? [['Stairs visible?', assessment.stairs_visible]] : []),
    ...(typeof assessment.street_stalls_visible === 'boolean' ? [['Street stalls visible?', assessment.street_stalls_visible]] : []),
    ...(typeof assessment.parked_vehicles_visible === 'boolean' ? [['Parked vehicles visible?', assessment.parked_vehicles_visible]] : []),
    ...(typeof assessment.low_hanging_wires_visible === 'boolean' ? [['Low-hanging wires visible?', assessment.low_hanging_wires_visible]] : []),
    ['Dead end visible?', assessment.dead_end],
  ];
  rows.forEach(([label, answer]) => {
    const row = document.createElement('tr');
    const heading = document.createElement('th'); heading.scope = 'row'; heading.textContent = label;
    const value = document.createElement('td'); value.textContent = answer ? 'True' : 'False';
    row.append(heading, value); tbody.append(row);
  });
  if (Number.isInteger(assessment.recommended_weight)) {
    const row = document.createElement('tr');
    const heading = document.createElement('th'); heading.scope = 'row'; heading.textContent = 'Suggested map weight';
    const value = document.createElement('td'); value.textContent = `${assessment.recommended_weight}/10`;
    row.append(heading, value); tbody.append(row);
  }
  table.append(tbody); container.append(table);
  if (assessment.weight_reason) { const reason = document.createElement('p'); reason.className = 'map-weight-reason'; reason.textContent = assessment.weight_reason; container.append(reason); }
  if (assessment.access_level) { const access = document.createElement('p'); access.className = 'map-weight-reason'; access.textContent = `Access level: ${assessment.access_level.replaceAll('_', ' ')}.`; container.append(access); }

  const objectsHeading = document.createElement('strong');
  objectsHeading.className = 'assessment-objects-title';
  objectsHeading.textContent = 'Visible objects impeding the path';
  container.append(objectsHeading);
  const list = document.createElement('ul'); list.className = 'assessment-objects';
  assessment.obstructing_objects.forEach((objectName) => {
    const item = document.createElement('li'); item.textContent = objectName; list.append(item);
  });
  if (!assessment.obstructing_objects.length) {
    const item = document.createElement('li'); item.textContent = 'None visible'; list.append(item);
  }
  container.append(list);
}
function deletePhoto(id) {
  return withPhotoStore('readwrite', (store) => store.delete(id));
}
async function getPhotos() {
  const database = await openPhotoDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const request = transaction.objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt)));
    request.onerror = () => reject(request.error || new Error('Could not read local photos.'));
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => { database.close(); reject(transaction.error); };
  });
}

if (form) {
  const input = $('photo-files');
  const zone = $('drop-zone');
  const previews = $('upload-preview-list');
  const submit = $('upload-submit');
  const authNote = $('upload-auth-note');
  const adminGallery = $('admin-gallery');
  const locked = $('gallery-locked');
  const gallery = $('photo-gallery');
  const mapWeightFlow = $('map-weight-flow');
  const mapWeightPreview = $('map-weight-preview');
  const mapWeightStatus = $('map-weight-status');
  const mapWeightAssessment = $('map-weight-assessment');
  const mapWeightApply = $('map-weight-apply');
  const adminEmail = photoAdminEmail.trim().toLowerCase();
  let user = null;
  let selected = [];
  let busy = false;
  let galleryUrls = [];
  let mapWeightRequest = null;
  let mapWeightPreviewUrl = '';

  function status(element, text, error = false) {
    element.textContent = text;
    element.hidden = !text;
    element.classList.toggle('is-error', error);
  }
  function isAdmin() { return !!user?.email && !!adminEmail && user.email.toLowerCase() === adminEmail; }
  function updateAccess() {
    const admin = isAdmin();
    adminGallery.hidden = !admin;
    locked.hidden = admin;
    input.disabled = !user || busy;
    authNote.textContent = user
      ? `Signed in as ${user.email}. Photos are saved in this browser for the RescueRoute admin team.`
      : 'Sign in to submit a photo. Photos are saved on this device for the RescueRoute admin team.';
    submit.disabled = busy || !user || selected.length === 0;
    submit.innerHTML = busy ? 'Analyzing…' : 'Analyze & save <span>↗</span>';
    locked.querySelector('strong').textContent = 'Admin access only';
    locked.querySelector('p').textContent = 'Sign in with the authorized admin account on this device to view the local photo archive.';
    if (admin && user) loadGallery();
  }
  function clearPreviews() {
    previews.querySelectorAll('img[data-preview-url]').forEach((image) => URL.revokeObjectURL(image.dataset.previewUrl));
    previews.replaceChildren();
  }
  function renderPreviews() {
    clearPreviews();
    selected.forEach((file, index) => {
      const row = document.createElement('div'); row.className = 'upload-preview-row';
      const image = document.createElement('img'); image.alt = ''; image.dataset.previewUrl = URL.createObjectURL(file); image.src = image.dataset.previewUrl;
      const info = document.createElement('div'); info.className = 'upload-preview-info';
      const name = document.createElement('strong'); name.textContent = file.name;
      const size = document.createElement('small'); size.textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB`;
      info.append(name, size);
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remove-photo'; remove.setAttribute('aria-label', `Remove ${file.name}`); remove.textContent = '×';
      remove.addEventListener('click', () => { selected.splice(index, 1); renderPreviews(); status($('upload-status'), ''); submit.disabled = !user || selected.length === 0 || busy; });
      row.append(image, info, remove); previews.append(row);
    });
    submit.disabled = !user || selected.length === 0 || busy;
  }
  function addFiles(files) {
    const accepted = [];
    for (const file of files) {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { status($('upload-status'), `${file.name} isn’t a supported image. Choose a JPEG, PNG, or WebP.`, true); continue; }
      if (file.size > 10 * 1024 * 1024) { status($('upload-status'), `${file.name} is larger than 10 MB.`, true); continue; }
      if (selected.length + accepted.length >= 8) { status($('upload-status'), 'You can save up to 8 photos at a time.', true); break; }
      if (!selected.some((existing) => existing.name === file.name && existing.size === file.size)) accepted.push(file);
    }
    selected = [...selected, ...accepted]; renderPreviews();
  }
  input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });
  for (const eventName of ['dragenter', 'dragover']) zone.addEventListener(eventName, (event) => { event.preventDefault(); zone.classList.add('drag-active'); });
  for (const eventName of ['dragleave', 'drop']) zone.addEventListener(eventName, (event) => { event.preventDefault(); zone.classList.remove('drag-active'); });
  zone.addEventListener('drop', (event) => addFiles(event.dataTransfer.files));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!user || !selected.length || busy) return;
    busy = true; submit.disabled = true; submit.textContent = 'Analyzing…'; status($('upload-status'), 'Analyzing and saving your photos…');
    const files = [...selected];
    const caption = $('photo-caption').value.trim().slice(0, 300);
    let completed = 0;
    let analyzed = 0;
    let analysisFailures = 0;
    try {
      for (const file of files) {
        let analysis = '';
        let analysisError = '';
        status($('upload-status'), `Analyzing photo ${completed + 1} of ${files.length}…`);
        try {
          analysis = await analyzePhoto(file, user);
          analyzed += 1;
        } catch (error) {
          analysisError = error?.message || 'Photo analysis is temporarily unavailable.';
          analysisFailures += 1;
        }
        await savePhoto({
          id: crypto.randomUUID(), blob: file, name: file.name, type: file.type, size: file.size,
          caption, uploaderEmail: user.email || '', uploaderName: user.displayName || '',
          uploadedAt: new Date().toISOString(),
          analysis, analysisStatus: analysis ? 'complete' : 'error', analysisError,
          analyzedAt: analysis ? new Date().toISOString() : '',
        });
        completed += 1;
        status($('upload-status'), `Saved ${completed} of ${files.length} ${files.length === 1 ? 'photo' : 'photos'} locally…`);
      }
      selected = []; renderPreviews(); form.reset();
      const summary = `${completed} ${completed === 1 ? 'photo was' : 'photos were'} saved in this browser. ${analyzed} ${analyzed === 1 ? 'photo was' : 'photos were'} analyzed.`;
      status($('upload-status'), analysisFailures ? `${summary} ${analysisFailures} ${analysisFailures === 1 ? 'analysis needs' : 'analyses need'} a retry in the admin archive.` : summary);
      if (isAdmin()) await loadGallery();
    } catch (error) {
      const message = error?.name === 'QuotaExceededError'
        ? 'This device is out of browser storage space. Remove some photos and try again.'
        : 'The photos could not be saved in this browser. Check available storage and try again.';
      status($('upload-status'), completed ? `${completed} photo(s) saved. ${message}` : message, true);
    } finally { busy = false; updateAccess(); }
  });

  async function loadGallery() {
    if (!isAdmin()) return;
    const refresh = $('gallery-refresh'); refresh.disabled = true; gallery.replaceChildren();
    galleryUrls.forEach((url) => URL.revokeObjectURL(url)); galleryUrls = [];
    status($('gallery-status'), 'Loading photos from this browser…');
    try {
      const photos = await getPhotos();
      if (!photos.length) status($('gallery-status'), 'No photos have been saved on this device yet.'); else status($('gallery-status'), `${photos.length} ${photos.length === 1 ? 'photo' : 'photos'} in this browser’s admin archive.`);
      for (const photo of photos) {
        const card = document.createElement('article'); card.className = 'photo-card';
        const image = document.createElement('img');
        const url = URL.createObjectURL(photo.blob); galleryUrls.push(url);
        image.src = url; image.alt = photo.caption || photo.name || 'Community field report'; image.loading = 'lazy';
        const body = document.createElement('div'); body.className = 'photo-card-body';
        const title = document.createElement('strong'); title.textContent = photo.name || 'Photo'; body.append(title);
        if (photo.caption) { const copy = document.createElement('p'); copy.textContent = photo.caption; body.append(copy); }
        const dateLine = document.createElement('small'); dateLine.textContent = `${photo.uploaderEmail || 'RescueRoute user'} · ${new Date(photo.uploadedAt).toLocaleString()}`; body.append(dateLine);
        if (photo.mapTargetType && photo.mapTargetId) {
          const targetLine = document.createElement('small');
          targetLine.textContent = `Map evidence for ${photo.mapTargetType}: ${photo.mapTargetName || photo.mapTargetId}`;
          body.append(targetLine);
        }
        const analysisPanel = document.createElement('section'); analysisPanel.className = 'photo-analysis';
        const analysisTitle = document.createElement('strong'); analysisTitle.className = 'photo-analysis-title'; analysisTitle.textContent = 'AI access assessment'; analysisPanel.append(analysisTitle);
        const assessment = normalizeAssessment(photo.analysis);
        const analysisCopy = document.createElement('p');
        if (assessment) renderAssessment(analysisPanel, assessment);
        else {
          analysisCopy.textContent = photo.analysisError || (photo.analysis ? 'Reanalyze this photo to create the new table.' : 'This photo has not been analyzed yet.');
          analysisPanel.append(analysisCopy);
        }
        if (!assessment) {
          const analyzeButton = document.createElement('button'); analyzeButton.type = 'button'; analyzeButton.className = 'text-button photo-analysis-retry';
          analyzeButton.textContent = photo.analysisStatus === 'error' ? 'Retry analysis' : (photo.analysis ? 'Reanalyze as table' : 'Analyze photo');
          analyzeButton.addEventListener('click', async () => {
            if (!user) {
              analysisCopy.textContent = 'Sign in to RescueRoute with the admin account in this browser, then retry the analysis.';
              location.hash = '#login';
              return;
            }
            if (!isAdmin()) {
              analysisCopy.textContent = 'Sign in with the authorized RescueRoute admin account to analyze this photo.';
              return;
            }
            analyzeButton.disabled = true; analyzeButton.textContent = 'Analyzing…';
            try {
              const analysis = await analyzePhoto(photo.blob, user);
              await savePhoto({ ...photo, analysis, analysisStatus: 'complete', analysisError: '', analyzedAt: new Date().toISOString() });
              await loadGallery();
            } catch (error) {
              analysisCopy.textContent = error?.message || 'Photo analysis is temporarily unavailable.';
              analyzeButton.disabled = false; analyzeButton.textContent = 'Retry analysis';
            }
          });
          analysisPanel.append(analyzeButton);
        } else {
          const analysisDate = document.createElement('small'); analysisDate.textContent = photo.analyzedAt ? `Analyzed ${new Date(photo.analyzedAt).toLocaleString()}` : 'Analyzed with OpenAI';
          analysisPanel.append(analysisDate);
        }
        body.append(analysisPanel);
        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'text-button'; remove.textContent = 'Delete photo'; remove.addEventListener('click', async () => {
          if (!isAdmin()) return;
          remove.disabled = true;
          try { await deletePhoto(photo.id); await loadGallery(); }
          catch { status($('gallery-status'), 'The photo could not be deleted from this browser. Try again.', true); remove.disabled = false; }
        }); body.append(remove);
        card.append(image, body); gallery.append(card);
      }
    } catch {
      status($('gallery-status'), 'Local photo storage could not be opened. Check browser storage settings and refresh.', true);
    } finally { refresh.disabled = false; }
  }
  window.addEventListener('rescue:map-weight-photo', async (event) => {
    const request = event.detail;
    if (!request?.file || !['node', 'edge'].includes(request.targetType)) return;
    request.id ||= crypto.randomUUID();
    mapWeightRequest = request;
    mapWeightFlow.hidden = false; form.hidden = true; adminGallery.hidden = true; locked.hidden = true;
    mapWeightAssessment.replaceChildren(); mapWeightApply.disabled = true;
    $('map-weight-target').textContent = `Selected ${request.targetType}: ${request.targetName}. Review the AI assessment, then apply its suggested weight.`;
    if (mapWeightPreviewUrl) URL.revokeObjectURL(mapWeightPreviewUrl);
    mapWeightPreviewUrl = URL.createObjectURL(request.file); mapWeightPreview.src = mapWeightPreviewUrl; mapWeightPreview.hidden = false;
    if (!user) { status(mapWeightStatus, 'Sign in before analyzing a photo and saving a map weight.', true); return; }
    status(mapWeightStatus, 'Analyzing the road photo…');
    try {
      const assessment = await analyzePhoto(request.file, user);
      if (!Number.isInteger(assessment.recommended_weight) || typeof assessment.road_visible !== 'boolean' || !assessment.weight_reason ||
          typeof assessment.access_level !== 'string' || typeof assessment.can_motorcycles_pass !== 'boolean' ||
          typeof assessment.can_pedestrians_pass !== 'boolean' || typeof assessment.stairs_visible !== 'boolean' ||
          typeof assessment.street_stalls_visible !== 'boolean' || typeof assessment.parked_vehicles_visible !== 'boolean' ||
          typeof assessment.low_hanging_wires_visible !== 'boolean') {
        throw new Error('The photo analysis did not include a road visibility result and suggested weight. Please retry.');
      }
      renderAssessment(mapWeightAssessment, assessment);
      if (!assessment.road_visible) {
        status(mapWeightStatus, 'The photo does not clearly show a road. The current weight was left unchanged.', true);
        return;
      }
      let photoArchived = false;
      try {
        await savePhoto({
          id: request.id, blob: request.file, name: request.file.name || 'Map road photo', type: request.file.type,
          size: request.file.size, caption: `AI road access evidence for ${request.targetName}.`,
          uploaderEmail: request.uploaderEmail || user.email || '', uploaderName: user.displayName || '',
          uploadedAt: new Date().toISOString(), analysis: assessment, analysisStatus: 'complete', analysisError: '',
          analyzedAt: new Date().toISOString(), mapTargetType: request.targetType, mapTargetId: request.targetId,
          mapTargetName: request.targetName,
        });
        photoArchived = true;
      } catch (error) {
        console.warn('Map photo could not be archived locally', error);
      }
      status(mapWeightStatus, photoArchived
        ? `AI suggests ${assessment.recommended_weight}/10. The photo and assessment are saved in this browser’s Photo uploads archive. Review, then apply them to the map.`
        : `AI suggests ${assessment.recommended_weight}/10. The access assessment is ready; browser photo archive was unavailable. Review, then apply it to the map.`);
      mapWeightApply.textContent = `Apply weight ${assessment.recommended_weight}/10 to ${request.targetType}`;
      mapWeightApply.disabled = false;
      mapWeightApply.onclick = async () => {
        mapWeightApply.disabled = true; mapWeightApply.textContent = 'Saving to Firebase…';
        try {
          const savedWeight = await window.rescueRouteApplyMapWeight({
            targetType: request.targetType,
            targetId: request.targetId,
            weight: assessment.recommended_weight,
            photoAccess: {
              accessLevel: assessment.access_level,
              canVehiclesPass: assessment.can_vehicles_pass,
              canMotorcyclesPass: assessment.can_motorcycles_pass,
              canPedestriansPass: assessment.can_pedestrians_pass,
              hazards: {
                stairs: assessment.stairs_visible,
                stalls: assessment.street_stalls_visible,
                parkedVehicles: assessment.parked_vehicles_visible,
                lowHangingWires: assessment.low_hanging_wires_visible,
                deadEnd: assessment.dead_end,
                objects: assessment.obstructing_objects,
              },
              weightReason: assessment.weight_reason,
              assessedAt: new Date().toISOString(),
              photoId: request.id,
              photoName: request.file.name || 'Map road photo',
              photoUploadedAt: new Date().toISOString(),
            },
          });
          status(mapWeightStatus, `Saved ${request.targetType} weight ${savedWeight}/10 and ${assessment.access_level.replaceAll('_', ' ')} access to the shared map. Routes now use this access assessment.`);
          mapWeightApply.textContent = 'Weight saved';
        } catch (error) {
          status(mapWeightStatus, error?.message || 'Firebase save failed. Return to the map and check its sync status.', true);
          mapWeightApply.disabled = false; mapWeightApply.textContent = `Retry saving weight ${assessment.recommended_weight}/10`;
        }
      };
    } catch (error) {
      status(mapWeightStatus, error?.message || 'The road photo could not be analyzed. Please retry.', true);
    }
  });
  $('map-weight-return').addEventListener('click', () => { location.hash = '#map'; });
  $('gallery-refresh').addEventListener('click', loadGallery);
  window.addEventListener('rescue:uploads', () => { mapWeightFlow.hidden = true; form.hidden = false; if (mapWeightPreviewUrl) URL.revokeObjectURL(mapWeightPreviewUrl); mapWeightPreviewUrl = ''; updateAccess(); });
  import('./firebase-client.js').then(async (module) => {
    await module.auth.authStateReady();
    module.onAuthStateChanged(module.auth, (nextUser) => { user = nextUser; updateAccess(); });
  }).catch(() => { status($('upload-status'), 'Sign-in is unavailable right now. Reload and try again.', true); });
}
