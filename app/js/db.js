/*
 * Клієнт воркера БД для головного потоку.
 *
 * Таймаут запиту: якщо запит виконується довше за QUERY_TIMEOUT_MS (наприклад, випадковий CROSS JOIN на мільярди рядків),
 * воркер знищується і створюється заново (дані беруться з IndexedDB) — інтерфейс не зависає.
 *
 * Ініціалізація: таймер рахує НЕ загальний час, а час БЕЗ ПРОГРЕСУ (нових байтів або нового етапу від воркера).
 * На 3G перший старт може тривати хвилини — це нормально, поки байти йдуть. Якщо прогресу немає
 * STALL_NET_MS (етапи з мережею) або STALL_CPU_MS (запуск Postgres, імпорт — там байтів немає, лише робота процесора),
 * воркер перезапускається. Автоматичних перезапусків — не більше MAX_AUTO_RESTARTS, далі статус 'error'
 * і кнопка «Спробувати ще» (retry()). Подія 'online' після помилки теж запускає повтор.
 *
 * onStatus(status, info):
 *   'loading'    info = { stage, loaded, total, attempt } — прогрес (часто, ~5 разів/с);
 *   'restarting' info = { attempt, reason };
 *   'ready'      info = відповідь воркера (timings, fromCache, persistent, recovered, net…);
 *   'error'      info = Error з .code: 'stall' | 'network' | 'http' | 'failed'.
 * Пошкоджена база в IndexedDB (code 'corrupt-idb' від воркера): воркер знищується, новий стартує з wipeFirst —
 * стирає базу і імпортує дані заново; це не рахується в ліміт автоперезапусків (але лише раз за серію).
 * CoLaba Production
 */
const QUERY_TIMEOUT_MS = 10000;
// globalThis.__VMIKO_STALL_MS__ = { net, cpu } — лише для автотесту (tools/smoke_browser.py), у роботі не задається
const STALL_OVERRIDE = (typeof globalThis !== 'undefined' && globalThis.__VMIKO_STALL_MS__) || {};
const STALL_NET_MS = STALL_OVERRIDE.net || 30000;
const STALL_CPU_MS = STALL_OVERRIDE.cpu || 90000;
const CPU_STAGES = new Set(['engine-init', 'import', 'verify']);
const MAX_AUTO_RESTARTS = 2;
const RESTART_DELAYS_MS = [1000, 4000];

