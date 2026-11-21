/*
 * Service worker Vmiko: офлайн-робота.
 *  - Важкі незмінні файли (PGlite, датасети) — «спершу кеш»: завантажуються один раз.
 *  - Код і контент — «спершу мережа, якщо немає — кеш»: оновлення видно одразу, офлайн теж працює.
 * Після оновлення PGlite або датасету змініть HEAVY_VERSION.
 * CoLaba Production
 */
const HEAVY_VERSION = 'heavy-pglite-0.5.17-koshyk-1.0.0';
const SHELL_VERSION = 'shell-v3';
const HEAVY = [
  'vendor/pglite/index.js',
  'vendor/pglite/chunk-BD5WXLQO.js', 'vendor/pglite/chunk-CTPU3OXM.js', 'vendor/pglite/chunk-KLBW4PNS.js',
  'vendor/pglite/chunk-N66TTF7B.js', 'vendor/pglite/chunk-UCFNZJLR.js', 'vendor/pglite/chunk-UYHX356B.js',
  'vendor/pglite/chunk-VQDTEBLE.js', 'vendor/pglite/chunk-Y6PULSM7.js', 'vendor/pglite/chunk-ZSOCVAT7.js',
  'vendor/pglite/pglite.wasm', 'vendor/pglite/pglite.data', 'vendor/pglite/initdb.wasm',
  'data/koshyk_visible.json', 'data/koshyk_hidden.json',
];
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/main.js', 'js/editor.js', 'js/storage.js', 'js/db.js', 'js/db-worker.js', 'js/sqlrunner.js', 'js/checker.js', 'js/mentor.js',
  'content/index.json', 'content/m1/day1.json', 'content/m1/day2.json', 'content/m1/day3.json', 'content/m1/day4.json',
  'content/m1/day5.json', 'content/m1/day6.json', 'content/m1/day7.json', 'content/m1/day8.json', 'content/m1/day9.json',
  'content/m1/day10.json', 'content/m1/day11.json', 'content/m1/day12.json',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const shell = await caches.open(SHELL_VERSION);
    await shell.addAll(SHELL);
    const heavy = await caches.open(HEAVY_VERSION);
    const missing = [];
    for (const u of HEAVY) if (!(await heavy.match(u))) missing.push(u);
    await heavy.addAll(missing);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== HEAVY_VERSION && k !== SHELL_VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const isHeavy = url.pathname.includes('/vendor/') || url.pathname.includes('/data/');
  if (isHeavy) {
    e.respondWith((async () => {
      const cache = await caches.open(HEAVY_VERSION);
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    })());
    return;
  }
  e.respondWith((async () => {
    const cache = await caches.open(SHELL_VERSION);
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') { const idx = await cache.match('index.html'); if (idx) return idx; }
      throw err;
    }
  })());
});
