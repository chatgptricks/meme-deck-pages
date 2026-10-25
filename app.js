import { createClipRecorder, MAX_RECORDING_SECONDS } from './recorder.js';
import { attachSwipePages } from './swipe.js';

const $ = selector => document.querySelector(selector);
const PAGE_SIZE = 20;
const SHORTCUTS = '12345qwertasdfgzxcvb';
const readSetting = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const saveSetting = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* The board still works without localStorage. */ } };
const BANKS = [
  { id: 'reactions', name: 'Reacciones', group: 'Memes' },
  { id: 'quotes', name: 'Frases', group: 'Memes' },
  { id: 'taunts', name: 'Risas y burlas', group: 'Memes' },
  { id: 'drama', name: 'Drama y fails', group: 'Memes' },
  { id: 'gaming', name: 'Gaming', group: 'Memes' },
  { id: 'stings', name: 'Efectos meme', group: 'Memes' },
  { id: 'sfx', name: 'Efectos de sonido', group: 'Colecciones' },
  { id: 'animals', name: 'Animales', group: 'Colecciones' },
  { id: 'mj', name: 'Michael Jackson', group: 'Colecciones' },
  { id: 'betty', name: 'Betty la fea', group: 'Colecciones' },
  { id: 'ticos', name: 'Audios ticos', group: 'Colecciones' },
  { id: 'fav', name: 'Favoritos', group: 'Tu colección' },
  { id: 'custom', name: 'Mis sonidos', group: 'Tu colección' }
];
const savedBank = readSetting('meme-deck-bank', 'reactions');
let catalog = [], customs = [], bank = BANKS.some(item => item.id === savedBank) ? savedBank : 'reactions', page = 0;
let favorites = new Set(readSetting('meme-deck-favorites', readSetting('favorites', [])));
let overlap = readSetting('meme-deck-overlap', false);
let volume = Math.max(0, Math.min(100, Number(readSetting('meme-deck-volume', 75)) || 0));
let context, master, analyser, animation, toastTimer, generation = 0, lastSound;
const buffers = new Map(), downloads = new Map(), pending = new Map(), playing = new Map();
const decodedSizes = new Map(), MAX_DECODED_BUFFERS = 8, MAX_DECODED_BYTES = 48 * 1024 * 1024;
let libraryReady = false, catalogFailed = false, favoritePicker = false, boardQuery = '';
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
function searchTerms(value) {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim().split(/\s+/).filter(Boolean);
}
function matchesSearch(sound, terms) {
  const soundBank = sound.blob ? 'custom' : !sound.pack || sound.pack === 'memes' ? sound.bank || 'reactions' : sound.pack;
  const collection = BANKS.find(item => item.id === soundBank);
  const text = searchTerms([sound.name, sound.label, sound.category || sound.cat, sound.context, sound.artist, sound.pack, collection?.name, collection?.group].filter(Boolean).join(' ')).join(' ');
  return terms.every(term => text.includes(term));
}
function isSearching() { return searchTerms(boardQuery).length > 0; }
function boardSounds() {
  const terms = searchTerms(boardQuery);
  return terms.length ? allSounds().filter(sound => matchesSearch(sound, terms)) : bankSounds();
}
function setBoardSearch(value) {
  boardQuery = value;
  $('#sound-search').value = value;
  page = 0;
  renderPads();
}
function bankSounds(selectedBank = bank) {
  return allSounds().filter(sound => {
    if (selectedBank === 'fav') return favorites.has(sound.id);
    if (selectedBank === 'custom') return !!sound.blob;
    if (['sfx', 'animals', 'mj', 'betty', 'ticos'].includes(selectedBank)) return sound.pack === selectedBank;
    return !sound.blob && (!sound.pack || sound.pack === 'memes') && (sound.bank || 'reactions') === selectedBank;
  });
}
function renderCategories() {
  const fragment = document.createDocumentFragment();
  for (const group of [...new Set(BANKS.map(item => item.group))]) {
    const section = document.createElement('section'); section.className = 'category-group';
    const heading = document.createElement('h3'); heading.textContent = group;
    const grid = document.createElement('div'); grid.className = 'category-grid';
    for (const item of BANKS.filter(item => item.group === group)) {
      const button = document.createElement('button'); button.className = 'category-card'; button.dataset.bank = item.id;
      button.classList.toggle('selected', item.id === bank); button.setAttribute('aria-pressed', item.id === bank);
      const name = document.createElement('span'); name.className = 'category-name'; name.textContent = item.name;
      const count = document.createElement('span'); count.className = 'category-count'; count.textContent = `${bankSounds(item.id).length} sonidos`;
      button.append(name, count);
      button.onclick = () => { selectBank(item.id); $('#category-dialog').close(); };
      grid.append(button);
    }
    section.append(heading, grid); fragment.append(section);
  }
  $('#category-list').replaceChildren(fragment);
}
function visibleSounds() { return boardSounds().slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE); }
function renderPads() {
  const list = boardSounds(), searching = isSearching();
  const pads = $('#pads');
  $('#library-icon').textContent = bank === 'fav' && !searching ? '★' : '＋';
  $('#library-label').textContent = bank === 'fav' && !searching ? 'ADD FAVORITES' : 'SOUND LIBRARY';
  $('#record-add').hidden = bank !== 'custom' || searching;
  $('#clear-sound-search').hidden = !boardQuery;
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  page = Math.min(page, pages - 1);
  $('#page').textContent = `${String(page + 1).padStart(2, '0')} / ${String(pages).padStart(2, '0')}`;
  $('#previous').disabled = page === 0;
  $('#next').disabled = page >= pages - 1;
  $('#pagination').hidden = pages <= 1;
  const selectedBank = BANKS.find(item => item.id === bank);
  $('#bank-group').textContent = searching ? 'Todos los sonidos' : selectedBank.group;
  $('#bank-name').textContent = searching ? 'Resultados' : selectedBank.name;
  $('#bank-size').textContent = `${list.length} sonidos`;
  $('#bank-picker').setAttribute('aria-label', `Cambiar categoría: ${searching ? 'resultados de búsqueda' : selectedBank.name}, ${list.length} sonidos`);
  $('#search-status').textContent = searching ? `${list.length} ${list.length === 1 ? 'sonido encontrado' : 'sonidos encontrados'}` : '';
  if ($('#category-dialog').open) renderCategories();
  $('#sound-count').textContent = `${list.length} ${searching ? 'RESULTADOS' : bank === 'custom' ? 'CUSTOM SOUNDS' : bank === 'fav' ? 'FAVORITES' : bank === 'sfx' ? 'SOUND EFFECTS' : bank === 'animals' ? 'ANIMAL SOUNDS' : bank === 'mj' ? 'MJ VOCAL CLIPS' : bank === 'betty' ? 'BETTY LA FEA' : bank === 'ticos' ? 'AUDIOS TICOS' : 'REAL MEME CLIPS'}`;
  const fragment = document.createDocumentFragment();
  if (!list.length) {
    const empty = document.createElement('div'); empty.className = 'empty-message';
    const title = document.createElement('strong');
    const failed = catalogFailed;
    title.textContent = searching && !failed ? 'No encontramos sonidos' : bank === 'custom' ? 'Your sounds. Your board.' : bank === 'fav' ? 'Keep your favorites close.' : failed ? 'Sound pack couldn’t load.' : 'Loading the good stuff…';
    const text = document.createElement('p');
    text.textContent = searching && !failed ? 'Prueba otro nombre, frase o categoría.' : bank === 'custom' ? 'Graba hasta 6 segundos o importa un audio desde la biblioteca.' : bank === 'fav' ? 'Pick your go-to memes and sound effects with a tap.' : failed ? 'Check your connection and retry.' : 'One tiny pack. Plenty of chaos.';
    const action = document.createElement('button'); action.className = 'primary-button';
    action.textContent = searching && !failed ? 'Limpiar búsqueda' : !['fav', 'custom'].includes(bank) ? 'Retry' : bank === 'fav' ? '★ Choose favorites' : '＋ Grabar clip';
    action.onclick = searching && !failed ? () => setBoardSearch('') : bank === 'custom' ? openRecorder : bank === 'fav' ? () => openLibrary(true) : loadCatalog;
    empty.append(title, text, action); fragment.append(empty);
  } else {
    for (let index = 0; index < PAGE_SIZE; index++) {
      const sound = list[page * PAGE_SIZE + index];
      const button = document.createElement('button');
      button.className = sound?.id === 'fahhh' ? 'pad accent' : 'pad';
      if (!sound) {
        if (!searching && ['fav', 'custom'].includes(bank) && page * PAGE_SIZE + index === list.length) {
          button.className = 'pad favorite-add';
          button.setAttribute('aria-label', bank === 'custom' ? 'Grabar un clip' : 'Add a favorite');
          const plus = document.createElement('span'); plus.className = 'pad-icon'; plus.textContent = '＋';
          const label = document.createElement('span'); label.className = 'pad-name'; label.textContent = bank === 'custom' ? 'Grabar clip' : 'Add favorite';
          button.append(plus, label); button.onclick = bank === 'custom' ? openRecorder : () => openLibrary(true);
        } else { button.className = 'pad empty'; button.disabled = true; button.setAttribute('aria-hidden', 'true'); }
        fragment.append(button); continue;
      }
      button.dataset.id = sound.id;
      button.setAttribute('aria-label', `Play ${sound.name}`);
      button.setAttribute('aria-keyshortcuts', SHORTCUTS[index]);
      const pieces = [['pad-number', String(page * PAGE_SIZE + index + 1).padStart(2, '0')], ['pad-key', SHORTCUTS[index].toUpperCase()], ['pad-name', sound.label || sound.name], ['pad-light', '']];
      for (const [className, text] of pieces) { const span = document.createElement('span'); span.className = className; span.textContent = text; span.setAttribute('aria-hidden', 'true'); button.append(span); }
      button.addEventListener('click', () => play(sound));
      fragment.append(button);
    }
  }
  pads.replaceChildren(fragment);
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
function retainDecoded(id, buffer) {
  decodedSizes.delete(id);
  decodedSizes.set(id, buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT);
  let bytes = [...decodedSizes.values()].reduce((sum, size) => sum + size, 0);
  // Only resolved decodes enter this LRU. In-flight promises stay available to
  // concurrent taps; active AudioBufferSources retain their own audio safely.
  while (decodedSizes.size > MAX_DECODED_BUFFERS || bytes > MAX_DECODED_BYTES) {
    const [oldest, size] = decodedSizes.entries().next().value;
    decodedSizes.delete(oldest); buffers.delete(oldest); bytes -= size;
  }
}
function forgetDecoded(id) { buffers.delete(id); decodedSizes.delete(id); }
async function getBuffer(sound) {
  if (decodedSizes.has(sound.id)) {
    const size = decodedSizes.get(sound.id); decodedSizes.delete(sound.id); decodedSizes.set(sound.id, size);
  }
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
    promise.then(buffer => {
      if (buffers.get(sound.id) === promise) retainDecoded(sound.id, buffer);
    }, () => {
      if (buffers.get(sound.id) === promise) { forgetDecoded(sound.id); downloads.delete(sound.id); }
    });
  }
  return buffers.get(sound.id);
}
function stopLocalAudio() {
  generation++;
  pending.clear();
  for (const [source] of playing) { try { source.stop(); } catch {} }
  playing.clear();
}
function stopAll() {
  stopLocalAudio();
  updatePlaybackState();
}
async function play(sound) {
  if (!sound) return;
  let resume;
  try { resume = initializeAudio(); } catch { updatePlaybackState(); toast('This browser cannot play audio. Try Safari or Chrome.'); return; }
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
  const fragment = document.createDocumentFragment(), terms = searchTerms($('#search').value);
  const sounds = allSounds().filter(sound => matchesSearch(sound, terms));
  sounds.forEach(sound => {
    const row = document.createElement('div'); row.className = 'sound-row';
    const preview = document.createElement('button'); preview.className = 'sound-preview'; preview.textContent = '▶'; preview.setAttribute('aria-label', `Preview ${sound.name}`); preview.onclick = () => play(sound);
    const info = document.createElement('div'); info.className = 'sound-info';
    const name = document.createElement('strong'); name.textContent = sound.name; info.append(name);
    if (favoritePicker) { const detail = document.createElement('small'); detail.textContent = `${sound.blob ? 'Your audio' : sound.pack === 'sfx' ? 'Sound effect' : sound.pack === 'animals' ? 'Animal' : sound.pack === 'mj' ? 'Michael Jackson' : sound.pack === 'betty' ? 'Betty la fea' : sound.pack === 'ticos' ? 'Audio tico' : 'Meme'}${sound.duration ? ' · ' + sound.duration.toFixed(1) + 's' : ''}`; info.append(detail); }
    else if (sound.source) { const source = document.createElement('a'); source.textContent = `${sound.duration.toFixed(1)}s · View source ↗`; source.href = sound.source; source.target = '_blank'; source.rel = 'noopener noreferrer'; info.append(source); }
    else { const detail = document.createElement('small'); detail.textContent = `${sound.duration ? sound.duration.toFixed(1) + 's · ' : ''}On this device`; info.append(detail); }
    if (['betty', 'ticos'].includes(sound.pack) && !favoritePicker) {
      const credit = document.createElement('small'); credit.className = 'sound-context'; credit.textContent = [sound.artist, sound.context].filter(Boolean).join(' · ');
      if (credit.textContent) info.append(credit);
    }
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
        try { await storage('readwrite', store => store.delete(sound.id)); stopAll(); customs = customs.filter(item => item.id !== sound.id); favorites.delete(sound.id); saveSetting('meme-deck-favorites', [...favorites]); forgetDecoded(sound.id); renderPads(); renderLibrary(); toast('Sound removed.'); }
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
function openDialog(id) {
  if (id === 'library-dialog') renderLibrary();
  if (id === 'category-dialog') renderCategories();
  $('#' + id).showModal();
}
let recordingState = 'idle', recordingDraft = null, recordingSession = 0, reloadAfterRecording = false;
function setRecordingState(state, message) {
  recordingState = state;
  $('#recorder-dialog').dataset.state = state;
  $('#record-status').textContent = message || ({
    idle: 'Listo para grabar. Máximo 6 segundos.', requesting: 'Permite el micrófono para comenzar.',
    recording: 'Grabando… se detiene a los 6 segundos.', processing: 'Preparando tu clip…',
    ready: 'Escúchalo y guárdalo cuando esté listo.', saving: 'Guardando en este dispositivo…'
  })[state];
  $('#record-toggle').textContent = state === 'recording' ? '■ Detener' : state === 'ready' ? '● Grabar de nuevo' : '● Grabar';
  $('#record-toggle').disabled = ['requesting', 'processing', 'saving'].includes(state);
  $('#record-name').disabled = ['requesting', 'recording', 'processing', 'saving'].includes(state);
  $('#record-preview').hidden = $('#record-save').hidden = !['ready', 'saving'].includes(state);
  $('#record-preview').disabled = $('#record-save').disabled = state !== 'ready';
  $('#record-close').disabled = state === 'saving';
}
function recordingError(error) {
  const messages = {
    NotAllowedError: 'Activa el permiso del micrófono para este sitio y vuelve a intentar.',
    NotFoundError: 'No se encontró un micrófono en este dispositivo.',
    NotReadableError: 'No se pudo abrir el micrófono. Comprueba si otra app lo está usando.',
    NotSupportedError: 'Abre la app en Safari o Chrome actualizado para grabar.'
  };
  setRecordingState('idle', messages[error?.name] || 'No se pudo grabar el clip. Inténtalo de nuevo.');
}
$('#record-progress').max = MAX_RECORDING_SECONDS;
const clipRecorder = createClipRecorder({
  decode: bytes => context.decodeAudioData(bytes),
  onState: setRecordingState,
  onTick: seconds => { $('#record-time').textContent = seconds.toFixed(1); $('#record-progress').value = seconds; },
  onComplete: clip => {
    recordingDraft = { ...clip, id: crypto.randomUUID(), name: 'Grabación', category: 'Your recording' };
    $('#record-time').textContent = clip.duration.toFixed(1); $('#record-progress').value = clip.duration;
    setRecordingState('ready');
  },
  onError: recordingError
});
function discardRecording() {
  recordingSession++;
  clipRecorder.cancel();
  if (recordingDraft) forgetDecoded(recordingDraft.id);
  recordingDraft = null;
  stopAll();
}
function openRecorder() {
  if (!libraryReady) { toast('El almacenamiento local no está disponible. Reabre la app para intentarlo.'); return; }
  discardRecording();
  $('#record-name').value = `Clip ${customs.length + 1}`;
  $('#record-time').textContent = '0.0'; $('#record-progress').value = 0;
  setRecordingState('idle');
  openDialog('recorder-dialog');
}
$('#record-add').onclick = openRecorder;
$('#record-toggle').onclick = () => {
  if (recordingState === 'recording') { clipRecorder.stop(); return; }
  if (!['idle', 'ready'].includes(recordingState)) return;
  discardRecording();
  $('#record-time').textContent = '0.0'; $('#record-progress').value = 0;
  const session = recordingSession;
  try {
    initializeAudio().catch(error => {
      if (session !== recordingSession) return;
      clipRecorder.cancel(); recordingError(error);
    });
    clipRecorder.start();
  } catch (error) { recordingError(error); }
};
$('#record-preview').onclick = () => { if (recordingState === 'ready' && recordingDraft) play({ ...recordingDraft, name: $('#record-name').value.trim() || 'Grabación' }); };
$('#record-save').onclick = async () => {
  if (recordingState !== 'ready' || !recordingDraft) return;
  const sound = { ...recordingDraft, name: $('#record-name').value.trim().slice(0, 64) || 'Grabación' };
  setRecordingState('saving'); stopAll();
  try {
    await storage('readwrite', store => store.put(sound));
    customs.push(sound);
    boardQuery = ''; $('#sound-search').value = '';
    bank = 'custom'; page = Math.floor((customs.length - 1) / PAGE_SIZE);
    saveSetting('meme-deck-bank', bank);
    recordingDraft = null; setRecordingState('idle');
    $('#recorder-dialog').close(); renderPads();
    toast('Clip guardado en este dispositivo.');
  } catch { setRecordingState('ready', 'No se pudo guardar. Libera espacio y vuelve a intentarlo; tu clip sigue aquí.'); }
};
$('#recorder-dialog').addEventListener('close', () => {
  discardRecording(); setRecordingState('idle');
  if (reloadAfterRecording) location.reload();
});
$('#recorder-dialog').addEventListener('cancel', event => { if (recordingState === 'saving') event.preventDefault(); });
$('#settings-button').onclick = () => { openDialog('settings-dialog'); requestOfflineStatus(); };
$('#library-button').onclick = () => openLibrary(bank === 'fav' && !isSearching());
document.querySelectorAll('dialog .close').forEach(button => button.onclick = () => button.closest('dialog').close());
document.querySelectorAll('dialog').forEach(dialog => {
  dialog.addEventListener('click', event => { if (event.target !== dialog || (dialog.id === 'recorder-dialog' && recordingState === 'saving')) return; const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); });
  dialog.addEventListener('cancel', stopAll);
});
$('#stop').onclick = stopAll;
$('#volume').value = volume; $('#volume-value').textContent = volume;
$('#volume').oninput = event => { volume = Number(event.target.value); $('#volume-value').textContent = volume; if (master) master.gain.setTargetAtTime(volume / 100, context.currentTime, 0.01); saveSetting('meme-deck-volume', volume); };
function updateMix() { $('#mix').setAttribute('aria-pressed', overlap); $('#mix-status').textContent = overlap ? 'OVERLAP ON' : 'ONE SHOT'; }
$('#mix').onclick = () => { overlap = !overlap; if (!overlap) stopAll(); saveSetting('meme-deck-overlap', overlap); updateMix(); };
updateMix();
function selectBank(value) {
  if (!BANKS.some(item => item.id === value)) return;
  stopAll();
  boardQuery = ''; $('#sound-search').value = '';
  bank = value; page = 0;
  saveSetting('meme-deck-bank', bank);
  renderPads();
}
$('#bank-picker').onclick = () => openDialog('category-dialog');
function changePage(delta) {
  const next = Math.max(0, Math.min(Math.max(0, Math.ceil(boardSounds().length / PAGE_SIZE) - 1), page + delta));
  if (next !== page) { page = next; renderPads(); }
}
$('#previous').onclick = () => changePage(-1);
$('#next').onclick = () => changePage(1);
attachSwipePages($('#pads'), { onPage: changePage });
$('#sound-search').oninput = event => setBoardSearch(event.target.value);
$('#clear-sound-search').onclick = () => { setBoardSearch(''); $('#sound-search').focus(); };
$('#board-search').onsubmit = event => { event.preventDefault(); $('#sound-search').blur(); };
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
      customs.push(sound); buffers.set(sound.id, Promise.resolve(buffer)); retainDecoded(sound.id, buffer); count++;
    } catch { toast(`Couldn’t import ${file.name}. Try a smaller MP3, WAV or M4A.`); }
  }
  $('#import').disabled = false;
  renderPads(); renderLibrary();
  if (count) toast(`${count} ${count === 1 ? 'sound' : 'sounds'} saved on this device.`);
};
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { stopAll(); if (event.target === $('#sound-search')) { event.preventDefault(); setBoardSearch(''); $('#sound-search').blur(); } return; }
  if (event.ctrlKey || event.metaKey || event.altKey || event.repeat || event.isComposing || /INPUT|TEXTAREA|SELECT/.test(event.target.tagName) || event.target.isContentEditable || document.querySelector('dialog[open]')) return;
  const index = SHORTCUTS.indexOf(event.key.toLowerCase());
  if (index >= 0) { event.preventDefault(); play(visibleSounds()[index]); }
});
function suspendAudio() {
  stopAll();
  if (['requesting', 'recording', 'processing'].includes(recordingState)) {
    discardRecording(); setRecordingState('idle', 'Grabación cancelada al salir de la app. Toca Grabar para empezar.');
  }
}
document.addEventListener('visibilitychange', () => { if (document.hidden) suspendAudio(); });
window.addEventListener('pagehide', suspendAudio);
window.addEventListener('resize', drawScope);
async function loadCatalog() {
  try {
    const response = await fetch('sounds.json'); if (!response.ok) throw Error('Catalog unavailable');
    const sounds = await response.json();
    if (!Array.isArray(sounds)) throw Error('Invalid catalog');
    catalog = sounds; catalogFailed = false;
    for (const sound of catalog) {
      if (!sound.file || downloads.has(sound.id)) continue;
      const promise = fetch(sound.file).then(response => { if (!response.ok) throw Error('Audio unavailable'); return response.arrayBuffer(); });
      downloads.set(sound.id, promise);
      promise.catch(() => { if (downloads.get(sound.id) === promise) downloads.delete(sound.id); });
    }
  } catch { catalogFailed = true; }
  renderPads();
  if ($('#library-dialog').open) renderLibrary();
}
function showOfflineStatus(data) {
  if (data.type !== 'OFFLINE_STATUS') return;
  $('#offline').textContent = data.ready ? 'OFFLINE READY' : data.error ? 'ONLINE' : `SAVING ${data.count || 0}/${data.total || catalog.length || 170}`;
  $('#download-status').textContent = data.ready ? `${data.count} clips saved. Ready without Wi-Fi.` : data.error ? 'Offline pack unavailable. Reopen online to retry.' : `Saving sound pack… ${data.count || 0}/${data.total || catalog.length || 170}`;
}
function requestOfflineStatus() { navigator.serviceWorker?.controller?.postMessage({ type: 'GET_OFFLINE_STATUS' }); }
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', event => showOfflineStatus(event.data || {}));
  let refreshing = false;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !refreshing) {
      refreshing = true;
      // Keep an unsaved microphone clip intact while an offline update arrives.
      if ($('#recorder-dialog').open) reloadAfterRecording = true;
      else { stopAll(); location.reload(); }
    } else requestOfflineStatus();
  });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(registration => { registration.update().catch(() => {}); return navigator.serviceWorker.ready; }).then(requestOfflineStatus).catch(() => { $('#offline').textContent = 'ONLINE'; $('#download-status').textContent = 'Offline mode requires HTTPS or localhost.'; });
}
loadCatalog();
storage('readonly', store => store.getAll()).then(sounds => { customs = sounds; libraryReady = true; renderPads(); }).catch(() => { $('#storage-note').textContent = 'Local storage unavailable. Built-in clips are still playable.'; });
drawScope();
