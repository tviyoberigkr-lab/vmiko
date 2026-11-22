#!/usr/bin/env node
/*
 * Тест клієнтської логіки ШІ-наставника: node tools/test_mentor_client.js
 *
 * Мережі не торкається: fetch, localStorage, document і Turnstile підмінені заглушками.
 * Що перевіряємо (за аркушем ДО_ВИПРАВЛЕННЯ_mentor, п. 7, 9–12, і капчу):
 *   1. вибір рівня підказки (1–3 автор, 4 — ШІ; відкривається після підказки 3 і 2 спроб);
 *   2. Parsons: у наставника має бути ЗІБРАНИЙ з блоків код, а не стартовий;
 *   3. тіло запиту: є checkStage/checkCode, немає поля schema;
 *   4. обробка відповідей: звичайна, truncated, empty, limit/бюджет, таймаут;
 *   5. stage 'internal' — наставника не викликаємо зовсім;
 *   6. капча: вимкнена (немає site key), валідний токен, невалідний токен.
 *      Тестові ключі Cloudflare (developers.cloudflare.com/turnstile/troubleshooting/testing):
 *      site key 1x00000000000000000000AA — завжди проходить, 2x00000000000000000000AB — завжди падає;
 *      secret 1x0000000000000000000000000000000AA — завжди проходить,
 *      2x0000000000000000000000000000000AA — завжди падає; токен-заглушка XXXX.DUMMY.TOKEN.XXXX.
 *      Самого siteverify ми не викликаємо (тест без мережі) — сервер тут імітований.
 * CoLaba Production
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
let failed = 0, passed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log('  ok   ' + name + (detail ? `  (${detail})` : '')); }
  else { failed++; console.log('  FAIL ' + name + (detail ? `  -> ${detail}` : '')); }
}

// ------------------------------------------------------------------ заглушки браузера
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
// crypto у Node вже є (лише для читання) — randomUUID нам саме звідти й потрібен.
// navigator у Node 22 — лише для читання, тому підміняємо через defineProperty.
const nav = { onLine: true };
Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });

// Імітація сервера: повертає те, що покладемо в nextReplies, і запам'ятовує тіла запитів.
const sent = [];
let nextReplies = [];
globalThis.fetch = async (url, opts) => {
  sent.push({ url, body: JSON.parse(opts.body) });
  const r = nextReplies.shift();
  if (!r) throw new Error('тест: немає запланованої відповіді сервера');
  if (r.throw) { const e = new Error('abort'); e.name = r.throw; throw e; }
  return { ok: r.status < 400, status: r.status, json: async () => r.data };
};

// Turnstile: site key з config.js порожній, тому справжній solveCaptcha одразу віддає { unavailable }.
// Валідний і невалідний токен перевіряємо, підмінивши розв'язувач через mentor.setCaptchaSolver.

(async () => {
  const mentor = await import(pathToFileURL(path.join(ROOT, 'app/js/mentor.js')).href);
  const cfg = await import(pathToFileURL(path.join(ROOT, 'app/js/config.js')).href);

  console.log('\n[1] Рівні підказок');
  const exSql = { id: 'm1-d5-03', type: 'sql', title: 'Маржа', prompt: 'Порахуй маржу', hints: ['a', 'b', 'c'], starter: 'SELECT ...' };
  const av0 = mentor.hintAvailability(exSql, { hintsShown: 0, attempts: 0 });
  check('без підказок відкрита лише перша', av0[0].unlocked === true && av0[1].unlocked === false);
  check('рівень 4 існує для sql і закритий', av0.length === 4 && av0[3].ai === true && av0[3].unlocked === false);
  const av3 = mentor.hintAvailability(exSql, { hintsShown: 3, attempts: 2 });
  check('після підказки 3 і 2 спроб рівень 4 відкритий', av3[3].unlocked === true && av3[3].shown === false);
  const av3a = mentor.hintAvailability(exSql, { hintsShown: 3, attempts: 1 });
  check('однієї спроби мало для рівня 4', av3a[3].unlocked === false && av3a[3].needAttempts === 1);
  check('для card/choice рівня ШІ немає', mentor.hintAvailability({ type: 'choice' }, { hintsShown: 3, attempts: 9 }).length === 3);
  const h2 = await mentor.getHint(exSql, 2, {});
  check('рівні 1–3 беруться з вправи, без мережі', h2.source === 'author' && h2.text === 'b' && sent.length === 0);

  console.log('\n[2] Код для наставника: Parsons — зібрані блоки');
  // Повторюємо правило main.js (mentorCode): для Parsons беремо st.parsons, а не стартовий код.
  const mentorCode = (ex, st) => (ex.type === 'parsons' ? (st.parsons || []).join(' ') : (st.code != null ? st.code : ex.starter || ''));
  const exP = { id: 'm1-d7-05', type: 'parsons', title: 'Збери запит', starter: '' };
  check('Parsons: передаються зібрані блоки', mentorCode(exP, { parsons: ['SELECT city', 'FROM customers'] }) === 'SELECT city FROM customers');
  check('Parsons без блоків: порожньо (наставник відмовить сам)', mentorCode(exP, {}) === '');
  check('sql: береться код учня', mentorCode(exSql, { code: 'SELECT 1' }) === 'SELECT 1');
  const src = fs.readFileSync(path.join(ROOT, 'app/js/main.js'), 'utf8');
  check('main.js: наставник отримує mentorCode, а не editorCode', /getHint\(ex, level, \{ code: mentorCode\(ex, st\)/.test(src));
  check('main.js: рівень 4 не позначається показаним при помилці', /if \(!h\.error\) store\.updateExercise/.test(src));
  check('main.js: текст наставника видно й без зарахування рівня', /texts\[AI_LEVEL\] && maxShown < AI_LEVEL/.test(src));

  console.log('\n[3] Тіло запиту');
  const ctx = {
    code: 'SELECT city FROM customers',
    attempts: 3,
    lastCheck: { ok: false, stage: 'visible', code: 'columns_count', message: 'Кількість колонок не та: потрібно 2, у тебе 1.' },
  };
  const body = mentor.buildMentorBody(exSql, ctx, 'device12345678', '');
  check('є checkStage і checkCode', body.checkStage === 'visible' && body.checkCode === 'columns_count');
  check('поля schema немає', !('schema' in body.exercise) && !('schema' in body));
  check('передаються і lastError, і lastCheckMessage', 'lastError' in body && body.lastCheckMessage.startsWith('Кількість колонок'));
  const bodyErr = mentor.buildMentorBody(exSql, { code: 'SELEC 1', lastCheck: { ok: false, stage: 'run', message: 'Запит не виконався.', error: 'syntax error at or near "SELEC"' } }, 'device12345678', '');
  check('помилка бази йде в lastError, повідомлення — окремо', bodyErr.lastError.includes('syntax error') && bodyErr.lastCheckMessage === 'Запит не виконався.');
  check('маркер капчі додається лише коли він є', !('mentor_pass' in body) && mentor.buildMentorBody(exSql, ctx, 'd12345678', 'v1.123.abc').mentor_pass === 'v1.123.abc');

  console.log('\n[4] Обробка відповідей сервера');
  const okHint = mentor.interpretMentorResponse(true, 200, { text: 'Подивися на умову у WHERE.', usage: { input_tokens: 10, output_tokens: 20 }, calls_today: 5 });
  check('звичайна відповідь: текст показано, error немає', okHint.text.startsWith('Подивися') && !okHint.error && okHint.callsToday === 5);
  const trunc = mentor.interpretMentorResponse(true, 200, { text: 'Логіка правильна.', truncated: true });
  check('truncated: текст із припискою', trunc.truncated === true && trunc.text.endsWith(mentor.TRUNCATED_NOTE) && !trunc.error);
  const empty = mentor.interpretMentorResponse(false, 502, { error: 'empty', text: 'Наставник не встиг сформулювати підказку. Натисни ще раз — ця спроба не рахується в ліміт.' });
  check('empty: error=empty, текст сервера', empty.error === 'empty' && empty.text.includes('не рахується'));
  const okButEmpty = mentor.interpretMentorResponse(true, 200, { text: '' });
  check('200 з порожнім текстом усе одно error=empty', okButEmpty.error === 'empty');
  const lim = mentor.interpretMentorResponse(false, 429, { error: 'limit', reason: 'device_limit', text: 'Ліміт звернень до наставника на сьогодні вичерпано (200 на пристрій).' });
  check('ліміт пристрою: error=limit, reason=device_limit', lim.error === 'limit' && lim.reason === 'device_limit');
  const bud = mentor.interpretMentorResponse(false, 429, { error: 'limit', reason: 'budget', text: 'Наставник на сьогодні відпочиває…' });
  check('бюджет: окремий reason', bud.reason === 'budget' && bud.error === 'limit');
  const burst = mentor.interpretMentorResponse(false, 429, { error: 'limit', reason: 'ip_burst', text: 'Зачекай хвилинку…' });
  check('швидкісний ліміт IP: reason=ip_burst', burst.reason === 'ip_burst');
  const db = mentor.interpretMentorResponse(false, 503, { error: 'db', text: 'Наставник зараз недоступний…' });
  check('база недоступна (fail-closed): error=db', db.error === 'db');
  const big = mentor.interpretMentorResponse(false, 413, { error: 'too_large' });
  check('413 без тексту: запасний текст є', big.error === 'too_large' && big.text.includes('недоступний'));

  console.log('\n[5] stage internal — наставника не викликаємо');
  sent.length = 0; nextReplies = [];
  const internal = await mentor.getHint(exSql, 4, { code: 'SELECT 1', attempts: 2, lastCheck: { ok: false, stage: 'internal', message: 'Помилка в еталоні вправи (не твоя провина). Повідом нам.', error: 'relation "orderz" does not exist' } });
  check('жодного запиту на сервер', sent.length === 0, 'запитів: ' + sent.length);
  check('текст про помилку у вправі', internal.text === mentor.INTERNAL_TEXT);
  check('error=internal (рівень 4 не зарахується показаним)', internal.error === 'internal');

  console.log('\n[6] Повний шлях без капчі (site key порожній)');
  check('config.js: капча вимкнена за замовчуванням', cfg.TURNSTILE_SITE_KEY === '');
  check('config.js: текст запрошення в одній константі', typeof cfg.TURNSTILE_PROMPT === 'string' && cfg.TURNSTILE_PROMPT.includes('ШІ-наставник'));
  check('config.js: у текстах саме «ШІ»', !/\bAI\b|АІ/.test(cfg.TURNSTILE_PROMPT + cfg.TURNSTILE_ERROR + cfg.TURNSTILE_CLOSE));
  sent.length = 0; nextReplies = [{ status: 200, data: { text: 'Зверни увагу на умову.', calls_today: 1 } }];
  const plain = await mentor.getHint(exSql, 4, ctx);
  check('один запит, капчі не було', sent.length === 1 && !('captcha_token' in sent[0].body));
  check('підказка показана', plain.text === 'Зверни увагу на умову.' && !plain.error);
  check('маркер капчі не збережено (сервер його не давав)', mentor.savedPass() === '');

  console.log('\n[7] Сервер просить капчу');
  // 7.1 віджет недоступний (site key порожній) → клієнт шле captcha:'unavailable', сервер пропускає
  sent.length = 0;
  nextReplies = [
    { status: 403, data: { error: 'captcha_required', text: cfg.TURNSTILE_PROMPT } },
    { status: 200, data: { text: 'Подивися на GROUP BY.', pass: 'v1.9999999999999.' + 'a'.repeat(64) } },
  ];
  const noWidget = await mentor.getHint(exSql, 4, ctx);
  check('повторний запит пішов', sent.length === 2);
  check('у повторі позначено, що віджета немає', sent[1].body.captcha === 'unavailable' && !sent[1].body.captcha_token);
  check('учня не заблоковано', noWidget.text === 'Подивися на GROUP BY.' && !noWidget.error);
  check('маркер сесії збережено', mentor.savedPass().startsWith('v1.'));

  // 7.2 маркер із попереднього разу шлеться далі — капчі більше немає
  sent.length = 0; nextReplies = [{ status: 200, data: { text: 'Ще підказка.' } }];
  await mentor.getHint(exSql, 4, ctx);
  check('маркер додано в тіло наступного запиту', sent.length === 1 && sent[0].body.mentor_pass.startsWith('v1.'));

  // 7.3 валідний токен капчі (імітуємо site key 1x…AA: callback одразу віддає токен)
  mentor.clearPass();
  sent.length = 0;
  nextReplies = [
    { status: 403, data: { error: 'captcha_required', text: cfg.TURNSTILE_PROMPT } },
    { status: 200, data: { text: 'Перевір тип колонки.', pass: 'v1.8888888888888.' + 'b'.repeat(64) } },
  ];
  const okCaptcha = await withCaptcha(mentor, async () => ({ token: 'XXXX.DUMMY.TOKEN.XXXX' }), () => mentor.getHint(exSql, 4, ctx));
  check('валідний токен пішов на сервер', sent.length === 2 && sent[1].body.captcha_token === 'XXXX.DUMMY.TOKEN.XXXX');
  check('після перевірки підказка показана', okCaptcha.text === 'Перевір тип колонки.' && !okCaptcha.error);
  check('новий маркер збережено', mentor.savedPass().includes('8888888888888'));

  // 7.4 невалідний токен (site key 2x…AB / secret 2x…AA): сервер відповідає 403 captcha
  mentor.clearPass();
  sent.length = 0;
  nextReplies = [
    { status: 403, data: { error: 'captcha_required', text: cfg.TURNSTILE_PROMPT } },
    { status: 403, data: { error: 'captcha', text: 'Перевірка не вдалася. Спробуй ще раз.' } },
  ];
  const badCaptcha = await withCaptcha(mentor, async () => ({ token: 'XXXX.DUMMY.TOKEN.XXXX' }), () => mentor.getHint(exSql, 4, ctx));
  check('невалідний токен: показано текст про невдачу', badCaptcha.text.includes('Перевірка не вдалася'));
  check('невалідний токен: error=captcha (рівень не зарахується)', badCaptcha.error === 'captcha');
  check('маркер не збережено', mentor.savedPass() === '');

  // 7.5 учень закрив вікно перевірки
  sent.length = 0;
  nextReplies = [{ status: 403, data: { error: 'captcha_required', text: cfg.TURNSTILE_PROMPT } }];
  const cancelled = await withCaptcha(mentor, async () => ({ cancelled: true }), () => mentor.getHint(exSql, 4, ctx));
  check('після закриття вікна другого запиту немає', sent.length === 1);
  check('пояснення учневі, що перевірка потрібна', cancelled.error === 'captcha_cancelled' && cancelled.text.includes('перевірки'));

  console.log('\n[8] Збої мережі');
  sent.length = 0; nextReplies = [{ throw: 'AbortError' }];
  const to = await mentor.getHint(exSql, 4, ctx);
  check('таймаут: error=timeout, текст про повтор', to.error === 'timeout' && to.text.includes('ще раз'));
  nextReplies = [{ throw: 'TypeError' }];
  const net = await mentor.getHint(exSql, 4, ctx);
  check('мережа: м\'який текст і error', !!net.error && net.text.includes('інтернет'));
  nav.onLine = false;
  const off = await mentor.getHint(exSql, 4, ctx);
  check('офлайн: запиту немає', off.error === 'offline' && off.text.includes('інтернет'));
  nav.onLine = true;
  const noCode = await mentor.getHint(exSql, 4, { code: '   ', attempts: 2 });
  check('порожній код: наставника не викликаємо', noCode.text.includes('напиши хоч якийсь запит'));

  console.log(`\nУсього: ${passed} ok, ${failed} FAIL`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('ПРОВАЛ тесту:', e); process.exit(1); });

/** Підміняє розв'язувач капчі на час одного виклику (mentor.setCaptchaSolver). */
async function withCaptcha(mentor, stub, fn) {
  mentor.setCaptchaSolver(stub);
  try { return await fn(); } finally { mentor.setCaptchaSolver(null); }
}
