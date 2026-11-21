/*
 * Воркер бази даних: PostgreSQL (PGlite, WASM) в окремому потоці, щоб інтерфейс не завмирав.
 * Протокол: { id, type: 'init'|'run'|'check', ... } -> { id, ok, result | error }
 * CoLaba Production
 */
import { PGlite } from '../vendor/pglite/index.js';
import { loadDataset, runReadOnly, checkExercise, VISIBLE, HIDDEN } from './sqlrunner.js';

let db = null;
let ready = null;

async function openDb(dbName) {
  // Спершу — постійна база в IndexedDB: при повторному запуску не треба заново ініціалізувати Postgres і вантажити дані.
  if (dbName) {
    try {
      // relaxedDurability НЕ вмикати: перевірено — при швидкому перезавантаженні сторінки база в IndexedDB лишається неповною (ErrnoError).
      const d = new PGlite('idb://' + dbName);
      await d.waitReady;
      return { d, persistent: true };
    } catch (e) {
      console.warn('[db] IndexedDB недоступна, працюю в пам\'яті', e);
    }
  }
  const d = new PGlite();
  await d.waitReady;
  return { d, persistent: false };
}

async function loadedVersions(d) {
  try {
    const r = await d.query('SELECT schema_name, dataset_version FROM public._vmiko_meta');
    return Object.fromEntries(r.rows.map((x) => [x.schema_name, x.dataset_version]));
  } catch (_) { return {}; }
}

async function init(args) {
  try {
    return await initOnce(args, true);
  } catch (e) {
    // Пошкоджена база в IndexedDB (наприклад, вкладку закрили посеред завантаження) — стираємо і працюємо в пам'яті.
    console.warn('[db] постійна база не відкрилась, перехід у пам\'ять', e);
    try { if (db) await db.close(); } catch (_) {}
    try { indexedDB.deleteDatabase('/pglite/' + args.dbName); } catch (_) {}
    return initOnce(args, false);
  }
}

async function initOnce({ visibleUrl, hiddenUrl, dbName, datasetVersion }, usePersistent) {
  const t0 = performance.now();
  const opened = await openDb(usePersistent ? dbName : null);
  db = opened.d;
  const t1 = performance.now();
  const have = await loadedVersions(db);
  let fromCache = have[VISIBLE] === datasetVersion && have[HIDDEN] === datasetVersion;
  let t2 = t1;
  if (!fromCache) {
    const [vis, hid] = await Promise.all([fetch(visibleUrl).then((r) => r.json()), fetch(hiddenUrl).then((r) => r.json())]);
    t2 = performance.now();
    await loadDataset(db, vis, VISIBLE);
    await loadDataset(db, hid, HIDDEN);
  }
  const t3 = performance.now();
  return {
    datasetVersion: (await loadedVersions(db))[VISIBLE],
    persistent: opened.persistent,
    fromCache,
    timings: { pgInit: Math.round(t1 - t0), fetch: Math.round(t2 - t1), load: Math.round(t3 - t2), total: Math.round(t3 - t0) },
  };
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  try {
    if (msg.type === 'init') {
      ready = ready || init(msg);
      const info = await ready;
      self.postMessage({ id: msg.id, ok: true, result: info });
      return;
    }
    await ready;
    if (msg.type === 'run') {
      const r = await runReadOnly(db, msg.sql, VISIBLE, { maxRows: msg.maxRows || 200 });
      self.postMessage({ id: msg.id, ok: true, result: r });
    } else if (msg.type === 'check') {
      const r = await checkExercise(db, msg.exercise, msg.sql);
      self.postMessage({ id: msg.id, ok: true, result: r });
    } else {
      self.postMessage({ id: msg.id, ok: false, error: 'Невідома команда ' + msg.type });
    }
  } catch (e) {
    self.postMessage({ id: msg.id, ok: false, error: e && e.message ? e.message : String(e) });
  }
};
