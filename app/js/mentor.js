/*
 * ШІ-наставник — ЗАГЛУШКА.
 * Сходинки підказок (розділ 4 специфікації):
 *   рівень 1 — напрям (написаний автором, без ШІ, безкоштовно);
 *   рівень 2 — конкретне місце (автор, без ШІ);
 *   рівень 3 — ШІ з контекстом коду учня. Відкривається після 2 невдалих спроб; готового запиту не дає.
 *              Поки ШІ вимкнений, рівень 3 — авторський «приклад на іншій таблиці» (hints[2]), якщо він є.
 *
 * Щоб підключити справжній ШІ: реалізувати aiHint() — виклик свого бекенду (Supabase Edge Function тощо),
 * НЕ напряму в API з браузера (ключ не можна класти в клієнт).
 * CoLaba Production
 */
export const AI_ENABLED = false;
export const LEVEL3_MIN_ATTEMPTS = 2;

export function hintAvailability(exercise, exState) {
  const shown = exState.hintsShown || 0;
  const attempts = exState.attempts || 0;
  return [
    { level: 1, unlocked: true, shown: shown >= 1 },
    { level: 2, unlocked: shown >= 1, shown: shown >= 2 },
    { level: 3, unlocked: shown >= 2 && attempts >= LEVEL3_MIN_ATTEMPTS, shown: shown >= 3, needAttempts: Math.max(0, LEVEL3_MIN_ATTEMPTS - attempts) },
  ];
}

/**
 * Звідки береться підказка 3: поки ШІ не підключений, а автор написав третю підказку
 * («приклад на іншій таблиці», спека розд. 2, критерії М1) — показуємо її; інакше — ШІ (зараз заглушка).
 */
export function level3Source(exercise) {
  return !AI_ENABLED && exercise.hints && exercise.hints[2] ? 'author' : 'ai';
}

export async function getHint(exercise, level, context) {
  if (level <= 2 || (level === 3 && level3Source(exercise) === 'author')) {
    return { level, source: 'author', text: (exercise.hints || [])[level - 1] || 'Підказки для цього рівня немає.' };
  }
  return aiHint(exercise, context);
}

async function aiHint(exercise, context) {
  // context: { code, lastError, lastCheckMessage, attempts }
  if (!AI_ENABLED) {
    return {
      level: 3,
      source: 'stub',
      text: 'ШІ-наставник ще не підключений. Тут він подивиться на твій запит і пояснить, у якому місці помилка — без готової відповіді. Поки що перечитай підказки 1–2 і повідомлення перевірки.',
    };
  }
  throw new Error('not implemented');
}
