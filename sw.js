/* Increment VERSION whenever the app shell or bundled sound catalog changes. */
const VERSION = 'meme-deck-v11-github-pages';
const BASE = new URL('./', self.registration.scope);
// CacheStorage is shared by every project on a GitHub Pages origin.
const CACHE_PREFIX = `meme-deck-scope:${encodeURIComponent(BASE.pathname)}:`;
const CACHE_NAME = CACHE_PREFIX + VERSION;
const SHELL = ['index.html', 'style.css', 'themes.css', 'themes.js', 'app.js', 'manifest.json', 'icon-192.png', 'icon-512.png', 'icon-180.png'];
const absolute = path => new URL(path, BASE).href;
const shellURLs = new Set(SHELL.map(absolute));
let catalogPromise;
let filling;

function validCatalog(value) {
  if (!Array.isArray(value) || !value.length || value.length > 128) throw new Error('Invalid sound catalog');
  const paths = new Set();
  for (const sound of value) {
    if (!/^audio\/[a-z0-9-]+\.mp3$/.test(sound.file) || !/^[a-f0-9]{64}$/.test(sound.sha256) || paths.has(sound.file)) {
      throw new Error('Invalid sound file');
    }
    paths.add(sound.file);
  }
  return value;
}

async function fetchAsset(path, sound) {
  const url = absolute(path);
  const response = await fetch(url, { cache: 'reload', credentials: 'same-origin', redirect: 'error' });
  if (!response.ok || response.type === 'opaque' || response.redirected || (response.url && response.url !== url)) throw new Error('Asset unavailable: ' + path);
  const type = (response.headers.get('content-type') || '').toLowerCase();
  if (path === 'index.html') {
    const html = await response.clone().text();
    if (!type.includes('text/html') || !/src=["'](?:\.\/)?app\.js["']/.test(html) || !/rel=["']manifest["']/.test(html)) throw new Error('App sign-in required');
  } else {
    if (type.includes('text/html')) throw new Error('Unexpected sign-in response');
    if (sound) {
      const bytes = await response.clone().arrayBuffer();
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
      if (hash !== sound.sha256) throw new Error('Sound verification failed: ' + sound.id);
    }
  }
  return response;
}

async function getCatalog() {
  if (!catalogPromise) {
    catalogPromise = (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(absolute('sounds.json'));
      if (cached) return validCatalog(await cached.json());
      const response = await fetchAsset('sounds.json');
      const catalog = validCatalog(await response.clone().json());
      await cache.put(absolute('sounds.json'), response);
      return catalog;
    })().catch(error => { catalogPromise = null; throw error; });
  }
  return catalogPromise;
}

async function offlineStatus() {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(absolute('sounds.json'));
  let catalog = [];
  try { if (cached) catalog = validCatalog(await cached.json()); } catch (_) { /* Incomplete installation. */ }
  const count = (await Promise.all(catalog.map(sound => cache.match(absolute(sound.file))))).filter(Boolean).length;
  const hasShell = (await Promise.all(SHELL.map(path => cache.match(absolute(path))))).every(Boolean);
  return { type: 'OFFLINE_STATUS', version: VERSION, count, total: catalog.length, ready: catalog.length > 0 && count === catalog.length && hasShell };
}

async function broadcastStatus(error) {
  const status = await offlineStatus();
  if (error) status.error = error.message || String(error);
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  for (const client of clients) if (client.url.startsWith(BASE.href)) client.postMessage(status);
  return status;
}

function cacheOffline() {
  if (filling) return filling;
  filling = (async () => {
    const cache = await caches.open(CACHE_NAME);
    for (const path of SHELL) {
      if (!(await cache.match(absolute(path)))) await cache.put(absolute(path), await fetchAsset(path));
    }
    const catalog = await getCatalog();
    await broadcastStatus();
    // Small serial downloads keep memory and bandwidth pressure low on iPhones.
    for (const sound of catalog) {
      if (!(await cache.match(absolute(sound.file)))) await cache.put(absolute(sound.file), await fetchAsset(sound.file, sound));
      await broadcastStatus();
    }
    return offlineStatus();
  })().finally(() => { filling = null; });
  return filling;
}

self.addEventListener('install', event => {
  event.waitUntil(cacheOffline().then(() => self.skipWaiting()).catch(async error => {
    await broadcastStatus(error);
    await caches.delete(CACHE_NAME);
    throw error; // Keep the previous working version until every new asset is available.
  }));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    // Legacy unscoped names may belong to another installation; leave them alone.
    await Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map(key => caches.delete(key)));
    await self.clients.claim();
    await broadcastStatus();
  })());
});

self.addEventListener('message', event => {
  const type = event.data && event.data.type;
  const reply = value => {
    if (event.ports && event.ports[0]) event.ports[0].postMessage(value);
    else if (event.source) event.source.postMessage(value);
  };
  if (type === 'GET_OFFLINE_STATUS') event.waitUntil(offlineStatus().then(reply));
  if (type === 'CACHE_OFFLINE') event.waitUntil(cacheOffline().then(reply).catch(async error => reply(await broadcastStatus(error))));
  if (type === 'SKIP_WAITING') event.waitUntil(self.skipWaiting());
});

async function audioRange(response, rangeHeader) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader || '');
  if (!match) return response;
  const buffer = await response.arrayBuffer();
  const length = buffer.byteLength;
  const start = match[1] ? Number(match[1]) : Math.max(0, length - Number(match[2]));
  const end = match[1] ? (match[2] ? Math.min(Number(match[2]), length - 1) : length - 1) : length - 1;
  if ((!match[1] && !match[2]) || start >= length || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + length } });
  const headers = new Headers(response.headers);
  headers.set('Content-Range', `bytes ${start}-${end}/${length}`);
  headers.set('Content-Length', String(end - start + 1));
  headers.set('Accept-Ranges', 'bytes');
  return new Response(buffer.slice(start, end + 1), { status: 206, statusText: 'Partial Content', headers });
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== BASE.origin || url.search || !url.pathname.startsWith(BASE.pathname)) return;
  const path = url.pathname.slice(BASE.pathname.length);
  const isAppPage = event.request.mode === 'navigate' && (path === '' || path === 'index.html');
  const isShell = shellURLs.has(url.href) || path === 'sounds.json';
  const isAudio = /^audio\/[a-z0-9-]+\.mp3$/.test(path);
  if (!isAppPage && !isShell && !isAudio) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const key = isAppPage ? absolute('index.html') : url.href;
    const cached = await cache.match(key);
    if (cached) return isAudio && event.request.headers.has('range') ? audioRange(cached, event.request.headers.get('range')) : cached;
    // Only catalogued audio and the exact application shell may enter this cache.
    const sound = isAudio ? (await getCatalog()).find(item => absolute(item.file) === key) : null;
    if (isAudio && !sound) return fetch(event.request);
    const response = await fetchAsset(isAppPage ? 'index.html' : path, sound);
    await cache.put(key, response.clone());
    if (isAudio && event.request.headers.has('range')) return audioRange(response, event.request.headers.get('range'));
    return response;
  })().catch(() => new Response('This file is not available offline yet. Reconnect and open Meme Deck once.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })));
});
