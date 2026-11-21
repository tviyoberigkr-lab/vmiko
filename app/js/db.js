/*
 * Клієнт воркера БД для головного потоку.
 * Таймаут: якщо запит виконується довше за QUERY_TIMEOUT_MS (наприклад, випадковий CROSS JOIN на мільярди рядків),
 * воркер знищується і створюється заново (дані перевантажуються) — інтерфейс не зависає.
 * CoLaba Production
 */
const QUERY_TIMEOUT_MS = 10000;
const INIT_TIMEOUT_MS = 120000;

export function createDb({ visibleUrl, hiddenUrl, datasetVersion, onStatus = () => {} }) {
  let worker = null;
  let seq = 0;
  const pending = new Map();
  let initPromise = null;

  function spawn() {
    worker = new Worker(new URL('./db-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (ev) => {
      const { id, ok, result, error } = ev.data;
      const p = pending.get(id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(id);
      ok ? p.resolve(result) : p.reject(new Error(error));
    };
    worker.onerror = (ev) => {
      const err = new Error('Помилка воркера БД: ' + (ev.message || 'невідома'));
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(err); }
      pending.clear();
    };
  }

  function call(type, payload, timeoutMs) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Object.assign(new Error('timeout'), { code: 'timeout' }));
        restart();
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, type, ...payload });
    });
  }

  function restart() {
    try { worker.terminate(); } catch (_) {}
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Object.assign(new Error('restarted'), { code: 'restarted' })); }
    pending.clear();
    initPromise = null;
    onStatus('restarting');
    init().catch(() => {});
  }

  function init() {
    if (initPromise) return initPromise;
    spawn();
    onStatus('loading');
    initPromise = call('init', { visibleUrl, hiddenUrl, datasetVersion, dbName: 'vmiko-' + datasetVersion }, INIT_TIMEOUT_MS)
      .then((info) => { onStatus('ready', info); return info; })
      .catch((e) => { onStatus('error', e); initPromise = null; throw e; });
    return initPromise;
  }

  return {
    init,
    async run(sql) { await init(); return call('run', { sql, maxRows: 200 }, QUERY_TIMEOUT_MS); },
    async check(exercise, sql) {
      await init();
      // у воркер передаємо лише потрібні поля вправи
      return call('check', { exercise: { reference: exercise.reference, check: exercise.check }, sql }, QUERY_TIMEOUT_MS * 2);
    },
  };
}
