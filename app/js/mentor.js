/*
 * ШІ-наставник.
 * Сходинки підказок (розділ 4 специфікації):
 *   рівень 1 — напрям (автор, без ШІ);
 *   рівень 2 — конкретне місце (автор, без ШІ);
 *   рівень 3 — приклад на іншій таблиці (автор, без ШІ);
 *   рівень 4 — ШІ-наставник дивиться на КОД УЧНЯ і пояснює, де помилка, без готового запиту.
 *              Відкривається після підказки 3 і ≥2 невдалих спроб; лише для sql/parsons.
 * Ключ Anthropic у браузері не живе: запит іде на Supabase Edge Function `mentor` (supabase/functions/mentor),
 * яка тримає ключ у секреті, ріже вхід і лімітує 60 звернень на пристрій на добу.
 * CoLaba Production
 */
export const AI_ENABLED = true;
export const LEVEL3_MIN_ATTEMPTS = 2;
export const AI_LEVEL = 4;

const MENTOR_URL = 'https://jbanpxtrahhjcihpmzyt.supabase.co/functions/v1/mentor';
// Публічний ключ Supabase (не секрет: призначений для браузера, дає доступ лише до того, що дозволено RLS/функціями).
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_jsG9DyW9_bpVY3nyJf7ymA_gYicnnJE';
const AI_TIMEOUT_MS = 25000;

export function hintAvailability(exercise, exState) {
  const shown = exState.hintsShown || 0;
  const attempts = exState.attempts || 0;
  const levels = [
    { level: 1, unlocked: true, shown: shown >= 1 },
    { level: 2, unlocked: shown >= 1, shown: shown >= 2 },
    { level: 3, unlocked: shown >= 2 && attempts >= LEVEL3_MIN_ATTEMPTS, shown: shown >= 3, needAttempts: Math.max(0, LEVEL3_MIN_ATTEMPTS - attempts) },
  ];
  if (aiApplies(exercise)) {
    levels.push({ level: AI_LEVEL, unlocked: shown >= 3 && attempts >= LEVEL3_MIN_ATTEMPTS, shown: shown >= AI_LEVEL, needAttempts: Math.max(0, LEVEL3_MIN_ATTEMPTS - attempts), ai: true });
  }
  return levels;
}

/** ШІ має сенс лише там, де є код учня. */
export function aiApplies(exercise) {
  return AI_ENABLED && (exercise.type === 'sql' || exercise.type === 'parsons');
}

/** Рівень 3 завжди авторський приклад (коли автор його написав); ШІ — окремий рівень 4. */
export function level3Source(exercise) {
  return exercise.hints && exercise.hints[2] ? 'author' : 'ai';
}

export async function getHint(exercise, level, context) {
  if (level <= 3) {
    return { level, source: 'author', text: (exercise.hints || [])[level - 1] || 'Підказки для цього рівня немає.' };
  }
  return aiHint(exercise, context);
}

/** Стабільний анонімний ідентифікатор пристрою — лише для добового ліміту наставника. Нічого особистого. */
export function deviceId() {
  try {
    let id = localStorage.getItem('vmiko:device');
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/-/g, '');
      localStorage.setItem('vmiko:device', id);
    }
    return id;
  } catch (_) { return 'nostorage' + Math.random().toString(36).slice(2, 12); }
}

async function aiHint(exercise, context) {
  // context: { code, attempts, lastCheck }
  const code = (context && context.code) || '';
  if (!code.trim()) return { level: AI_LEVEL, source: 'ai', text: 'Спочатку напиши хоч якийсь запит — наставник дивиться саме на твій код.' };
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { level: AI_LEVEL, source: 'ai', text: 'Наставнику потрібен інтернет. Поки мережі немає, перечитай підказки 1–3.' };
  }
  const lc = context && context.lastCheck;
  const body = {
    device_id: deviceId(),
    kind: 'hint',
    attempts: (context && context.attempts) || 0,
    exercise: { title: exercise.title || '', prompt: exercise.prompt || '', schema: exercise.schemaHint || '' },
    code,
    lastError: lc && lc.error ? String(lc.error) : '',
    lastCheckMessage: lc && !lc.error ? String(lc.message || lc.verdict || '') : '',
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), AI_TIMEOUT_MS);
  try {
    const r = await fetch(MENTOR_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: SUPABASE_PUBLISHABLE_KEY },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return { level: AI_LEVEL, source: 'ai', text: data.text || 'Наставник зараз недоступний. Спробуй за хвилину або перечитай підказки 1–3.', error: data.error || r.status };
    }
    return { level: AI_LEVEL, source: 'ai', text: data.text || 'Наставник не відповів. Спробуй ще раз.', usage: data.usage, callsToday: data.calls_today };
  } catch (e) {
    return { level: AI_LEVEL, source: 'ai', text: e.name === 'AbortError' ? 'Наставник думає надто довго. Спробуй ще раз.' : 'Не вдалося зв\'язатися з наставником. Перевір інтернет і спробуй ще раз.', error: String(e) };
  } finally { clearTimeout(timer); }
}
