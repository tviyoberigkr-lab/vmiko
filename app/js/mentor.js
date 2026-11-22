/*
 * ШІ-наставник.
 * Сходинки підказок (розділ 4 специфікації):
 *   рівень 1 — напрям (автор, без ШІ);
 *   рівень 2 — конкретне місце (автор, без ШІ);
 *   рівень 3 — приклад на іншій таблиці (автор, без ШІ);
 *   рівень 4 — ШІ-наставник дивиться на КОД УЧНЯ і пояснює, де помилка, без готового запиту.
 *              Відкривається після підказки 3 і ≥2 невдалих спроб; лише для sql/parsons.
 * Ключ Anthropic у браузері не живе: запит іде на Supabase Edge Function `mentor` (supabase/functions/mentor),
 * яка тримає ключ у секреті, ріже вхід і тримає чотири рівні лімітів (пристрій 200/добу, IP 500/добу
 * і 10/хв, частка пристрою 3 % витрат, глобальний бюджет $3/добу).
 * Капча (Cloudflare Turnstile) — лише перед першим за добу зверненням і лише якщо власник увімкнув
 * її ключами (app/js/config.js + секрет TURNSTILE_SECRET_KEY); без ключів поведінка колишня.
 * CoLaba Production
 */
import { TURNSTILE_SITE_KEY, TURNSTILE_PROMPT, TURNSTILE_ERROR, TURNSTILE_CLOSE, TURNSTILE_LOAD_TIMEOUT_MS } from './config.js';

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

// ------------------------------------------------------------------ капча (Cloudflare Turnstile)
// Капча з'являється лише перед ПЕРШИМ за добу зверненням до наставника. Після перевірки сервер
// віддає маркер сесії (`pass`), ми тримаємо його в localStorage і шлемо далі — доки не прострочиться.
// Якщо site key порожній або віджет не завантажився, учня не блокуємо: шлемо запит і сервер
// (за наявності секрету) залогує turnstile_unavailable.

const PASS_KEY = 'vmiko:mentorpass';
export function savedPass() { try { return localStorage.getItem(PASS_KEY) || ''; } catch (_) { return ''; } }
export function savePass(p) { try { if (p) localStorage.setItem(PASS_KEY, String(p)); } catch (_) { /* приватний режим */ } }
export function clearPass() { try { localStorage.removeItem(PASS_KEY); } catch (_) { /* приватний режим */ } }

let turnstileLoading = null;
function loadTurnstile() {
  if (typeof document === 'undefined') return Promise.reject(new Error('no-dom'));
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (turnstileLoading) return turnstileLoading;
  turnstileLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true; s.defer = true;
    const timer = setTimeout(() => reject(new Error('timeout')), TURNSTILE_LOAD_TIMEOUT_MS);
    s.onload = () => { clearTimeout(timer); window.turnstile ? resolve(window.turnstile) : reject(new Error('no-api')); };
    s.onerror = () => { clearTimeout(timer); reject(new Error('script')); };
    document.head.appendChild(s);
  }).catch((e) => { turnstileLoading = null; throw e; });
  return turnstileLoading;
}

/**
 * Показує вікно перевірки й повертає токен.
 * @returns {Promise<{token?: string, unavailable?: boolean, cancelled?: boolean}>}
 */
export async function solveCaptcha() {
  if (!TURNSTILE_SITE_KEY) return { unavailable: true, why: 'no-sitekey' };
  let api;
  try { api = await loadTurnstile(); } catch (e) { return { unavailable: true, why: String((e && e.message) || e) }; }

  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'captcha-back';
    back.setAttribute('role', 'dialog');
    back.setAttribute('aria-label', 'Перевірка, що ти не робот');
    back.style.cssText = 'position:fixed;inset:0;z-index:999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);padding:16px';
    const win = document.createElement('div');
    win.style.cssText = 'background:#fff;color:#111;border-radius:12px;max-width:380px;width:100%;padding:20px;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,.3)';
    const p = document.createElement('p');
    p.textContent = TURNSTILE_PROMPT;
    p.style.cssText = 'margin:0 0 14px;line-height:1.45';
    const holder = document.createElement('div');
    holder.style.cssText = 'display:flex;justify-content:center;min-height:68px';
    const err = document.createElement('p');
    err.style.cssText = 'margin:10px 0 0;color:#b00020;min-height:1.2em';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'btn link';
    close.textContent = TURNSTILE_CLOSE;
    close.style.cssText = 'margin-top:12px';
    win.append(p, holder, err, close);
    back.append(win);
    document.body.append(back);

    let done = false;
    const finish = (res) => { if (done) return; done = true; try { back.remove(); } catch (_) { /* уже знято */ } resolve(res); };
    close.addEventListener('click', () => finish({ cancelled: true }));

    try {
      api.render(holder, {
        sitekey: TURNSTILE_SITE_KEY,
        language: 'uk',
        callback: (token) => finish({ token }),
        'error-callback': () => { err.textContent = TURNSTILE_ERROR; },
        'expired-callback': () => { err.textContent = TURNSTILE_ERROR; },
      });
    } catch (e) {
      finish({ unavailable: true, why: 'render:' + String((e && e.message) || e) });
    }
  });
}

