import { photoAdminEmail, photoStorageReady } from './photo-config.js';

const $ = (id) => document.getElementById(id);
const form = $('photo-upload-form');
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
  let client;
  let user = null;
  let selected = [];
  let busy = false;

  function status(element, text, error = false) {
    element.textContent = text;
    element.hidden = !text;
    element.classList.toggle('is-error', error);
  }
  function isAdmin() { return !!user?.email && !!adminEmail && user.email.toLowerCase() === adminEmail; }
  function updateAccess() {
    const admin = isAdmin();
    adminGallery.hidden = !admin || !photoStorageReady;
    locked.hidden = admin && photoStorageReady;
    input.disabled = !user || !adminEmail || !photoStorageReady || busy;
    authNote.textContent = !photoStorageReady
      ? 'Photo storage is waiting for Firebase rule permissions. No files will be accepted until setup is complete.'
      : !adminEmail
      ? 'Photo uploads are being configured. Check back soon.'
      : user
      ? (admin ? `Signed in as ${user.email}. You can upload and manage the admin archive.` : `Signed in as ${user.email}. Your upload will be stored for the RescueRoute admin team.`)
      : 'Sign in to submit a photo. Uploaded images are available to the admin team.';
    submit.disabled = busy || !user || !adminEmail || !photoStorageReady || selected.length === 0;
    submit.innerHTML = busy ? 'Uploading…' : 'Upload photos <span>↗</span>';
    if (!photoStorageReady) {
      locked.querySelector('strong').textContent = 'Storage setup is pending';
      locked.querySelector('p').textContent = 'Firebase denied the current service account permission to publish Storage rules. The admin archive will open once that permission is granted.';
    } else {
      locked.querySelector('strong').textContent = 'Admin access only';
      locked.querySelector('p').textContent = 'Sign in with an authorized admin account to view the photo archive.';
    }
    if (admin && user && photoStorageReady) loadGallery();
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
    submit.disabled = !user || !photoStorageReady || selected.length === 0 || busy;
  }
  function addFiles(files) {
    if (!adminEmail || !photoStorageReady) { status($('upload-status'), 'Photo storage is not ready yet. Please check back soon.', true); return; }
    const accepted = [];
    for (const file of files) {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { status($('upload-status'), `${file.name} isn’t a supported image. Choose a JPEG, PNG, or WebP.`, true); continue; }
      if (file.size > 10 * 1024 * 1024) { status($('upload-status'), `${file.name} is larger than 10 MB.`, true); continue; }
      if (selected.length + accepted.length >= 8) { status($('upload-status'), 'You can upload up to 8 photos at a time.', true); break; }
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
    if (!user || !selected.length || busy || !client) return;
    if (!adminEmail || !photoStorageReady) { status($('upload-status'), 'Photo storage is not ready yet. Please try again later.', true); return; }
    busy = true; submit.disabled = true; submit.textContent = 'Uploading…'; status($('upload-status'), 'Preparing secure upload…');
    const files = [...selected];
    const caption = $('photo-caption').value.trim().slice(0, 300);
    let completed = 0;
    try {
      for (const file of files) {
        const safeExtension = file.type === 'image/jpeg' ? 'jpg' : file.type === 'image/png' ? 'png' : 'webp';
        const key = `${user.uid}_${crypto.randomUUID()}.${safeExtension}`;
        const photoRef = client.ref(client.storage, `rescue-uploads/${key}`);
        await client.uploadBytes(photoRef, file, {
          contentType: file.type,
          customMetadata: { caption, uploaderEmail: user.email || '', uploaderName: user.displayName || '', originalName: file.name, uploadedAt: new Date().toISOString() },
        });
        completed += 1;
        status($('upload-status'), `Uploaded ${completed} of ${files.length} ${files.length === 1 ? 'photo' : 'photos'}…`);
      }
      selected = []; renderPreviews(); form.reset();
      status($('upload-status'), `${completed} ${completed === 1 ? 'photo was' : 'photos were'} uploaded securely for the RescueRoute admin team.`);
      if (isAdmin()) await loadGallery();
    } catch (error) {
      const detail = error?.code === 'storage/unauthorized'
        ? 'Photo storage permissions are not ready. Contact the site administrator.'
        : error?.code === 'storage/retry-limit-exceeded' || error?.code === 'storage/canceled'
          ? 'The upload was interrupted. Check your connection and try again.'
          : 'The photos could not be uploaded. Check your connection and try again.';
      status($('upload-status'), completed ? `${completed} photo(s) uploaded. ${detail}` : detail, true);
    } finally { busy = false; updateAccess(); }
  });

  async function loadGallery() {
    if (!isAdmin() || !client || !photoStorageReady) return;
    const refresh = $('gallery-refresh'); refresh.disabled = true; gallery.replaceChildren();
    status($('gallery-status'), 'Loading the secure photo archive…');
    try {
      const root = client.ref(client.storage, 'rescue-uploads');
      const result = await client.listAll(root);
      const photos = await Promise.all(result.items.map(async (item) => {
        const [url, metadata] = await Promise.all([client.getDownloadURL(item), client.getMetadata(item)]);
        return { item, url, metadata };
      }));
      photos.sort((a, b) => (b.metadata.customMetadata?.uploadedAt || b.metadata.timeCreated).localeCompare(a.metadata.customMetadata?.uploadedAt || a.metadata.timeCreated));
      if (!photos.length) status($('gallery-status'), 'No photos have been uploaded yet.'); else status($('gallery-status'), `${photos.length} ${photos.length === 1 ? 'photo' : 'photos'} in the admin archive.`);
      for (const photo of photos) {
        const card = document.createElement('article'); card.className = 'photo-card';
        const image = document.createElement('img'); image.src = photo.url; image.alt = photo.metadata.customMetadata?.caption || photo.metadata.customMetadata?.originalName || 'Community field report'; image.loading = 'lazy';
        const body = document.createElement('div'); body.className = 'photo-card-body';
        const title = document.createElement('strong'); title.textContent = photo.metadata.customMetadata?.originalName || photo.item.name;
        body.append(title);
        const caption = photo.metadata.customMetadata?.caption;
        if (caption) { const copy = document.createElement('p'); copy.textContent = caption; body.append(copy); }
        const uploader = photo.metadata.customMetadata?.uploaderEmail || 'RescueRoute user';
        const date = new Date(photo.metadata.customMetadata?.uploadedAt || photo.metadata.timeCreated);
        const dateLine = document.createElement('small'); dateLine.textContent = `${uploader} · ${date.toLocaleString()}`; body.append(dateLine);
        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'text-button'; remove.textContent = 'Delete photo'; remove.addEventListener('click', async () => {
          if (!isAdmin()) return;
          remove.disabled = true;
          try { await client.deleteObject(photo.item); await loadGallery(); }
          catch { status($('gallery-status'), 'The photo could not be deleted. Try again.', true); remove.disabled = false; }
        }); body.append(remove);
        card.append(image, body); gallery.append(card);
      }
    } catch (error) {
      status($('gallery-status'), error?.code === 'storage/unauthorized' ? 'This account is not authorized to access the archive.' : 'The archive could not be loaded. Refresh to try again.', true);
    } finally { refresh.disabled = false; }
  }
  $('gallery-refresh').addEventListener('click', loadGallery);
  window.addEventListener('rescue:uploads', () => updateAccess());
  import('./firebase-client.js').then(async (module) => {
    client = module;
    await client.auth.authStateReady();
    client.onAuthStateChanged(client.auth, (nextUser) => { user = nextUser; updateAccess(); });
  }).catch(() => { status($('upload-status'), 'Sign-in is unavailable right now. Reload and try again.', true); });
}
