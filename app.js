const $ = selector => document.querySelector(selector);
const PAGE_SIZE = 16;
const SHORTCUTS = '1234qwerasdfzxcv';
const readSetting = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const saveSetting = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* The board still works without localStorage. */ } };
let catalog = [], customs = [], bank = 'all', page = 0;
let favorites = new Set(readSetting('meme-deck-favorites', readSetting('favorites', [])));
let overlap = readSetting('meme-deck-overlap', false);
let volume = Math.max(0, Math.min(100, Number(readSetting('meme-deck-volume', 75)) || 0));
let context, master, analyser, animation, toastTimer, generation = 0, lastSound;
const buffers = new Map(), downloads = new Map(), pending = new Map(), playing = new Map();
let libraryReady = false, catalogFailed = false, favoritePicker = false;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const dbReady = new Promise((resolve, reject) => {
  const request = indexedDB.open('meme-deck', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('sounds', { keyPath: 'id' });
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
  request.onblocked = () => reject(new Error('Storage is being updated in another tab.'));
});
// Handle private browsing / disabled storage without losing the built-in soundboard.
dbReady.catch(() => {});
async function storage(mode, action) {
  const db = await dbReady;
  return new Promise((resolve, reject) => {
    const tx = db.transaction('sounds', mode);
    const request = action(tx.objectStore('sounds'));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = tx.onabort = () => reject(tx.error || new Error('Storage unavailable'));
  });
}
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 4200);
}
function allSounds() { return [...catalog, ...customs]; }
function bankSounds() {
  return allSounds().filter(sound => {
    if (bank === 'fav') return favorites.has(sound.id);
    if (bank === 'custom') return !!sound.blob;
    if (['sfx', 'animals', 'mj'].includes(bank)) return sound.pack === bank;
    return !sound.blob && (!sound.pack || sound.pack === 'memes');
  });
}
function visibleSounds() { return bankSounds().slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE); }
function renderPads() {
  const list = bankSounds();
  $('#library-icon').textContent = bank === 'fav' ? '★' : '＋';
  $('#library-label').textContent = bank === 'fav' ? 'ADD FAVORITES' : 'SOUND LIBRARY';
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  page = Math.min(page, pages - 1);
  $('#page').textContent = `${String(page + 1).padStart(2, '0')} / ${String(pages).padStart(2, '0')}`;
  $('#previous').disabled = page === 0;
  $('#next').disabled = page >= pages - 1;
  $('#sound-count').textContent = `${list.length} ${bank === 'custom' ? 'CUSTOM SOUNDS' : bank === 'fav' ? 'FAVORITES' : bank === 'sfx' ? 'SOUND EFFECTS' : bank === 'animals' ? 'ANIMAL SOUNDS' : bank === 'mj' ? 'MJ VOCAL CLIPS' : 'REAL MEME CLIPS'}`;
  const fragment = document.createDocumentFragment();
  if (!list.length) {
    const empty = document.createElement('div'); empty.className = 'empty-message';
    const title = document.createElement('strong');
    title.textContent = bank === 'custom' ? 'Your sounds. Your board.' : bank === 'fav' ? 'Keep your favorites close.' : catalogFailed ? 'Sound pack couldn’t load.' : 'Loading the good stuff…';
    const text = document.createElement('p');
    text.textContent = bank === 'custom' ? 'Import a clip from Files to get started.' : bank === 'fav' ? 'Pick your go-to memes and sound effects with a tap.' : catalogFailed ? 'Check your connection and retry.' : 'One tiny pack. Plenty of chaos.';
    const action = document.createElement('button'); action.className = 'primary-button';
    action.textContent = ['all', 'sfx', 'animals', 'mj'].includes(bank) ? 'Retry' : bank === 'fav' ? '★ Choose favorites' : 'Open library';
    action.onclick = ['all', 'sfx', 'animals', 'mj'].includes(bank) ? loadCatalog : () => openLibrary(bank === 'fav');
    empty.append(title, text, action); fragment.append(empty);
  } else {
    for (let index = 0; index < PAGE_SIZE; index++) {
      const sound = list[page * PAGE_SIZE + index];
      const button = document.createElement('button');
      button.className = sound?.id === 'fahhh' ? 'pad accent' : 'pad';
      if (!sound) {
        if (bank === 'fav' && page * PAGE_SIZE + index === list.length) {
          button.className = 'pad favorite-add';
          button.setAttribute('aria-label', 'Add a favorite');
          const plus = document.createElement('span'); plus.className = 'pad-icon'; plus.textContent = '＋';
          const label = document.createElement('span'); label.className = 'pad-name'; label.textContent = 'Add favorite';
          button.append(plus, label); button.onclick = () => openLibrary(true);
        } else { button.className = 'pad empty'; button.disabled = true; button.setAttribute('aria-hidden', 'true'); }
        fragment.append(button); continue;
      }
      button.dataset.id = sound.id;
      button.setAttribute('aria-label', `Play ${sound.name}`);
      button.setAttribute('aria-keyshortcuts', SHORTCUTS[index]);
      const pieces = [['pad-number', String(page * PAGE_SIZE + index + 1).padStart(2, '0')], ['pad-key', SHORTCUTS[index].toUpperCase()], ['pad-name', sound.name], ['pad-light', '']];
      for (const [className, text] of pieces) { const span = document.createElement('span'); span.className = className; span.textContent = text; span.setAttribute('aria-hidden', 'true'); button.append(span); }
      button.addEventListener('click', () => play(sound));
      fragment.append(button);
    }
  }
  $('#pads').replaceChildren(fragment);
  updatePadState();
}
function updatePadState() {
  document.querySelectorAll('.pad[data-id]').forEach(button => {
    const live = [...playing.values()].some(item => item.sound.id === button.dataset.id);
    button.classList.toggle('playing', live);
    button.classList.toggle('loading', [...pending.values()].some(sound => sound.id === button.dataset.id));
  });
}
function initializeAudio() {
  if (!context) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) throw new Error('Web Audio is unavailable.');
    context = new AudioContext({ latencyHint: 'interactive' });
    master = context.createGain();
    analyser = context.createAnalyser(); analyser.fftSize = 256;
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -3; limiter.knee.value = 3; limiter.ratio.value = 12; limiter.attack.value = 0.003; limiter.release.value = 0.1;
    master.connect(limiter).connect(analyser).connect(context.destination);
    master.gain.value = volume / 100;
  }
  // Must happen synchronously inside the user gesture on iOS.
  const resume = context.state !== 'running' ? context.resume() : Promise.resolve();
  return resume;
}
async function getBuffer(sound) {
  if (!buffers.has(sound.id)) {
    const promise = (async () => {
      let bytes;
      if (sound.blob) bytes = await sound.blob.arrayBuffer();
      else {
        if (!downloads.has(sound.id)) downloads.set(sound.id, fetch(sound.file).then(response => { if (!response.ok) throw Error('Audio unavailable'); return response.arrayBuffer(); }));
        bytes = (await downloads.get(sound.id)).slice(0);
      }
      return context.decodeAudioData(bytes);
    })();
    buffers.set(sound.id, promise);
    promise.catch(() => { buffers.delete(sound.id); downloads.delete(sound.id); });
  }
  return buffers.get(sound.id);
}
function stopAll() {
  generation++;
  pending.clear();
  for (const [source] of playing) { try { source.stop(); } catch {} }
  playing.clear();
  updatePlaybackState();
}
async function play(sound) {
  if (!sound) return;
  let resume;
  try { resume = initializeAudio(); } catch { toast('This browser cannot play audio. Try Safari or Chrome.'); return; }
  if (!overlap) stopAll();
  const currentGeneration = generation, request = Symbol();
  pending.set(request, sound); updatePadState();
  $('#state').textContent = 'LOADING'; $('#now-playing').textContent = sound.name;
  try {
    await resume;
    const buffer = await getBuffer(sound);
    if (currentGeneration !== generation) return;
    // Bound layered playback to keep mobile audio stable.
    if (playing.size >= 12) { const oldest = playing.keys().next().value; oldest.stop(); playing.delete(oldest); }
    const source = context.createBufferSource(); source.buffer = buffer;
    const gain = context.createGain();
    // Bring clips to a consistent peak, without replacing or synthesizing them.
    let peak = 0;
    if (!sound.normalization) {
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) { const data = buffer.getChannelData(channel); for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i])); }
      sound.normalization = peak > 0 ? Math.min(3, 0.75 / peak) : 1;
    }
    gain.gain.value = sound.normalization;
    source.connect(gain).connect(master);
    playing.set(source, { sound, start: context.currentTime, duration: buffer.duration });
    source.onended = () => { playing.delete(source); source.disconnect(); gain.disconnect(); updatePlaybackState(); };
    source.start(); lastSound = sound;
  } catch {
    if (currentGeneration === generation) toast(`Couldn’t play ${sound.name}. Connect once to download the sound pack.`);
  } finally { pending.delete(request); updatePlaybackState(); }
}
function updatePlaybackState() {
  updatePadState();
  const latest = [...playing.values()].at(-1);
  $('#state').textContent = latest ? 'PLAYING' : pending.size ? 'LOADING' : 'READY';
  $('#now-playing').textContent = latest?.sound.name || [...pending.values()].at(-1)?.name || lastSound?.name || 'Ready to play.';
  $('#status-dot').style.opacity = latest ? '1' : '.55';
  if (latest) { if (!animation) animate(); }
  else { cancelAnimationFrame(animation); animation = null; $('#time').textContent = '00.0'; drawScope(); }
}
const canvas = $('#scope');
const drawContext = canvas.getContext('2d');
const wave = new Uint8Array(128), waveColor = '#343a2e';
function drawScope() {
  const width = Math.round(canvas.clientWidth * devicePixelRatio), height = Math.round(canvas.clientHeight * devicePixelRatio);
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  drawContext.clearRect(0, 0, width, height);
  drawContext.strokeStyle = waveColor; drawContext.lineWidth = devicePixelRatio; drawContext.globalAlpha = playing.size ? 0.85 : 0.3;
  drawContext.beginPath();
  if (playing.size && !reducedMotion.matches) {
    analyser.getByteTimeDomainData(wave);
    wave.forEach((point, index) => { const x = index / (wave.length - 1) * width, y = (point / 128 - 1) * height * 0.85 + height / 2; index ? drawContext.lineTo(x, y) : drawContext.moveTo(x, y); });
  } else { drawContext.moveTo(0, height / 2); drawContext.lineTo(width, height / 2); }
  drawContext.stroke();
}
function animate() {
  const latest = [...playing.values()].at(-1);
  if (!latest) { animation = null; return; }
  $('#time').textContent = Math.max(0, latest.duration - (context.currentTime - latest.start)).toFixed(1).padStart(4, '0');
  drawScope(); animation = requestAnimationFrame(animate);
}
function renderLibrary() {
  const fragment = document.createDocumentFragment(), search = $('#search').value.trim().toLowerCase();
  const sounds = allSounds().filter(sound => `${sound.name} ${sound.category || sound.cat || ''} ${sound.pack || 'memes'}`.toLowerCase().includes(search));
  sounds.forEach(sound => {
    const row = document.createElement('div'); row.className = 'sound-row';
    const preview = document.createElement('button'); preview.className = 'sound-preview'; preview.textContent = '▶'; preview.setAttribute('aria-label', `Preview ${sound.name}`); preview.onclick = () => play(sound);
    const info = document.createElement('div'); info.className = 'sound-info';
    const name = document.createElement('strong'); name.textContent = sound.name; info.append(name);
    if (favoritePicker) { const detail = document.createElement('small'); detail.textContent = `${sound.blob ? 'Your audio' : sound.pack === 'sfx' ? 'Sound effect' : sound.pack === 'animals' ? 'Animal' : sound.pack === 'mj' ? 'Michael Jackson' : 'Meme'}${sound.duration ? ' · ' + sound.duration.toFixed(1) + 's' : ''}`; info.append(detail); }
    else if (sound.source) { const source = document.createElement('a'); source.textContent = `${sound.duration.toFixed(1)}s · View source ↗`; source.href = sound.source; source.target = '_blank'; source.rel = 'noopener noreferrer'; info.append(source); }
    else { const detail = document.createElement('small'); detail.textContent = `${sound.duration ? sound.duration.toFixed(1) + 's · ' : ''}On this device`; info.append(detail); }
    const favorite = document.createElement('button'); favorite.className = 'favorite'; favorite.textContent = favorites.has(sound.id) ? '★' : '☆'; favorite.setAttribute('aria-label', `Favorite ${sound.name}`); favorite.setAttribute('aria-pressed', favorites.has(sound.id));
    row.classList.toggle('is-favorite', favorites.has(sound.id));
    favorite.onclick = () => {
      favorites.has(sound.id) ? favorites.delete(sound.id) : favorites.add(sound.id);
      favorite.setAttribute('aria-pressed', favorites.has(sound.id));
      favorite.textContent = favorites.has(sound.id) ? '★' : '☆';
      row.classList.toggle('is-favorite', favorites.has(sound.id));
      saveSetting('meme-deck-favorites', [...favorites]); renderPads(); updateFavoriteCount();
    };
    if (favoritePicker) row.onclick = event => { if (!event.target.closest('button, a')) favorite.click(); };
    row.append(preview, info, favorite);
    if (sound.blob && !favoritePicker) {
      const remove = document.createElement('button'); remove.className = 'delete-sound'; remove.textContent = '×'; remove.setAttribute('aria-label', `Remove ${sound.name}`);
      remove.onclick = async () => {
        if (!confirm(`Remove “${sound.name}” from this device? Keep your original file as a backup.`)) return;
        try { await storage('readwrite', store => store.delete(sound.id)); stopAll(); customs = customs.filter(item => item.id !== sound.id); favorites.delete(sound.id); saveSetting('meme-deck-favorites', [...favorites]); buffers.delete(sound.id); renderPads(); renderLibrary(); toast('Sound removed.'); }
        catch { toast('Couldn’t remove this sound. Please try again.'); }
      }; row.append(remove);
    }
    fragment.append(row);
  });
  if (!sounds.length) { const empty = document.createElement('p'); empty.className = 'dialog-note'; empty.textContent = 'No matching sounds. Import a clip to add your own.'; fragment.append(empty); }
  $('#sound-list').replaceChildren(fragment);
  updateFavoriteCount();
}
function updateFavoriteCount() {
  const count = allSounds().filter(sound => favorites.has(sound.id)).length;
  $('#favorite-count').textContent = `${count} favorite${count === 1 ? '' : 's'} selected`;
}
function openLibrary(pickFavorites = false) {
  favoritePicker = pickFavorites;
  $('#library-dialog').classList.toggle('favorite-mode', pickFavorites);
  $('#library-title').textContent = pickFavorites ? 'Choose your favorites' : 'Sound library';
  $('#library-note').textContent = pickFavorites ? 'Tap a sound or ☆ to add it. Your choices save instantly.' : 'Tap ★ to save a favorite. Imported clips stay on this device.';
  $('#import').hidden = pickFavorites;
  $('#storage-note').hidden = pickFavorites;
  $('#favorite-actions').hidden = !pickFavorites;
  $('#search').value = '';
  openDialog('library-dialog');
}
$('#favorites-done').onclick = () => $('#library-dialog').close();
function openDialog(id) { if (id === 'library-dialog') renderLibrary(); $('#' + id).showModal(); }
$('#settings-button').onclick = () => { openDialog('settings-dialog'); requestOfflineStatus(); };
$('#library-button').onclick = () => openLibrary(bank === 'fav');
document.querySelectorAll('dialog .close').forEach(button => button.onclick = () => button.closest('dialog').close());
document.querySelectorAll('dialog').forEach(dialog => {
  dialog.addEventListener('click', event => { if (event.target !== dialog) return; const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); });
  dialog.addEventListener('cancel', stopAll);
});
$('#stop').onclick = stopAll;
$('#volume').value = volume; $('#volume-value').textContent = volume;
$('#volume').oninput = event => { volume = Number(event.target.value); $('#volume-value').textContent = volume; if (master) master.gain.setTargetAtTime(volume / 100, context.currentTime, 0.01); saveSetting('meme-deck-volume', volume); };
function updateMix() { $('#mix').setAttribute('aria-pressed', overlap); $('#mix-status').textContent = overlap ? 'OVERLAP ON' : 'ONE SHOT'; }
$('#mix').onclick = () => { overlap = !overlap; if (!overlap) stopAll(); saveSetting('meme-deck-overlap', overlap); updateMix(); };
updateMix();
function selectBank(value) {
  bank = value; page = 0;
  document.querySelectorAll('[data-bank]').forEach(item => {
    const selected = item.dataset.bank === bank;
    item.classList.toggle('selected', selected); item.setAttribute('aria-pressed', selected);
  });
  $('#bank-select').value = bank;
  renderPads();
}
document.querySelectorAll('[data-bank]').forEach(button => button.onclick = () => selectBank(button.dataset.bank));
$('#bank-select').onchange = event => selectBank(event.target.value);
$('#previous').onclick = () => { page = Math.max(0, page - 1); renderPads(); };
$('#next').onclick = () => { page++; renderPads(); };
$('#search').oninput = renderLibrary;
$('#import').onclick = () => { if (!libraryReady) { toast('Local storage is unavailable. Built-in sounds still work.'); return; } try { initializeAudio().catch(() => {}); } catch { toast('Audio import requires Safari or Chrome.'); return; } $('#files').click(); };
$('#files').onchange = async event => {
  const files = [...event.target.files]; event.target.value = '';
  if (!files.length) return;
  try { initializeAudio().catch(() => {}); } catch { toast('Audio import requires Safari or Chrome.'); return; }
  $('#import').disabled = true;
  let count = 0;
  for (const file of files) {
    if (file.size > 25 * 1024 * 1024) { toast(`${file.name}: maximum size is 25 MB.`); continue; }
    try {
      const buffer = await context.decodeAudioData(await file.arrayBuffer());
      if (buffer.duration > 120) { toast(`${file.name}: choose a clip shorter than 2 minutes.`); continue; }
      const sound = { id: crypto.randomUUID(), name: file.name.replace(/\.[^.]+$/, '').slice(0, 64), category: 'Your audio', icon: '♫', blob: file, duration: buffer.duration };
      await storage('readwrite', store => store.put(sound));
      customs.push(sound); buffers.set(sound.id, Promise.resolve(buffer)); count++;
    } catch { toast(`Couldn’t import ${file.name}. Try a smaller MP3, WAV or M4A.`); }
  }
  $('#import').disabled = false;
  renderPads(); renderLibrary();
  if (count) toast(`${count} ${count === 1 ? 'sound' : 'sounds'} saved on this device.`);
};
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { stopAll(); return; }
  if (event.ctrlKey || event.metaKey || event.altKey || event.repeat || event.isComposing || /INPUT|TEXTAREA|SELECT/.test(event.target.tagName) || event.target.isContentEditable || document.querySelector('dialog[open]')) return;
  const index = SHORTCUTS.indexOf(event.key.toLowerCase());
  if (index >= 0) { event.preventDefault(); play(visibleSounds()[index]); }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) stopAll(); });
