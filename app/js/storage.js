/*
 * Шар збереження прогресу.
 *
 * Інтерфейс адаптера (будь-яке сховище — localStorage зараз, Supabase потім):
 *   async load(key)            -> об'єкт або null; якщо запис є, але це не JSON — кидає BrokenRecordError
 *   async save(key, value)     -> void (може кинути, наприклад QuotaExceededError)
 *   async remove(key)          -> void
 *   async saveBroken(key, raw) -> назва ключа з копією або null (необов'язковий; зберігає ОДНУ копію
 *                                 пошкодженого запису як `<key>:broken:<timestamp>`, попередню видаляє)
 *
 * Щоб підключити Supabase: написати SupabaseAdapter з тими самими методами
 * (наприклад, таблиця progress(user_id, key, value jsonb, updated_at)) і передати його в createProgressStore.
 * Злиття станів (mergeStates) уже працює по вправах — те саме правило годиться і для кількох пристроїв.
 *
 * Дві вкладки / PWA + браузер (decisions.md Р10):
 *   - вкладка пише лише якщо в неї БУЛИ зміни (dirty);
 *   - перед записом читає свіжий стан з диска і зливає його зі своїм (mergeStates);
 *   - подія `storage` з іншої вкладки → reloadFromDisk() (виклик робить main.js).
 *
 * CoLaba Production
 */

/** Запис є, але його не вдалося розібрати. `raw` — оригінальний рядок (для копії). */
export class BrokenRecordError extends Error {
  constructor(raw, cause) {
    super('Пошкоджений запис прогресу');
    this.code = 'broken';
    this.raw = raw;
    this.cause = cause;
  }
}

export class LocalStorageAdapter {
  constructor(prefix = 'vmiko:') { this.prefix = prefix; }
  /** Повна назва ключа в localStorage (main.js звіряє її з подією `storage`). */
  fullKey(key) { return this.prefix + key; }
  async load(key) {
    const raw = localStorage.getItem(this.prefix + key); // помилку доступу не ковтаємо — store вирішить
    if (raw == null || raw === '') return null;
    try { return JSON.parse(raw); } catch (e) { throw new BrokenRecordError(raw, e); }
  }
  async save(key, value) {
    localStorage.setItem(this.prefix + key, JSON.stringify(value));
  }
  async remove(key) { localStorage.removeItem(this.prefix + key); }
  async saveBroken(key, raw) {
    const base = this.prefix + key + ':broken:';
    const old = [];
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(base)) old.push(k); }
    old.forEach((k) => localStorage.removeItem(k));
    const name = base + Date.now();
    localStorage.setItem(name, raw);
    return name;
  }
}

/** Адаптер у пам'яті — для тестів і як запасний варіант, якщо localStorage недоступний (приватний режим). */
export class MemoryAdapter {
  constructor() { this.m = new Map(); }
  fullKey(key) { return key; }
  async load(key) {
    if (!this.m.has(key)) return null;
    const raw = this.m.get(key);
    try { return JSON.parse(raw); } catch (e) { throw new BrokenRecordError(raw, e); }
  }
  async save(key, value) { this.m.set(key, JSON.stringify(value)); }
  async remove(key) { this.m.delete(key); }
  async saveBroken(key, raw) {
    const base = key + ':broken:';
    for (const k of [...this.m.keys()]) if (k.startsWith(base)) this.m.delete(k);
    const name = base + Date.now();
    this.m.set(name, raw);
    return name;
  }
}

export const STATE_VERSION = 1;
/** Максимальна довжина коду вправи, що зберігається (захист від переповнення сховища вставкою). */
export const CODE_MAX = 20000;

export function emptyState() {
  return {
    v: STATE_VERSION,
    current: null,          // { dayId, exerciseId } — де учень зупинився
    exercises: {},          // exerciseId -> стан вправи (див. нижче)
    updatedAt: null,
    resetAt: null,          // мітка «Скинути прогрес»: старіші вправи інших вкладок не воскресають
  };
}

/*
 * Стан вправи:
 * { status: 'not_started'|'in_progress'|'submitted'|'passed'|'needs_retry',
 *   code, choice, parsons: [..], screen, attempts, hintsShown, revealed, solution, startedAt, updatedAt, passedAt }
 */
const STATUSES = new Set(['not_started', 'in_progress', 'submitted', 'passed', 'needs_retry']);
// submitted — тимчасовий стан (перевірка йде), тому при рівному updatedAt програє in_progress
const STATUS_RANK = { not_started: 0, submitted: 1, in_progress: 2, needs_retry: 3, passed: 4 };
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const okId = (id) => /^[\w.-]{1,100}$/.test(id) && id !== '__proto__' && id !== 'constructor' && id !== 'prototype';

