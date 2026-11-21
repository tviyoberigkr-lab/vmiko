/*
 * Шар збереження прогресу.
 *
 * Інтерфейс адаптера (будь-яке сховище — localStorage зараз, Supabase потім):
 *   async load(key)          -> об'єкт або null
 *   async save(key, value)   -> void
 *   async remove(key)        -> void
 *
 * Щоб підключити Supabase: написати SupabaseAdapter з тими самими трьома методами
 * (наприклад, таблиця progress(user_id, key, value jsonb, updated_at)) і передати його в createProgressStore.
 * Решта застосунку не зміниться.
 *
 * CoLaba Production
 */

export class LocalStorageAdapter {
  constructor(prefix = 'vmiko:') { this.prefix = prefix; }
  async load(key) {
    try {
      const raw = localStorage.getItem(this.prefix + key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.warn('[storage] не вдалося прочитати', key, e);
      return null;
    }
  }
  async save(key, value) {
    localStorage.setItem(this.prefix + key, JSON.stringify(value));
  }
  async remove(key) { localStorage.removeItem(this.prefix + key); }
}

/** Адаптер у пам'яті — для тестів і як запасний варіант, якщо localStorage недоступний (приватний режим). */
export class MemoryAdapter {
  constructor() { this.m = new Map(); }
  async load(key) { return this.m.has(key) ? JSON.parse(this.m.get(key)) : null; }
  async save(key, value) { this.m.set(key, JSON.stringify(value)); }
  async remove(key) { this.m.delete(key); }
}

export const STATE_VERSION = 1;

export function emptyState() {
  return {
    v: STATE_VERSION,
    current: null,          // { dayId, exerciseId } — де учень зупинився
    exercises: {},          // exerciseId -> стан вправи (див. нижче)
    updatedAt: null,
  };
}

/*
 * Стан вправи:
 * { status: 'not_started'|'in_progress'|'submitted'|'passed'|'needs_retry',
 *   code, choice, parsons: [..], screen, attempts, hintsShown, startedAt, updatedAt, passedAt }
 */

/**
 * Сховище прогресу: тримає стан у пам'яті і зберігає його після КОЖНОЇ зміни.
 * Кілька змін в одному такті коду об'єднуються в один запис (queueMicrotask).
 */
export async function createProgressStore(adapter, key = 'progress') {
  let state = (await adapter.load(key)) || emptyState();
  if (state.v !== STATE_VERSION) state = { ...emptyState(), ...state, v: STATE_VERSION };
  let pending = false;
  let lastError = null;
  const listeners = new Set();

  async function flush() {
    pending = false;
    try {
      await adapter.save(key, state);
      lastError = null;
    } catch (e) {
      lastError = e;
      console.error('[storage] збереження не вдалося', e);
    }
    listeners.forEach((fn) => fn(state, lastError));
  }

  return {
    get: () => state,
    exercise(id) { return state.exercises[id] || { status: 'not_started', attempts: 0, hintsShown: 0 }; },
    /** Оновити стан вправи і зберегти. */
    updateExercise(id, patch) {
      const prev = this.exercise(id);
      const now = new Date().toISOString();
      const next = { ...prev, ...patch, updatedAt: now };
      if (!prev.startedAt) next.startedAt = now;
      if (next.status === 'not_started') next.status = 'in_progress';
      state.exercises[id] = next;
      state.updatedAt = now;
      this.schedule();
      return next;
    },
    setCurrent(dayId, exerciseId) {
      state.current = { dayId, exerciseId };
      state.updatedAt = new Date().toISOString();
      this.schedule();
    },
    schedule() {
      if (pending) return;
      pending = true;
      queueMicrotask(flush);
    },
    /** Негайно записати (на pagehide/visibilitychange). */
    flushNow: () => flush(),
    async reset() { state = emptyState(); await adapter.remove(key); listeners.forEach((fn) => fn(state, null)); },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    get lastError() { return lastError; },
  };
}
