/*
 * Service worker Vmiko: офлайн-робота.
 *  - Важкі незмінні файли (PGlite, датасети) — «спершу кеш». У install їх НЕ завантажуємо:
 *    heavy-кеш наповнюється лише в fetch-обробнику, коли воркер БД реально запитує файл.
 *    Так кожен байт іде з мережі один раз (раніше install і воркер тягнули ті самі ~16 МБ паралельно —
 *    див. docs/decisions.md, Р9). Сторінка чекає, поки цей SW візьме її під контроль, і лише тоді стартує БД.
 *  - Код і контент — «спершу мережа, якщо немає — кеш»: оновлення видно одразу, офлайн теж працює.
 *
 * Версії: HEAVY_VERSION складається з версії PGlite і dataset_version. Їх збіг із
 * app/vendor/pglite/package.json, content/*.json і meta датасетів перевіряє tools/check_versions.js
 * (без нього тест падає — забути підняти версію не вийде).
 * Датасети запитуються з ?v=<dataset_version> і кешуються З урахуванням цього параметра,
 * тож навіть при незмінному HEAVY_VERSION новий датасет не підміниться старим.
 * CoLaba Production
 */
const PGLITE_VERSION = '0.5.17';
const DATASET_VERSION = 'koshyk-1.0.0';
const HEAVY_VERSION = `heavy-pglite-${PGLITE_VERSION}-${DATASET_VERSION}`;
const SHELL_VERSION = 'shell-v4';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/main.js', 'js/editor.js', 'js/storage.js', 'js/db.js', 'js/db-worker.js', 'js/sqlrunner.js', 'js/checker.js', 'js/mentor.js', 'js/perf.js',
  'content/index.json', 'content/m1/day1.json', 'content/m1/day2.json', 'content/m1/day3.json', 'content/m1/day4.json',
  'content/m1/day5.json', 'content/m1/day6.json', 'content/m1/day7.json', 'content/m1/day8.json', 'content/m1/day9.json',
  'content/m1/day10.json', 'content/m1/day11.json', 'content/m1/day12.json',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-512-maskable.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const shell = await caches.open(SHELL_VERSION);
    await shell.addAll(SHELL);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== HEAVY_VERSION && k !== SHELL_VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

// Для ?perf=1: скільки байтів сам SW отримав з мережі (його Resource Timing; запити, віддані сторінці/воркеру
// через SW, у їхніх власних таймлайнах мають transferSize 0). Лічильник скидається, коли браузер зупиняє SW.
self.addEventListener('message', (e) => {
  if (!e.data || e.data.type !== 'vmiko-net-stats' || !e.ports[0]) return;
  let transfer = 0, decoded = 0, n = 0;
  for (const r of performance.getEntriesByType('resource')) { transfer += r.transferSize || 0; decoded += r.decodedBodySize || 0; n++; }
  e.ports[0].postMessage({ transfer, decoded, requests: n });
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const isData = url.pathname.includes('/data/');
  const isHeavy = isData || url.pathname.includes('/vendor/');
  if (isHeavy) {
    e.respondWith((async () => {
      const cache = await caches.open(HEAVY_VERSION);
      // для датасетів параметр ?v= — частина ключа (версія даних); для vendor — ігноруємо
      const hit = await cache.match(req, { ignoreSearch: !isData });
      if (hit) return hit;
      const res = await fetch(req);
      // кладемо в кеш паралельно з віддачею тіла воркеру (tee), без повторного запиту в мережу
      if (res.ok && res.status === 200) e.waitUntil(cache.put(req, res.clone()).catch((err) => console.warn('[sw] не вдалося закешувати', url.pathname, err)));
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