/** Нормалізувати стан однієї вправи. Повертає [вправа|null, чи довелось щось виправляти]. */
function normalizeExercise(v) {
  if (!isObj(v)) return [null, true];
  let repaired = false;
  const out = { ...v };
  const drop = (f) => { if (f in out) { delete out[f]; repaired = true; } };
  if (!STATUSES.has(out.status)) { out.status = 'in_progress'; repaired = true; }
  if ('code' in out) { if (!isStr(out.code)) drop('code'); else if (out.code.length > CODE_MAX) out.code = out.code.slice(0, CODE_MAX); }
  if ('solution' in out && !isStr(out.solution)) drop('solution');
  if ('choice' in out && !(isNum(out.choice) || out.choice === null)) drop('choice');
  if ('parsons' in out && !(Array.isArray(out.parsons) && out.parsons.every(isStr))) drop('parsons');
  if ('screen' in out && !(isNum(out.screen) && out.screen >= 0)) drop('screen');
  if ('revealed' in out && typeof out.revealed !== 'boolean') drop('revealed');
  for (const f of ['attempts', 'hintsShown']) {
    if (!(f in out)) continue;
    if (!(isNum(out[f]) && out[f] >= 0)) { out[f] = 0; repaired = true; }
  }
  for (const f of ['startedAt', 'updatedAt', 'passedAt']) if (f in out && !isStr(out[f])) drop(f);
  return [out, repaired];
}

/**
 * Привести будь-яке значення до коректного стану. Ніколи не кидає.
 * Повертає { state, repaired }: repaired = true, якщо щось довелося відкинути/виправити
 * (тоді оригінал варто зберегти як :broken). Обрізання коду до CODE_MAX не вважається пошкодженням.
 */
export function normalize(s) {
  const base = emptyState();
  if (s == null) return { state: base, repaired: false };
  if (!isObj(s)) return { state: base, repaired: true };
  let repaired = false;
  const exercises = {};
  if (isObj(s.exercises)) {
    for (const [id, v] of Object.entries(s.exercises)) {
      if (!okId(id)) { repaired = true; continue; }
      const [e, r] = normalizeExercise(v);
      if (r) repaired = true;
      if (e) exercises[id] = e;
    }
  } else if ('exercises' in s) repaired = true;
  let current = null;
  if (isObj(s.current) && isStr(s.current.exerciseId)) current = { dayId: isStr(s.current.dayId) ? s.current.dayId : null, exerciseId: s.current.exerciseId };
  else if (s.current != null) repaired = true;
  return {
    state: {
      ...base,
      exercises,
      current,
      updatedAt: isStr(s.updatedAt) ? s.updatedAt : null,
      resetAt: isStr(s.resetAt) ? s.resetAt : null,
    },
    repaired,
  };
}

/** Детермінований вибір між двома станами вправи з однаковим updatedAt (щоб вкладки не перезаписували одна одну по колу). */
function tieBreak(a, b) {
  const ra = STATUS_RANK[a.status] ?? 0, rb = STATUS_RANK[b.status] ?? 0;
  if (ra !== rb) return ra > rb ? a : b;
  return JSON.stringify(a) >= JSON.stringify(b) ? a : b;
}

/** Злити стан однієї вправи з двох джерел. */
function mergeExercise(a, b) {
  const ta = a.updatedAt || '', tb = b.updatedAt || '';
  const newer = ta === tb ? tieBreak(a, b) : (tb > ta ? b : a);
  const older = newer === a ? b : a;
  const out = { ...newer };
  // правило: зарахування (passed) ніколи не понижується злиттям
  if (older.status === 'passed' && out.status !== 'passed') {
    out.status = 'passed';
    if (older.passedAt) out.passedAt = older.passedAt;
    if (older.solution && !out.solution) out.solution = older.solution;
  }
  out.attempts = Math.max(a.attempts || 0, b.attempts || 0);
  out.hintsShown = Math.max(a.hintsShown || 0, b.hintsShown || 0);
  if (a.startedAt || b.startedAt) out.startedAt = [a.startedAt, b.startedAt].filter(Boolean).sort()[0];
  return out;
}