export function createDb({ visibleUrl, hiddenUrl, datasetVersion, onStatus = () => {} }) {
  let worker = null;
  let seq = 0;
  const pending = new Map();
  let initPromise = null;
  let lastStatus = 'idle';
  const status = (s, info) => { lastStatus = s; onStatus(s, info); };

  // прогрес поточної спроби ініціалізації
  let progress = { stage: '', loaded: 0, total: 0, at: 0 };
  let onProgress = null;

  function spawn() {
    worker = new Worker(new URL('./db-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (ev) => {
      const m = ev.data;
      if (m && m.type === 'progress') {
        if (m.stage !== progress.stage || m.loaded !== progress.loaded) progress = { ...m, at: Date.now() };
        if (onProgress) onProgress(m);
        return;
      }
      const { id, ok, result, error, code } = m;
      const p = pending.get(id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(id);
      ok ? p.resolve(result) : p.reject(Object.assign(new Error(error), { code: code || 'failed' }));
    };
    worker.onerror = (ev) => {
      const err = Object.assign(new Error('Помилка воркера БД: ' + (ev.message || 'невідома')), { code: 'failed' });
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(err); }
      pending.clear();
    };
  }

  function kill() {
    try { if (worker) worker.terminate(); } catch (_) {}
    worker = null;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Object.assign(new Error('restarted'), { code: 'restarted' })); }
    pending.clear();
  }

  function call(type, payload, timeoutMs) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => {
        pending.delete(id);
        reject(Object.assign(new Error('timeout'), { code: 'timeout' }));
        restart();
      }, timeoutMs) : null;
      pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, type, ...payload });
    });
  }

  /** Одна спроба: новий воркер, init, сторож «немає прогресу». */
  function attemptOnce(attempt, wipeFirst) {
    spawn();
    progress = { stage: 'start', loaded: 0, total: 0, at: Date.now() };
    return new Promise((resolve, reject) => {
      let lastEmit = 0;
      onProgress = (m) => {
        const now = Date.now();
        if (now - lastEmit < 250 && m.stage === progress.stage && m.loaded !== m.total) return; // не частіше 4 разів/с
        lastEmit = now;
        status('loading', { stage: m.stage, loaded: m.loaded, total: m.total, files: m.files, attempt });
      };
      const watchdog = setInterval(() => {
        const limit = CPU_STAGES.has(progress.stage) ? STALL_CPU_MS : STALL_NET_MS;
        if (Date.now() - progress.at > limit) {
          clearInterval(watchdog);
          reject(Object.assign(new Error(`немає прогресу ${Math.round(limit / 1000)} с (етап ${progress.stage || 'start'})`), { code: 'stall' }));
        }
      }, 1000);
      call('init', { visibleUrl, hiddenUrl, datasetVersion, dbName: 'vmiko-' + datasetVersion, wipeFirst }, 0)
        .then(resolve, reject)
        .finally(() => { clearInterval(watchdog); onProgress = null; });
    });
  }

  function init() {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      status('loading', { stage: 'start', loaded: 0, total: 0, attempt: 0 });
      let wipe = false;
      for (let attempt = 0; ; attempt++) {
        try {
          const info = await attemptOnce(attempt, wipe);
          status('ready', info);
          return info;
        } catch (e) {
          kill();
          if (e.code === 'corrupt-idb' && !wipe) {
            // пошкоджена база в IndexedDB: новий воркер зітре її до відкриття і імпортує дані заново (не рахується як збій)
            console.warn('[db] ' + e.message + ' — стираю базу і завантажую заново');
            wipe = true; attempt--;
            status('restarting', { attempt: 0, reason: 'corrupt-idb' });
            continue;
          }
          if (attempt >= MAX_AUTO_RESTARTS) throw e;
          console.warn(`[db] спроба ${attempt + 1} не вдалась (${e.code}: ${e.message}) — перезапуск`);
          status('restarting', { attempt: attempt + 1, reason: e.code });
          await new Promise((r) => setTimeout(r, RESTART_DELAYS_MS[attempt] || 4000));
        }
      }
    })().catch((e) => { initPromise = null; status('error', e); throw e; });
    return initPromise;
  }

  /** Перезапуск після таймауту запиту: база вже в IndexedDB, тож це швидко. */
  function restart() {
    kill();
    initPromise = null;
    status('restarting', { attempt: 0, reason: 'query-timeout' });
    init().catch(() => {});
  }

  /** Кнопка «Спробувати ще» / подія online: нова серія спроб із нуля. */
  function retry() {
    if (initPromise) return initPromise;
    return init();
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => { if (lastStatus === 'error') retry().catch(() => {}); });
  }

  return {
    init,
    retry,
    get status() { return lastStatus; },
    async run(sql) { await init(); return call('run', { sql, maxRows: 200 }, QUERY_TIMEOUT_MS); },
    async check(exercise, sql) {
      await init();
      // у воркер передаємо лише потрібні поля вправи
      return call('check', { exercise: { reference: exercise.reference, check: exercise.check }, sql }, QUERY_TIMEOUT_MS * 2);
    },
  };
}

/**
 * Реєструє service worker і чекає (не довше waitMs), поки він візьме сторінку під контроль.
 * Навіщо чекати: воркер БД, створений ПІСЛЯ цього, теж контролюється SW, і його запити
 * (pglite.wasm, датасети) кешуються SW з першого ж разу — кожен байт з мережі один раз.
 * Якщо SW недоступний або не встиг — БД стартує без нього (дані завантажаться, просто не закешуються цього разу).
 * Повертає { controlled, waitedMs }.
 */
export async function ensureServiceWorker(url, waitMs = 5000) {
  const t0 = performance.now();
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return { controlled: false, waitedMs: 0 };
  const reg = navigator.serviceWorker.register(url).catch((e) => { console.warn('SW не зареєстровано', e); return null; });
  if (navigator.serviceWorker.controller) return { controlled: true, waitedMs: 0 };
  const controlled = await Promise.race([
    new Promise((res) => navigator.serviceWorker.addEventListener('controllerchange', () => res(true), { once: true })),
    reg.then((r) => (r ? new Promise(() => {}) : false)),
    new Promise((res) => setTimeout(() => res(false), waitMs)),
  ]);
  return { controlled: !!navigator.serviceWorker.controller || controlled, waitedMs: Math.round(performance.now() - t0) };
}
