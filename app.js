import { createClipRecorder, MAX_RECORDING_SECONDS } from './recorder.js';
import { attachSwipePages } from './swipe.js';
import { BANKS, resolveBank } from './categories.js';

const $ = selector => document.querySelector(selector);
const PAGE_SIZE = 20;
const readSetting = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const saveSetting = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* The board still works without localStorage. */ } };
const savedBank = readSetting('meme-deck-bank', 'reactions');
let catalog = [], customs = [], bank = resolveBank(savedBank), page = 0;
if (bank !== savedBank) saveSetting('meme-deck-bank', bank);
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
  const soundBank = sound.blob ? 'custom' : sound.bank;
  const collection = BANKS.find(item => item.id === soundBank);
  const text = searchTerms([sound.name, sound.label, sound.category || sound.cat, sound.context, sound.artist, sound.pack, collection?.name, ...(sound.searchAliases || [])].filter(Boolean).join(' ')).join(' ');
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
  if (selectedBank === 'fav') return allSounds().filter(sound => favorites.has(sound.id));
  if (selectedBank === 'custom') return [...customs];
  return catalog.filter(sound => sound.bank === selectedBank).sort((left, right) => left.bankOrder - right.bankOrder);
}
const categoryOptions = new Map();
const categoryIcons = {
  fav: '<path d="m12 3 2.8 5.7 6.3.9-4.5 4.4 1.1 6.2-5.7-3-5.7 3 1.1-6.2L3 9.6l6.2-.9Z"/>',
  custom: '<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M6 10v2a6 6 0 0 0 12 0v-2m-6 8v3m-3 0h6"/>',
  reactions: '<circle cx="12" cy="12" r="9"/><path d="M8 9h.01M16 9h.01M8 14s1 3 4 3 4-3 4-3"/>',
  quotes: '<path d="M5 5h14v11h-8l-5 4v-4H5Zm3 4h8m-8 3h5"/>',
  effects: '<path d="m13 2-8 12h6l-1 8 9-13h-7Z"/>',
  games: '<path d="M7 7h10c3 0 4 5 4 9 0 3-3 3-5 0H8c-2 3-5 3-5 0 0-4 1-9 4-9Zm0 4v4m-2-2h4m7-1h.01m2 2h.01"/>',
  cartoons: '<path d="m12 3 2.4 5.8L21 8l-3.7 5 3.7 5-6.6-.8L12 23l-2.4-5.8L3 18l3.7-5L3 8l6.6.8Z"/>',
  animals: '<ellipse cx="12" cy="16" rx="5" ry="4"/><ellipse cx="5" cy="9" rx="2" ry="3"/><ellipse cx="10" cy="5" rx="2" ry="3"/><ellipse cx="16" cy="6" rx="2" ry="3"/><ellipse cx="20" cy="11" rx="2" ry="3"/>',
  mj: '<path d="M5 10v4m4-8v12m4-15v18m4-14v10m4-6v2"/>',
  betty: '<path d="M3 11h18M3 11l1 6h6l1-6m2 0 1 6h6l1-6M4 11V8m16 3V8"/>',
  ticos: '<path d="M5 21V3m0 1c5-4 9 4 15 0v12c-6 4-10-4-15 0m0-8c5-4 9 4 15 0M5 12c5-4 9 4 15 0"/>',
  disfraces: '<path d="M3 5c5 3 13 3 18 0v6c0 7-6 10-9 10S3 18 3 11Zm3 6 4 1m4 0 4-1m-9 5c2 1 4 1 6 0"/>'
};
const categoryIcon = id => `<svg viewBox="0 0 24 24" aria-hidden="true">${categoryIcons[id] || categoryIcons.effects}</svg>`;
function updateCategories() {
  for (const item of BANKS) {
    const card = categoryOptions.get(item.id);
    if (!card) continue;
    const count = bankSounds(item.id).length;
    card.count.textContent = `${count} ${count === 1 ? 'sonido' : 'sonidos'}`;
    card.button.setAttribute('aria-pressed', String(item.id === bank));
    card.button.setAttribute('aria-label', `${item.name}, ${card.count.textContent}`);
  }
  const selected = BANKS.find(item => item.id === bank);
  const count = bankSounds(bank).length;
  $('#category-picker').dataset.bank = bank;
  $('#category-picker').setAttribute('aria-label', `Cambiar categoría: ${selected.name}, ${count} ${count === 1 ? 'sonido' : 'sonidos'}`);
  $('#category-name').textContent = selected.name;
  $('#category-size').textContent = `${count} ${count === 1 ? 'sonido' : 'sonidos'}`;
  $('#category-dot').innerHTML = categoryIcon(bank);
}
function renderCategories() {
  const fragment = document.createDocumentFragment();
  categoryOptions.clear();
  for (const item of BANKS) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'category-card'; button.dataset.bank = item.id;
    const icon = document.createElement('span'); icon.className = 'category-card-icon'; icon.innerHTML = categoryIcon(item.id);
    const name = document.createElement('strong'); name.className = 'category-card-name'; name.textContent = item.name;
    const count = document.createElement('small'); count.className = 'category-card-count';
    button.append(icon, name, count);
    button.onclick = () => { selectBank(item.id); closeCategories(); };
    categoryOptions.set(item.id, { button, count }); fragment.append(button);
  }
  $('#category-list').replaceChildren(fragment);
  updateCategories();
}
function openCategories() {
  updateCategories();
  $('#category-picker').setAttribute('aria-expanded', 'true');
  $('#category-dialog').showModal();
  categoryOptions.get(bank)?.button.focus();
}
function closeCategories() {
  $('#category-dialog').close();
  $('#category-picker').setAttribute('aria-expanded', 'false');
  $('#category-picker').focus({ preventScroll: true });
}
function renderPageDots(pages) {
  const indices = new Set(pages <= 7 ? Array.from({ length: pages }, (_, index) => index) : [0, pages - 1, page - 1, page, page + 1]);
  if (pages > 7 && page < 3) for (let index = 0; index < 5; index++) indices.add(index);
  if (pages > 7 && page > pages - 4) for (let index = pages - 5; index < pages; index++) indices.add(index);
  const fragment = document.createDocumentFragment(); let previous = -1;
  for (const index of [...indices].filter(index => index >= 0 && index < pages).sort((left, right) => left - right)) {
    if (previous >= 0 && index - previous > 1) {
      const gap = document.createElement('span'); gap.className = 'page-gap'; gap.textContent = '…'; gap.setAttribute('aria-hidden', 'true'); fragment.append(gap);
    }
    const dot = document.createElement('button'); dot.type = 'button'; dot.className = index === page ? 'page-dot active' : 'page-dot'; dot.dataset.page = String(index + 1);
    dot.setAttribute('aria-label', `Página ${index + 1} de ${pages}`);
    if (index === page) dot.setAttribute('aria-current', 'page');
    dot.onclick = () => {
      const retainFocus = document.activeElement === dot;
      changePage(index - page);
      if (retainFocus) [...$('#page-dots').children].find(marker => marker.dataset.page === String(index + 1))?.focus();
    };
    fragment.append(dot); previous = index;
  }
  $('#page-dots').replaceChildren(fragment);
}
function renderPads() {
  const list = boardSounds(), searching = isSearching();
  const pads = $('#pads');
  $('#library-icon').textContent = bank === 'fav' && !searching ? '★' : '＋';
  $('#library-label').textContent = bank === 'fav' && !searching ? 'AÑADIR FAVORITOS' : 'BIBLIOTECA';
  $('#record-add').hidden = bank !== 'custom' || searching;
  $('#clear-sound-search').hidden = !boardQuery;
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  page = Math.min(page, pages - 1);
  $('#page').textContent = `${String(page + 1).padStart(2, '0')} / ${String(pages).padStart(2, '0')}`;
  $('#previous').disabled = page === 0;
  $('#next').disabled = page >= pages - 1;
  $('#next-label').textContent = page >= pages - 1 ? 'Fin' : 'Más sonidos';
  renderPageDots(pages);
  $('#pagination').hidden = false;
  $('#pagination').dataset.single = String(pages === 1);
  const selectedBank = BANKS.find(item => item.id === bank);
  $('#collection-title').textContent = searching ? 'Resultados' : selectedBank.name;
  $('#collection-meta').textContent = `${list.length} ${list.length === 1 ? 'sonido' : 'sonidos'}`;
  $('#search-status').textContent = searching ? `${list.length} ${list.length === 1 ? 'sonido encontrado' : 'sonidos encontrados'}` : '';
  updateCategories();
  pads.setAttribute('aria-label', searching ? 'Resultados de búsqueda' : selectedBank.name);
  $('#sound-count').textContent = `${list.length} ${searching ? 'RESULTADOS' : selectedBank.name.toUpperCase()}`;
  const fragment = document.createDocumentFragment();
  if (!list.length) {
    const empty = document.createElement('div'); empty.className = 'empty-message';
    const title = document.createElement('strong');
    const failed = catalogFailed;
    title.textContent = searching && !failed ? 'No encontramos sonidos' : bank === 'custom' ? 'Tu propio sonido.' : bank === 'fav' ? 'Tus favoritos, a un toque.' : failed ? 'No se pudo cargar el catálogo.' : 'Cargando sonidos…';
    const text = document.createElement('p');
    text.textContent = searching && !failed ? 'Prueba otro nombre, frase o categoría.' : bank === 'custom' ? 'Graba hasta 6 segundos o importa un audio desde la biblioteca.' : bank === 'fav' ? 'Elige los memes y efectos que más usas.' : failed ? 'Comprueba la conexión y vuelve a intentar.' : 'Preparando tu colección.';
    const action = document.createElement('button'); action.className = 'primary-button';
    action.textContent = searching && !failed ? 'Limpiar búsqueda' : !['fav', 'custom'].includes(bank) ? 'Reintentar' : bank === 'fav' ? '★ Elegir favoritos' : '＋ Grabar clip';
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
          button.setAttribute('aria-label', bank === 'custom' ? 'Grabar un clip' : 'Añadir un favorito');
          const plus = document.createElement('span'); plus.className = 'pad-icon'; plus.textContent = '＋';
          const label = document.createElement('span'); label.className = 'pad-name'; label.textContent = bank === 'custom' ? 'Grabar clip' : 'Añadir favorito';
          button.append(plus, label); button.onclick = bank === 'custom' ? openRecorder : () => openLibrary(true);
        } else { button.className = 'pad empty'; button.disabled = true; button.setAttribute('aria-hidden', 'true'); }
        fragment.append(button); continue;
      }
      button.dataset.id = sound.id;
      button.dataset.bank = sound.blob ? 'custom' : sound.bank;
      button.dataset.soundName = sound.name;
      const duration = Number(sound.duration);
      const durationLabel = Number.isFinite(duration) && duration > 0 ? `${duration.toFixed(1).replace(/\.0$/, '')} s` : '';
      button.title = [sound.name, durationLabel].filter(Boolean).join(' · ');
      button.dataset.duration = durationLabel;
      button.setAttribute('aria-label', `Reproducir ${sound.name}`);
      const pieces = [['pad-number', String(page * PAGE_SIZE + index + 1).padStart(2, '0')], ['pad-name', sound.label || sound.name], ['pad-light', '']];
      for (const [className, text] of pieces) { const span = document.createElement('span'); span.className = className; span.textContent = text; span.setAttribute('aria-hidden', 'true'); button.append(span); }
      button.addEventListener('click', () => play(sound));
      const slot = document.createElement('div'); slot.className = 'pad-slot'; slot.dataset.bank = button.dataset.bank;
      const favorite = document.createElement('button'); favorite.type = 'button'; favorite.className = 'pad-favorite'; favorite.dataset.soundId = sound.id;
      favorite.onclick = () => togglePadFavorite(sound, favorite);
      slot.append(button, favorite); fragment.append(slot);
    }
  }
  pads.replaceChildren(fragment);
  updatePadState();
}
function updatePadState() {
  document.querySelectorAll('.pad[data-id]').forEach(button => {
    const live = [...playing.values()].some(item => item.sound.id === button.dataset.id);
    const loading = [...pending.values()].some(sound => sound.id === button.dataset.id);
    button.classList.toggle('playing', live);
    button.classList.toggle('loading', loading);
    button.classList.toggle('is-favorite', favorites.has(button.dataset.id));
    button.setAttribute('aria-pressed', String(live));
    button.setAttribute('aria-busy', String(loading));
    const favorite = [...button.parentNode.children].find(child => child.classList.contains('pad-favorite'));
    if (favorite) {
      const selected = favorites.has(button.dataset.id);
      favorite.textContent = selected ? '★' : '☆';
      favorite.setAttribute('aria-pressed', String(selected));
      favorite.setAttribute('aria-label', `${selected ? 'Quitar de favoritos' : 'Añadir a favoritos'}: ${button.dataset.soundName}`);
      favorite.title = selected ? 'Quitar de favoritos' : 'Añadir a favoritos';
    }
  });
}
function togglePadFavorite(sound, button) {
  const retainFocus = document.activeElement === button;
  const stars = [...document.querySelectorAll('.pad-favorite')], previousIndex = stars.indexOf(button);
  favorites.has(sound.id) ? favorites.delete(sound.id) : favorites.add(sound.id);
  saveSetting('meme-deck-favorites', [...favorites]);
  if (bank === 'fav' && !isSearching()) {
    renderPads();
    if (retainFocus) {
      const remaining = [...document.querySelectorAll('.pad-favorite')];
      const next = remaining.find(star => star.dataset.soundId === sound.id) || remaining[Math.min(previousIndex, remaining.length - 1)] || $('#library-button');
      next.focus({ preventScroll: true });
    }
  } else { updatePadState(); updateCategories(); }
  updateFavoriteCount();
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
  try { resume = initializeAudio(); } catch { updatePlaybackState(); toast('Este navegador no puede reproducir audio. Prueba Safari o Chrome.'); return; }
  if (!overlap) stopAll();
  const currentGeneration = generation, request = Symbol();
  pending.set(request, sound); updatePadState();
  $('#state').textContent = 'CARGANDO'; $('#now-playing').textContent = sound.name;
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
    if (currentGeneration === generation) toast(`No se pudo reproducir ${sound.name}. Conéctate para descargar los sonidos.`);
  } finally { pending.delete(request); updatePlaybackState(); }
}
function updatePlaybackState() {
  updatePadState();
  const latest = [...playing.values()].at(-1);
  $('#state').textContent = latest ? 'SONANDO' : pending.size ? 'CARGANDO' : 'LISTO';
  $('#now-playing').textContent = latest?.sound.name || [...pending.values()].at(-1)?.name || lastSound?.name || 'Elige un sonido.';
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
    const preview = document.createElement('button'); preview.className = 'sound-preview'; preview.textContent = '▶'; preview.setAttribute('aria-label', `Escuchar ${sound.name}`); preview.onclick = () => play(sound);
    const info = document.createElement('div'); info.className = 'sound-info';
    const name = document.createElement('strong'); name.textContent = sound.name; info.append(name);
    if (favoritePicker) { const detail = document.createElement('small'); detail.textContent = `${sound.blob ? 'Tu audio' : sound.pack === 'sfx' ? 'Efecto de sonido' : sound.pack === 'cartoons' ? 'Cartoon clásico' : sound.pack === 'games' ? 'Videojuego clásico' : sound.pack === 'animals' ? 'Animal' : sound.pack === 'mj' ? 'Michael Jackson' : sound.pack === 'betty' ? 'Betty la fea' : sound.pack === 'ticos' ? 'Audio tico' : sound.pack === 'disfraces' ? 'Disfraces' : 'Meme'}${sound.duration ? ' · ' + sound.duration.toFixed(1) + 's' : ''}`; info.append(detail); }
    else if (sound.source) { const source = document.createElement('a'); source.textContent = `${sound.duration.toFixed(1)}s · ${sound.attributions?.length ? 'Música base' : 'Ver fuente'} ↗`; source.href = sound.source; source.target = '_blank'; source.rel = 'noopener noreferrer'; info.append(source); }
    else { const detail = document.createElement('small'); detail.textContent = `${sound.duration ? sound.duration.toFixed(1) + 's · ' : ''}En este dispositivo`; info.append(detail); }
    if (['betty', 'ticos', 'cartoons', 'games', 'disfraces'].includes(sound.pack) && !favoritePicker) {
      const credit = document.createElement('small'); credit.className = 'sound-context'; credit.textContent = [sound.artist, sound.context].filter(Boolean).join(' · ');
      if (credit.textContent) info.append(credit);
    }
    if (sound.attributions?.length && !favoritePicker) {
      const credits = document.createElement('details'); credits.className = 'sound-credits';
      const heading = document.createElement('summary'); heading.textContent = 'Créditos de la mezcla'; credits.append(heading);
      for (const attribution of sound.attributions) {
        const line = document.createElement('small'); line.className = 'sound-context';
        const link = document.createElement('a'); link.textContent = attribution.title; link.href = attribution.source; link.target = '_blank'; link.rel = 'noopener noreferrer'; line.append(link);
        if (attribution.license) {
          const license = document.createElement('a'); license.textContent = attribution.license; license.href = attribution.licenseUrl; license.target = '_blank'; license.rel = 'noopener noreferrer'; line.append(license);
        }
        credits.append(line);
      }
      info.append(credits);
    }
    const favorite = document.createElement('button'); favorite.className = 'favorite'; favorite.textContent = favorites.has(sound.id) ? '★' : '☆'; favorite.setAttribute('aria-label', `Favorito: ${sound.name}`); favorite.setAttribute('aria-pressed', favorites.has(sound.id));
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
      const remove = document.createElement('button'); remove.className = 'delete-sound'; remove.textContent = '×'; remove.setAttribute('aria-label', `Eliminar ${sound.name}`);
      remove.onclick = async () => {
        if (!confirm(`¿Eliminar “${sound.name}” de este dispositivo? Conserva el archivo original como respaldo.`)) return;
        try { await storage('readwrite', store => store.delete(sound.id)); stopAll(); customs = customs.filter(item => item.id !== sound.id); favorites.delete(sound.id); saveSetting('meme-deck-favorites', [...favorites]); forgetDecoded(sound.id); renderPads(); renderLibrary(); toast('Sonido eliminado.'); }
        catch { toast('No se pudo eliminar el sonido. Inténtalo de nuevo.'); }
      }; row.append(remove);
    }
    fragment.append(row);
  });
  if (!sounds.length) { const empty = document.createElement('p'); empty.className = 'dialog-note'; empty.textContent = 'No encontramos sonidos. Importa un clip para añadir el tuyo.'; fragment.append(empty); }
  $('#sound-list').replaceChildren(fragment);
  updateFavoriteCount();
}
function updateFavoriteCount() {
  const count = allSounds().filter(sound => favorites.has(sound.id)).length;
  $('#favorite-count').textContent = `${count} ${count === 1 ? 'favorito seleccionado' : 'favoritos seleccionados'}`;
}
function openLibrary(pickFavorites = false) {
  favoritePicker = pickFavorites;
  $('#library-dialog').classList.toggle('favorite-mode', pickFavorites);
  $('#library-title').textContent = pickFavorites ? 'Elige tus favoritos' : 'Biblioteca de sonidos';
  $('#library-note').textContent = pickFavorites ? 'Toca un sonido o ☆ para añadirlo. Se guarda al instante.' : 'Toca ★ para guardar un favorito. Tus clips se guardan en este dispositivo.';
  $('#import').hidden = pickFavorites;
  $('#storage-note').hidden = pickFavorites;
  $('#favorite-actions').hidden = !pickFavorites;
  $('#search').value = '';
  openDialog('library-dialog');
}
$('#favorites-done').onclick = () => $('#library-dialog').close();
function openDialog(id) {
  if (id === 'library-dialog') renderLibrary();
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
function updateMix() { $('#mix').setAttribute('aria-pressed', overlap); $('#mix-status').textContent = overlap ? 'SUPERPUESTOS' : 'UNO A LA VEZ'; }
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
$('#category-picker').onclick = openCategories;
$('#category-close').onclick = closeCategories;
$('#category-dialog').addEventListener('close', () => $('#category-picker').setAttribute('aria-expanded', 'false'));
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
$('#import').onclick = () => { if (!libraryReady) { toast('El almacenamiento local no está disponible. Puedes usar los sonidos incluidos.'); return; } try { initializeAudio().catch(() => {}); } catch { toast('Usa Safari o Chrome para importar audio.'); return; } $('#files').click(); };
$('#files').onchange = async event => {
  const files = [...event.target.files]; event.target.value = '';
  if (!files.length) return;
  try { initializeAudio().catch(() => {}); } catch { toast('Usa Safari o Chrome para importar audio.'); return; }
  $('#import').disabled = true;
  let count = 0;
  for (const file of files) {
    if (file.size > 25 * 1024 * 1024) { toast(`${file.name}: el tamaño máximo es 25 MB.`); continue; }
    try {
      const buffer = await context.decodeAudioData(await file.arrayBuffer());
      if (buffer.duration > 120) { toast(`${file.name}: elige un clip de menos de 2 minutos.`); continue; }
      const sound = { id: crypto.randomUUID(), name: file.name.replace(/\.[^.]+$/, '').slice(0, 64), category: 'Your audio', icon: '♫', blob: file, duration: buffer.duration };
      await storage('readwrite', store => store.put(sound));
      customs.push(sound); buffers.set(sound.id, Promise.resolve(buffer)); retainDecoded(sound.id, buffer); count++;
    } catch { toast(`No se pudo importar ${file.name}. Prueba un MP3, WAV o M4A más pequeño.`); }
  }
  $('#import').disabled = false;
  renderPads(); renderLibrary();
  if (count) toast(`${count} ${count === 1 ? 'sonido guardado' : 'sonidos guardados'} en este dispositivo.`);
};
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { stopAll(); if (event.target === $('#sound-search')) { event.preventDefault(); setBoardSearch(''); $('#sound-search').blur(); } return; }
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
  $('#offline').textContent = data.ready ? 'SIN CONEXIÓN ✓' : data.error ? 'EN LÍNEA' : `GUARDANDO ${data.count || 0}/${data.total || catalog.length || 221}`;
  $('#download-status').textContent = data.ready ? `${data.count} clips guardados. Listos para usar sin conexión.` : data.error ? 'Los sonidos aún no están disponibles sin conexión. Reabre la app con internet.' : `Guardando sonidos… ${data.count || 0}/${data.total || catalog.length || 221}`;
}
function requestOfflineStatus() { navigator.serviceWorker?.controller?.postMessage({ type: 'GET_OFFLINE_STATUS' }); }
let manualRefreshInProgress = false;
function waitForUpdate(worker) {
  return new Promise((resolve, reject) => {
    let timer;
    const finish = error => {
      clearTimeout(timer); worker.removeEventListener('statechange', check);
      error ? reject(error) : resolve();
    };
    const check = () => {
      if (worker.state === 'activated') finish();
      else if (worker.state === 'redundant') finish(new Error('Update installation failed'));
    };
    worker.addEventListener('statechange', check);
    timer = setTimeout(() => finish(new Error('Update timed out')), 180000);
    if (worker.state === 'installed') worker.postMessage({ type: 'SKIP_WAITING' });
    check();
  });
}
$('#refresh-app').onclick = async () => {
  const button = $('#refresh-app'), status = $('#refresh-status');
  if (manualRefreshInProgress) return;
  manualRefreshInProgress = true; button.disabled = true;
  status.textContent = 'Buscando la versión más reciente…';
  try {
    // The query bypasses the service worker and no-store bypasses the HTTP cache.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let response;
    try { response = await fetch(`sw.js?refresh=${Date.now()}`, { cache: 'no-store', redirect: 'error', signal: controller.signal }); }
    finally { clearTimeout(timeout); }
    if (!response.ok || !(response.headers.get('content-type') || '').toLowerCase().includes('javascript')) throw new Error('Update server unavailable');
    if ('serviceWorker' in navigator) {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration) {
        let worker = registration.installing || registration.waiting;
        const found = () => { worker = registration.installing || worker; };
        registration.addEventListener('updatefound', found);
        try {
          await registration.update();
          worker = registration.installing || registration.waiting || worker;
          if (worker) {
            status.textContent = 'Descargando la actualización y los sonidos…';
            await waitForUpdate(worker);
          }
        } finally { registration.removeEventListener('updatefound', found); }
      }
    }
    status.textContent = 'Actualización lista. Abriendo la app…';
    stopAll(); location.reload();
  } catch (_) {
    status.textContent = 'No se pudo actualizar. Revisa tu conexión e inténtalo de nuevo.';
    button.disabled = false; manualRefreshInProgress = false;
  }
};
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', event => showOfflineStatus(event.data || {}));
  let refreshing = false;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (manualRefreshInProgress) { requestOfflineStatus(); return; }
    if (hadController && !refreshing) {
      refreshing = true;
      // Keep an unsaved microphone clip intact while an offline update arrives.
      if ($('#recorder-dialog').open) reloadAfterRecording = true;
      else { stopAll(); location.reload(); }
    } else requestOfflineStatus();
  });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(registration => { registration.update().catch(() => {}); return navigator.serviceWorker.ready; }).then(requestOfflineStatus).catch(() => { $('#offline').textContent = 'EN LÍNEA'; $('#download-status').textContent = 'El modo sin conexión requiere HTTPS o localhost.'; });
}
renderCategories();
loadCatalog();
storage('readonly', store => store.getAll()).then(sounds => { customs = sounds; libraryReady = true; renderPads(); }).catch(() => { $('#storage-note').textContent = 'El almacenamiento local no está disponible. Puedes reproducir los sonidos incluidos.'; });
drawScope();