/**
 * Злиття двох станів (диск і пам'ять вкладки; або файл імпорту і поточний стан).
 *  - по кожній вправі: новіший updatedAt; при рівності — детермінований вибір;
 *  - passed не понижується; attempts і hintsShown — максимум; startedAt — найраніший;
 *  - «Скинути прогрес»: R = найпізніший resetAt. Сторона, яка ще не бачила R, втрачає вправи з updatedAt < R;
 *    сторона, що вже бачила R, зберігає все (зокрема імпортоване після скидання);
 *  - current — зі стану з новішим updatedAt.
 * Чиста функція: вхідні об'єкти не змінює. Результат не залежить від того, хто «диск», а хто «пам'ять».
 */
export function mergeStates(disk, mem) {
  const d = normalize(disk).state, m = normalize(mem).state;
  const R = [d.resetAt, m.resetAt].filter(Boolean).sort().pop() || null;
  const keep = (side) => {
    const out = {};
    for (const [id, e] of Object.entries(side.exercises)) {
      if (R && side.resetAt !== R && (e.updatedAt || '') < R) continue; // ця сторона не бачила скидання
      out[id] = e;
    }
    return out;
  };
  const de = keep(d), me = keep(m);
  const exercises = {};
  for (const id of new Set([...Object.keys(de), ...Object.keys(me)])) {
    exercises[id] = de[id] && me[id] ? mergeExercise(de[id], me[id]) : (de[id] || me[id]);
  }
  const du = d.updatedAt || '', mu = m.updatedAt || '';
  let current = du === mu ? (JSON.stringify(m.current) >= JSON.stringify(d.current) ? m.current : d.current) : (mu > du ? m.current : d.current);
  if (current && R && (du > mu ? d : m).resetAt !== R) current = null;
  return { ...emptyState(), exercises, current, updatedAt: (du > mu ? du : mu) || null, resetAt: R };
}

/** Короткий опис помилки збереження для учня. */
export function describeSaveError(e) {
  if (!e) return '';
  if (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014 || /quota/i.test(e.message || '')) return 'сховище браузера переповнене';
  if (e.name === 'SecurityError') return 'браузер заборонив доступ до сховища (можливо, приватний режим)';
  return e.message || String(e);
}

/**
 * Сховище прогресу: тримає стан у пам'яті і зберігає його після КОЖНОЇ зміни.
 * Кілька змін в одному такті коду об'єднуються в один запис (queueMicrotask).
 *
 * Підписники: fn(state, lastError, event), event: 'saved' | 'save-failed' | 'reloaded' | 'reset' | 'imported'.
 * Після створення: store.brokenKey — назва ключа з копією пошкодженого запису (якщо такий був), інакше null.
 */
