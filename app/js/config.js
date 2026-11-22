/*
 * Vmiko — налаштування клієнта, які власник може змінити без правок логіки.
 * Тут немає жодного секрету: site key Turnstile призначений саме для браузера.
 * CoLaba Production
 */

/**
 * Cloudflare Turnstile, публічний Site Key.
 * ПОРОЖНЄ значення = капча вимкнена: застосунок працює точно як без неї.
 * Увімкнення: вставити сюди Site Key із dash.cloudflare.com → Turnstile
 * (домен tviyoberigkr-lab.github.io, Widget Mode = Managed) і покласти Secret Key
 * у Supabase → Edge Functions → Secrets під іменем TURNSTILE_SECRET_KEY.
 * Поки секрету немає на сервері, капча не спрацює навіть із заповненим ключем.
 */
export const TURNSTILE_SITE_KEY = '';

/** Текст у модальному вікні перевірки (замінюється одним рядком). */
export const TURNSTILE_PROMPT = 'Далі тобі допоможе ШІ-наставник. Одна коротка перевірка, що ти не робот — і більше вона не з\'явиться.';
// Другий варіант власника — просто розкоментувати замість рядка вище:
// export const TURNSTILE_PROMPT = 'У проєкті є ШІ-наставник. Просимо пройти перевірку, що ти не робот.';

/** Підписи у вікні перевірки. */
export const TURNSTILE_ERROR = 'Перевірка не вдалася. Спробуй ще раз';
export const TURNSTILE_CLOSE = 'Закрити';

/** Скільки чекаємо на завантаження скрипта Turnstile, перш ніж пропустити учня далі без перевірки. */
export const TURNSTILE_LOAD_TIMEOUT_MS = 8000;
