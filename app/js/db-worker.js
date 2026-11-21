/*
 * Воркер бази даних: PostgreSQL (PGlite, WASM) в окремому потоці, щоб інтерфейс не завмирав.
 * Протокол: { id, type: 'init'|'run'|'check', ... } -> { id, ok, result | error }
 * Під час init воркер шле без id: { type: 'progress', stage, loaded, total } — головний потік
 * показує прогрес і рахує «час без прогресу» (db.js), а не загальний час.
 *
 * Етапи (stage): 'engine' — завантаження pglite.wasm/.data/initdb.wasm; 'engine-init' — запуск Postgres;
 * 'data' — завантаження датасетів visible + hidden (паралельно, байти рахуються по кожному файлу); 'import' — імпорт таблиць; 'verify' — перевірка цілісності.
 *
 * Пошкоджена база в IndexedDB (вкладку закрили посеред запису, частину файлів втрачено):
 * новий воркер стирає її (deleteDatabase з очікуванням) і робить ПОВНИЙ повторний імпорт у нову постійну базу
 * (деталі — коментар перед init()).
 * Режим «лише в пам'яті» — тільки якщо IndexedDB справді недоступна (приватний режим, квота).
 * CoLaba Production
 */
import { PGlite } from '../vendor/pglite/index.js';
import { loadDataset, runReadOnly, checkExercise, VISIBLE, HIDDEN } from './sqlrunner.js';

const IDB_PREFIX = '/pglite/'; // так PGlite називає бази в IndexedDB: '/pglite/' + назва
const APP_DB_PREFIX = 'vmiko-';

let db = null;
let ready = null;

// ------------------------------------------------------------------ прогрес
// Розміри файлів після розпакування (байти) — щоб показувати «X з Y МБ (%)», навіть коли сервер стискає відповідь
// і Content-Length не дорівнює розміру тіла. Збіг із реальними файлами перевіряє tools/check_versions.js
// (node tools/check_versions.js --write оновлює цей рядок сам).
const EXPECTED_SIZES = {"pglite.wasm":9118807,"pglite.data":6241295,"initdb.wasm":298788,"visible":11375777,"hidden":3413573};
const prog = { stage: '', files: new Map(), lastSent: 0 };
/** Реєструє очікувані файли наперед, щоб загальний обсяг був відомий з першої секунди. */
function expect(keys) { for (const k of keys) if (!prog.files.has(k)) prog.files.set(k, { loaded: 0, total: EXPECTED_SIZES[k] || 0 }); }
function sendProgress(force = false) {
  const now = performance.now();
  if (!force && now - prog.lastSent < 200) return;
  prog.lastSent = now;
  let loaded = 0, total = 0, totalKnown = true;
  for (const f of prog.files.values()) { loaded += f.loaded; if (f.total > 0) total += f.total; else totalKnown = false; }
  const files = {};
  for (const [k, f] of prog.files) files[k] = [f.loaded, f.total];
  self.postMessage({ type: 'progress', stage: prog.stage, loaded, total: totalKnown ? total : 0, files });
}
function stage(name) { prog.stage = name; sendProgress(true); }

/**
 * fetch із підрахунком байтів. Повертає Response, тіло якого читається через лічильник.
 * total = Content-Length лише якщо немає стиснення (інакше заголовок — розмір стиснутого тіла і % збрехав би).
 */