/**
 * Розв'язувач капчі. За замовчуванням — вікно з віджетом Turnstile; підміняється лише в тесті
 * tools/test_mentor_client.js (у браузері завжди працює справжній віджет).
 */
let captchaSolver = solveCaptcha;
export function setCaptchaSolver(fn) { captchaSolver = fn || solveCaptcha; }

/** Текст, що показуємо замість виклику наставника, коли помилка не в учневі. */
export const INTERNAL_TEXT = 'Помилка у самій вправі, а не в тобі. Повідом нам — наставник тут не допоможе.';
/** Приписка до обірваної відповіді: учень має бачити, що думку не докінчено. */
export const TRUNCATED_NOTE = '\n\n(Наставник не докінчив думку. Натисни «Запитати наставника ще раз», якщо лишилося незрозуміло.)';

/** Тіло запиту до функції наставника. Виокремлено, щоб перевірятися тестом без мережі. */
export function buildMentorBody(exercise, context, device, pass) {
  const lc = (context && context.lastCheck) || null;
  return {
    device_id: device,
    kind: 'hint',
    attempts: (context && context.attempts) || 0,
    // Схему бази функція тримає сама (docs/schema_koshyk.md) — з клієнта її не передаємо.
    exercise: { title: exercise.title || '', prompt: exercise.prompt || '' },
    code: (context && context.code) || '',
    lastError: lc && lc.error ? String(lc.error) : '',
    lastCheckMessage: lc ? String(lc.message || lc.verdict || '') : '',
    checkStage: lc ? String(lc.stage || '') : '',
    checkCode: lc ? String(lc.code || '') : '',
    ...(pass ? { mentor_pass: pass } : {}),
  };
}

/** Перетворює відповідь функції на підказку для інтерфейсу. Чиста функція — під тестом. */
export function interpretMentorResponse(ok, status, data) {
  const d = data || {};
  if (!ok) {
    // Ліміт, бюджет, порожня відповідь, таймаут сервера: показуємо текст сервера і ПОВЕРТАЄМО error,
    // щоб main.js не зарахував рівень 4 показаним і не збільшував aiAsks.
    return {
      level: AI_LEVEL, source: 'ai',
      text: d.text || 'Наставник зараз недоступний. Спробуй за хвилину або перечитай підказки 1–3.',
      error: d.error || status, reason: d.reason || '',
    };
  }
  if (!d.text) {
    return { level: AI_LEVEL, source: 'ai', text: 'Наставник не відповів. Натисни ще раз — ця спроба не рахується.', error: 'empty' };
  }
  return {
    level: AI_LEVEL, source: 'ai',
    text: d.truncated ? d.text + TRUNCATED_NOTE : d.text,
    truncated: !!d.truncated,
    usage: d.usage, callsToday: d.calls_today,
  };
}

async function postMentor(body) {
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
    return { ok: r.ok, status: r.status, data };
  } finally { clearTimeout(timer); }
}

async function aiHint(exercise, context) {
  // context: { code, attempts, lastCheck }
  const code = (context && context.code) || '';
  if (!code.trim()) return { level: AI_LEVEL, source: 'ai', text: 'Спочатку напиши хоч якийсь запит — наставник дивиться саме на твій код.' };
  const lc = (context && context.lastCheck) || null;
  // stage 'internal' — не виконався ЕТАЛОН вправи. Передати це наставникові означає дати йому
  // чужу помилку як помилку учня (і витратити звернення даремно).
  if (lc && lc.stage === 'internal') {
    return { level: AI_LEVEL, source: 'ai', text: INTERNAL_TEXT, error: 'internal' };
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { level: AI_LEVEL, source: 'ai', text: 'Наставнику потрібен інтернет. Поки мережі немає, перечитай підказки 1–3.', error: 'offline' };
  }
  const body = buildMentorBody(exercise, context, deviceId(), savedPass());
  try {
    let res = await postMentor(body);
    // Сервер просить капчу: показуємо вікно перевірки й повторюємо запит один раз.
    if (!res.ok && (res.data.error === 'captcha_required' || res.data.error === 'captcha')) {
      clearPass();
      const c = await captchaSolver();
      if (c.cancelled) {
        return { level: AI_LEVEL, source: 'ai', text: 'Без короткої перевірки наставник не вмикається. Натисни «Запитати наставника (ШІ)» ще раз, коли будеш готовий.', error: 'captcha_cancelled' };
      }
      const retry = { ...body, mentor_pass: '' };
      if (c.token) retry.captcha_token = c.token;
      else retry.captcha = 'unavailable';   // віджет не завантажився — сервер залогує turnstile_unavailable
      res = await postMentor(retry);
    }
    if (res.data && res.data.pass) savePass(res.data.pass);
    return interpretMentorResponse(res.ok, res.status, res.data);
  } catch (e) {
    return { level: AI_LEVEL, source: 'ai', text: e.name === 'AbortError' ? 'Наставник думає надто довго. Натисни ще раз — ця спроба не рахується.' : 'Не вдалося зв\'язатися з наставником. Перевір інтернет і спробуй ще раз.', error: e.name === 'AbortError' ? 'timeout' : String(e) };
  }
}
