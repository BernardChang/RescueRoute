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
      !Array.isArray(assessment.obstructing_objects)) {
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
    ['Can vehicles pass through?', assessment.can_vehicles_pass],
    ['Is a path obstruction visible?', assessment.obstruction_exists],
    ['Does the alley appear to end here?', assessment.dead_end],
  ];
  rows.forEach(([label, answer]) => {
    const row = document.createElement('tr');
    const heading = document.createElement('th'); heading.scope = 'row'; heading.textContent = label;
    const value = document.createElement('td'); value.textContent = answer ? 'True' : 'False';
    row.append(heading, value); tbody.append(row);
  });
  table.append(tbody); container.append(table);

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
  const adminEmail = photoAdminEmail.trim().toLowerCase();
  let user = null;
  let selected = [];
  let busy = false;
  let galleryUrls = [];

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
  $('gallery-refresh').addEventListener('click', loadGallery);
  window.addEventListener('rescue:uploads', updateAccess);
  import('./firebase-client.js').then(async (module) => {
    await module.auth.authStateReady();
    module.onAuthStateChanged(module.auth, (nextUser) => { user = nextUser; updateAccess(); });
  }).catch(() => { status($('upload-status'), 'Sign-in is unavailable right now. Reload and try again.', true); });
}