async function fetchCounted(url, key) {
  const res = await fetch(url);
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} для ${new URL(url).pathname}`), { code: 'http' });
  const enc = res.headers.get('content-encoding');
  const len = enc && enc !== 'identity' ? 0 : Number(res.headers.get('content-length')) || 0;
  const f = { loaded: 0, total: len || EXPECTED_SIZES[key] || 0 };
  prog.files.set(key, f);
  if (!res.body || !self.ReadableStream) return res;
  const reader = res.body.getReader();
  const counted = new ReadableStream({
    async pull(ctrl) {
      const { done, value } = await reader.read();
      if (done) { f.total = f.loaded; sendProgress(); ctrl.close(); return; }
      f.loaded += value.byteLength;
      sendProgress();
      ctrl.enqueue(value);
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  return new Response(counted, { headers: res.headers });
}

async function compileWasm(url, key) {
  const res = await fetchCounted(url, key);
  if (WebAssembly.compileStreaming) {
    try { return await WebAssembly.compileStreaming(new Response(res.body, { headers: { 'Content-Type': 'application/wasm' } })); }
    catch (e) { if (res.bodyUsed) throw e; }
  }
  return WebAssembly.compile(await res.arrayBuffer());
}

/** Завантажує рушій сам (щоб бачити байти) і віддає PGlite готові модулі — PGlite тоді нічого не качає вдруге. */
let enginePromise = null;
function loadEngine() {
  if (enginePromise) return enginePromise;
  const base = new URL('../vendor/pglite/', import.meta.url);
  expect(['pglite.wasm', 'pglite.data', 'initdb.wasm']);
  enginePromise = Promise.all([
    compileWasm(new URL('pglite.wasm', base).href, 'pglite.wasm'),
    compileWasm(new URL('initdb.wasm', base).href, 'initdb.wasm'),
    fetchCounted(new URL('pglite.data', base).href, 'pglite.data').then((r) => r.blob()),
  ]).then(([pgliteWasmModule, initdbWasmModule, fsBundle]) => ({ pgliteWasmModule, initdbWasmModule, fsBundle }));
  return enginePromise;
}

// ------------------------------------------------------------------ IndexedDB
function idbRequest(req) {
  return new Promise((res) => { req.onsuccess = req.onerror = () => res(); req.onblocked = () => res('blocked'); });
}
/** Видаляє базу і чекає завершення. 'blocked' — базу тримає інше з'єднання (інша вкладка Vmiko). */
function wipeIdb(dbName, waitBlockedMs = 5000) {
  return new Promise((res) => {
    let req;
    try { req = indexedDB.deleteDatabase(IDB_PREFIX + dbName); } catch (_) { res('error'); return; }
    let timer = null;
    req.onsuccess = () => { clearTimeout(timer); res('ok'); };
    req.onerror = () => { clearTimeout(timer); res('error'); };
    req.onblocked = () => { timer = setTimeout(() => res('blocked'), waitBlockedMs); };
  });
}
async function idbExists(dbName) {
  try {
    if (!indexedDB.databases) return null; // невідомо (старий Safari/Firefox)
    return (await indexedDB.databases()).some((d) => d.name === IDB_PREFIX + dbName);
  } catch (_) { return null; }
}
/** Після зміни dataset_version прибирає старі бази vmiko-* (кожна — десятки МБ на диску). */
async function removeOldDbs(currentName) {
  try {
    if (!indexedDB.databases) return [];
    const old = (await indexedDB.databases()).map((d) => d.name).filter((n) => n && n.startsWith(IDB_PREFIX + APP_DB_PREFIX) && n !== IDB_PREFIX + currentName);
    for (const n of old) await idbRequest(indexedDB.deleteDatabase(n));
    return old;
  } catch (_) { return []; }
}
async function closeQuiet(d) { try { if (d) await d.close(); } catch (_) {} }

async function newPg(dataDir) {
  const engine = await loadEngine();
  stage('engine-init');
  const d = new PGlite({ dataDir, ...engine });
  try { await d.waitReady; } catch (e) { await closeQuiet(d); throw e; }
  return d;
}

// ------------------------------------------------------------------ дані
async function loadedVersions(d) {
  try {
    const r = await d.query('SELECT schema_name, dataset_version FROM public._vmiko_meta');
    return Object.fromEntries(r.rows.map((x) => [x.schema_name, x.dataset_version]));
  } catch (_) { return {}; }
}

/**
 * Перевірка цілісності бази з IndexedDB. IDBFS зберігає кожен файл Postgres цілим записом,
 * тож типове пошкодження — відсутні файли таблиць/індексів. pg_relation_size відкриває файл кожної
 * таблиці, індексу і TOAST обох схем і падає, якщо файла немає. Це мілісекунди, а не повний прохід
 * (count(*) по всіх таблицях коштував ≈2 с на кожному повторному старті — виміряно, відмовився).
 */
async function verifyTables(d) {
  const r = await d.query(`
    SELECT count(*)::int AS n, sum(pg_relation_size(c.oid) + COALESCE(pg_relation_size(NULLIF(c.reltoastrelid, 0)), 0))::bigint AS bytes
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('${VISIBLE}', '${HIDDEN}') AND c.relkind IN ('r', 'i')`);
  const t = await d.query(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('${VISIBLE}', '${HIDDEN}') AND c.relkind = 'r'`);
  if (t.rows[0].n < 2 || !(Number(r.rows[0].bytes) > 0)) throw new Error('у базі немає таблиць або вони порожні');
}

function withVersion(url, v) {
  const u = new URL(url);
  u.searchParams.set('v', v);
  return u.href;
}

async function fetchDatasets(visibleUrl, hiddenUrl, datasetVersion) {
  expect(['visible', 'hidden']);
  const get = async (url, key) => {
    const r = await fetchCounted(withVersion(url, datasetVersion), key);
    const data = await r.json();
    if (data.meta && data.meta.dataset_version !== datasetVersion) {
      // Не блокуємо роботу учня, але це помилка публікації: tools/check_versions.js мав її зловити.
      console.warn(`[db] датасет ${key}: версія ${data.meta.dataset_version}, а контент очікує ${datasetVersion}`);
    }
    return data;
  };
  return Promise.all([get(visibleUrl, 'visible'), get(hiddenUrl, 'hidden')]);
}