window.addEventListener('pagehide', stopAll);
window.addEventListener('resize', drawScope);
async function loadCatalog() {
  try {
    const response = await fetch('sounds.json'); if (!response.ok) throw Error('Catalog unavailable');
    catalog = await response.json(); catalogFailed = false;
    for (const sound of catalog) {
      const promise = fetch(sound.file).then(response => { if (!response.ok) throw Error('Audio unavailable'); return response.arrayBuffer(); });
      downloads.set(sound.id, promise); promise.catch(() => downloads.delete(sound.id));
    }
  } catch { catalogFailed = true; }
  renderPads();
}
function showOfflineStatus(data) {
  if (data.type !== 'OFFLINE_STATUS') return;
  $('#offline').textContent = data.ready ? 'OFFLINE READY' : data.error ? 'ONLINE' : `SAVING ${data.count || 0}/${data.total || catalog.length || 112}`;
  $('#download-status').textContent = data.ready ? `${data.count} clips saved. Ready without Wi-Fi.` : data.error ? 'Offline pack unavailable. Reopen online to retry.' : `Saving sound pack… ${data.count || 0}/${data.total || catalog.length || 112}`;
}
function requestOfflineStatus() { navigator.serviceWorker?.controller?.postMessage({ type: 'GET_OFFLINE_STATUS' }); }
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', event => showOfflineStatus(event.data || {}));
  let refreshing = false;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !refreshing) { refreshing = true; stopAll(); location.reload(); } else requestOfflineStatus(); });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(registration => { registration.update().catch(() => {}); return navigator.serviceWorker.ready; }).then(requestOfflineStatus).catch(() => { $('#offline').textContent = 'ONLINE'; $('#download-status').textContent = 'Offline mode requires HTTPS or localhost.'; });
}
loadCatalog();
storage('readonly', store => store.getAll()).then(sounds => { customs = sounds; libraryReady = true; renderPads(); }).catch(() => { $('#storage-note').textContent = 'Local storage unavailable. Built-in clips are still playable.'; });
drawScope();