export async function createProgressStore(adapter, key = 'progress') {
  let lastError = null;
  let brokenKey = null;
  let pending = false;
  let dirty = false;
  const listeners = new Set();
  const notify = (event) => listeners.forEach((fn) => { try { fn(state, lastError, event); } catch (e) { console.error('[storage] підписник впав', e); } });

  let lastBrokenRaw = null;
  async function keepBroken(raw) {
    if (raw === lastBrokenRaw) return; // ту саму поломку вже скопіювали (старт → перший запис)
    lastBrokenRaw = raw;
    try {
      const k = adapter.saveBroken ? await adapter.saveBroken(key, raw) : null;
      if (k) brokenKey = k;
      console.warn('[storage] пошкоджений запис прогресу збережено як', k);
    } catch (e) { console.warn('[storage] не вдалося зберегти копію пошкодженого запису', e); }
  }

  /** Прочитати диск. Повертає { disk, ok }: ok=false — читання неможливе (тоді писати НЕ можна, щоб не затерти). */
  async function readDisk() {
    try {
      const raw = await adapter.load(key);
      const n = normalize(raw);
      if (n.repaired) await keepBroken(JSON.stringify(raw));
      return { disk: raw == null ? null : n.state, ok: true };
    } catch (e) {
      if (e && e.code === 'broken') { await keepBroken(e.raw); return { disk: null, ok: true }; }
      return { disk: null, ok: false, error: e };
    }
  }

  // ---- старт
  let state = emptyState();
  {
    const r = await readDisk();
    if (r.ok) { if (r.disk) state = r.disk; }
    else { lastError = r.error; console.error('[storage] не вдалося прочитати прогрес', r.error); }
  }
  // «перевіряється» після перезапуску означає, що перевірку перервали (вкладку закрили) — повертаємо в роботу
  for (const e of Object.values(state.exercises)) if (e.status === 'submitted') { e.status = 'in_progress'; dirty = true; }

  async function flush() {
    pending = false;
    if (!dirty) return;                 // застаріла вкладка без змін нічого не пише
    dirty = false;                      // зміни під час await знову поставлять прапорець
    try {
      const r = await readDisk();
      if (!r.ok) throw r.error;
      if (r.disk) state = mergeStates(r.disk, state); // синхронно після await: зміни, що були до цього, у state вже є
      await adapter.save(key, state);
      lastError = null;
      notify('saved');
    } catch (e) {
      dirty = true;                     // спробуємо ще раз при наступній зміні або на pagehide
      lastError = e;
      console.error('[storage] збереження не вдалося', e);
      notify('save-failed');
    }
  }

  const store = {
    get: () => state,
    exercise(id) { return state.exercises[id] || { status: 'not_started', attempts: 0, hintsShown: 0 }; },
    /** Оновити стан вправи і зберегти. */
    updateExercise(id, patch) {
      const prev = this.exercise(id);
      const now = new Date().toISOString();
      const next = { ...prev, ...patch, updatedAt: now };
      if (typeof next.code === 'string' && next.code.length > CODE_MAX) next.code = next.code.slice(0, CODE_MAX);
      if (!prev.startedAt) next.startedAt = now;
      if (next.status === 'not_started') next.status = 'in_progress';
      state.exercises[id] = next;
      state.updatedAt = now;
      dirty = true;
      this.schedule();
      return next;
    },
    setCurrent(dayId, exerciseId) {
      state.current = { dayId, exerciseId };
      state.updatedAt = new Date().toISOString();
      dirty = true;
      this.schedule();
    },
    schedule() {
      if (pending) return;
      pending = true;
      queueMicrotask(flush);
    },
    /** Негайно записати (на pagehide/visibilitychange). Нічого не пише, якщо змін не було. */
    flushNow: () => flush(),
    get dirty() { return dirty; },
    /** Підхопити зміни іншої вкладки (подія `storage`). Свої незбережені зміни не губляться. */
    async reloadFromDisk() {
      const r = await readDisk();
      if (!r.ok || !r.disk) return false;
      const merged = mergeStates(r.disk, state);
      const differsFromDisk = JSON.stringify(merged) !== JSON.stringify(normalize(r.disk).state);
      state = merged;
      if (differsFromDisk) { dirty = true; this.schedule(); } // у нас є щось, чого на диску немає
      notify('reloaded');
      return true;
    },
    /**
     * Скинути прогрес. Перед цим — знімок у `<key>:backup` (один, перезаписується).
     * Замість видалення ключа пишемо порожній стан з resetAt — інакше інша вкладка воскресить стерте.
     */
    async reset() {
      try { await adapter.save(key + ':backup', { ...state, backupAt: new Date().toISOString() }); }
      catch (e) { console.warn('[storage] знімок перед скиданням не збережено', e); }
      state = { ...emptyState(), resetAt: new Date().toISOString() };
      dirty = false;
      try { await adapter.save(key, state); lastError = null; }
      catch (e) { lastError = e; dirty = true; console.error('[storage] скидання не записано', e); }
      notify('reset');
    },
    /** Знімок для експорту у файл. */
    exportData() {
      return { app: 'vmiko', kind: 'progress', format: 1, exportedAt: new Date().toISOString(), state: JSON.parse(JSON.stringify(state)) };
    },
    /**
     * Імпорт з файлу (об'єкт з exportData() або «голий» стан). Не замінює, а ЗЛИВАЄ з поточним
     * (passed не понижується), тому імпорт старого файлу нічого не зітре.
     * Повертає { imported: кількість вправ у файлі, passed: зараховано у файлі } або кидає Error з поясненням.
     */
    importData(obj) {
      const src = isObj(obj) && obj.app === 'vmiko' && isObj(obj.state) ? obj.state : obj;
      if (!isObj(src) || !isObj(src.exercises)) throw new Error('Це не файл прогресу Vmiko.');
      const n = normalize(src).state;
      n.resetAt = state.resetAt; // імпорт свідомо робиться після скидання — вважаємо, що файл «бачив» скидання
      state = mergeStates(n, state);
      state.updatedAt = new Date().toISOString();
      dirty = true;
      this.schedule();
      notify('imported');
      const list = Object.values(n.exercises);
      return { imported: list.length, passed: list.filter((e) => e.status === 'passed').length };
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    get lastError() { return lastError; },
    get brokenKey() { return brokenKey; },
  };
  if (dirty) store.schedule();
  return store;
}