async function importInto(d, datasets) {
  stage('import');
  const [vis, hid] = await datasets;
  await loadDataset(d, vis, VISIBLE);
  stage('import');
  await loadDataset(d, hid, HIDDEN);
}

// ------------------------------------------------------------------ ініціалізація
/*
 * Пошкоджена постійна база. Стерти її в ЦЬОМУ ж воркері ненадійно: PGlite, що не зміг відкрити базу,
 * лишає відкритим з'єднання з IndexedDB, deleteDatabase блокується, а нове відкриття чекає за ним
 * (виміряно: зависання до спрацювання сторожа, ≈100 с). Тому воркер повідомляє code 'corrupt-idb',
 * db.js знищує воркер (з'єднання закривається) і стартує новий з wipeFirst: true — той стирає базу ДО
 * першого відкриття і робить повний імпорт у нову постійну базу. Пам'ять — лише якщо і це не вдалось.
 */
const errText = (e) => (e && (e.message || e.name || (e.errno != null ? 'errno ' + e.errno : ''))) || String(e);
const corrupt = (why, err) => Object.assign(new Error(why + ': ' + errText(err)), { code: 'corrupt-idb' });

async function init({ visibleUrl, hiddenUrl, dbName, datasetVersion, wipeFirst }) {
  const t0 = performance.now();
  const notes = [];
  let persistent = true, fromCache = false, tFetch = 0, tVerify = 0;
  stage('engine');

  if (wipeFirst) {
    const w = await wipeIdb(dbName);
    notes.push('wiped: ' + w);
    if (w === 'blocked') { persistent = false; notes.push('базу тримає інша вкладка — цей сеанс у пам\'яті'); }
  }
  // Якщо постійної бази немає — дані точно знадобляться: качаємо їх паралельно з рушієм.
  let datasets = null;
  const getDatasets = () => {
    if (!datasets) { datasets = fetchDatasets(visibleUrl, hiddenUrl, datasetVersion); datasets.catch(() => {}); }
    return datasets;
  };
  if (!persistent || (await idbExists(dbName)) === false) getDatasets();

  /** Після стирання постійна база знову не працює — останній запасний варіант: пам'ять. */
  const toMemory = async (why, err) => {
    console.warn('[db] ' + why + ' — працюю в пам\'яті', err);
    notes.push(why + ': ' + errText(err));
    persistent = false;
    return newPg(undefined);
  };

  // 1) постійна база
  let d;
  if (!persistent) d = await newPg(undefined);
  else {
    try { d = await newPg('idb://' + dbName); }
    catch (e) {
      if (!wipeFirst) throw corrupt('постійна база не відкрилась', e);
      d = await toMemory('постійна база не відкрилась і після стирання', e);
    }
  }
  const t1 = performance.now();

  // 2) база з пристрою повна і цілісна?
  const have = await loadedVersions(d);
  if (have[VISIBLE] === datasetVersion && have[HIDDEN] === datasetVersion) {
    const tv = performance.now();
    try { stage('verify'); await verifyTables(d); fromCache = true; }
    catch (e) { throw corrupt('база з пристрою неповна', e); }
    tVerify = performance.now() - tv;
  }

  // 3) імпорт: перший старт, нова версія даних або відновлення після пошкодження
  if (!fromCache) {
    const tf = performance.now();
    stage('data');
    await getDatasets();
    tFetch = performance.now() - tf;
    try { await importInto(d, getDatasets()); }
    catch (e) {
      if (!persistent) throw e;
      if (!wipeFirst) throw corrupt('імпорт у постійну базу не вдався', e);
      await closeQuiet(d);
      d = await toMemory('імпорт у постійну базу не вдався і після стирання', e);
      await importInto(d, getDatasets());
    }
  }
  db = d;
  const t3 = performance.now();
  const removedOld = persistent ? await removeOldDbs(dbName) : [];
  return {
    datasetVersion: (await loadedVersions(db))[VISIBLE],
    persistent,
    fromCache,
    recovered: !!wipeFirst,
    removedOld,
    notes,
    timings: { pgInit: Math.round(t1 - t0), fetch: Math.round(tFetch), load: Math.round(t3 - t1 - tFetch), verify: Math.round(tVerify), total: Math.round(t3 - t0) },
    net: netStats(),
  };
}

/** Байти, які воркер отримав (Resource Timing воркера; сторінка цих запитів не бачить). */
function netStats() {
  try {
    const e = performance.getEntriesByType('resource');
    let transfer = 0, decoded = 0;
    for (const r of e) { transfer += r.transferSize || 0; decoded += r.decodedBodySize || 0; }
    return { requests: e.length, transfer, decoded };
  } catch (_) { return null; }
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
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    const code = (e && e.code) || (offline || (e instanceof TypeError && /fetch|network/i.test(e.message)) ? 'network' : 'failed');
    self.postMessage({ id: msg.id, ok: false, error: e && e.message ? e.message : String(e), code });
  }
};
