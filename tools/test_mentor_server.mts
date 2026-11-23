#!/usr/bin/env node
/*
 * Прогін серверної логіки наставника без мережі й без деплою:
 *   node --experimental-strip-types tools/test_mentor_server.mts
 *
 * Як це працює: supabase/functions/mentor/index.ts читається з диска, у ньому підмінюються
 * імпорти (Deno, supabase-js) і Deno.serve, після чого handler викликається справжніми Request.
 * RPC ідуть у СПРАВЖНІЙ Postgres (PGlite) з застосованою міграцією 20261122_mentor_budget.sql,
 * а виклики api.anthropic.com і challenges.cloudflare.com підміняються заглушками.
 * Тому тест бачить реальні лічильники, release і бюджет, але нікуди не ходить і нічого не витрачає.
 *
 * Потрібен Node ≥ 22 (стирання типів) і встановлений @electric-sql/pglite (devDependency).
 * CoLaba Production
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = path.join(ROOT, 'supabase/functions/mentor/index.ts');
const OUT = path.join(os.tmpdir(), 'vmiko_mentor_sim.mts');
let src = fs.readFileSync(SRC, 'utf8');
src = src.replace('import "jsr:@supabase/functions-js/edge-runtime.d.ts";', '');
src = src.replace('import { createClient } from "jsr:@supabase/supabase-js@2";',
  'const createClient = (globalThis as any).__createClient;');
src = src.replace('Deno.serve(', '(globalThis as any).__setHandler(');
src = src.replace(/Deno\.env\.get/g, '(globalThis as any).__env');
fs.writeFileSync(OUT, src);

const db = await PGlite.create();
await db.exec('create role anon; create role authenticated; create role service_role;');
await db.exec(fs.readFileSync(path.join(ROOT, 'supabase/migrations/20261122_mentor_budget.sql'), 'utf8'));
await db.exec(fs.readFileSync(path.join(ROOT, 'supabase/migrations/20261123_mentor_usage_rollup.sql'), 'utf8'));

let dbDown = false;
const rpc = async (fn: string, a: any) => {
  if (dbDown) return { data: null, error: { message: 'connection refused' } };
  try {
    if (fn === 'mentor_reserve') {
      const r = await db.query('select * from public.mentor_reserve($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [a.p_device, a.p_ip, a.p_device_limit, a.p_ip_limit, a.p_ip_burst, a.p_budget_usd, a.p_device_share, a.p_device_floor_usd, a.p_price_in, a.p_price_out]);
      return { data: r.rows, error: null };
    }
    if (fn === 'mentor_release') { await db.query('select public.mentor_release($1,$2)', [a.p_device, a.p_ip]); return { data: null, error: null }; }
    if (fn === 'mentor_tokens') { await db.query('select public.mentor_tokens($1,$2,$3)', [a.p_device, a.p_in, a.p_out]); return { data: null, error: null }; }
    return { data: null, error: { message: 'невідома rpc ' + fn } };
  } catch (e: any) { return { data: null, error: { message: e.message } }; }
};
(globalThis as any).__createClient = () => ({ rpc });

// --- підміна fetch: Anthropic і Cloudflare
let anthropicReply: any = null;
let anthropicCalls = 0;
let lastPrompt = '';
let lastPayload: any = null;
let siteverifyOk = true, siteverifyCalls = 0, siteverifyDown = false;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, opts: any) => {
  const u = String(url);
  if (u.includes('api.anthropic.com')) {
    lastPayload = JSON.parse(opts.body);
    lastPrompt = lastPayload.messages[0].content;
    anthropicCalls++;
    // Масив = черга відповідей: перша на перший виклик, друга на повтор запобіжника.
    if (Array.isArray(anthropicReply)) {
      const next = anthropicReply.shift();
      return new Response(JSON.stringify(next), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (anthropicReply === 'abort') { const e: any = new Error('aborted'); e.name = 'AbortError'; throw e; }
    if (anthropicReply === '400effort') return new Response(JSON.stringify({ error: { message: 'output_config: unexpected field' } }), { status: 400 });
    return new Response(JSON.stringify(anthropicReply), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.includes('challenges.cloudflare.com')) {
    siteverifyCalls++;
    if (siteverifyDown) throw new Error('network');
    return new Response(JSON.stringify(siteverifyOk ? { success: true } : { success: false, 'error-codes': ['invalid-input-response'] }), { status: 200 });
  }
  return realFetch(url, opts);
}) as any;

// --- оточення
const ORIGIN = 'https://tviyoberigkr-lab.github.io';
let env: Record<string, string> = { ANTHROPIC_API_KEY: 'k', SUPABASE_URL: 'u', SUPABASE_SERVICE_ROLE_KEY: 's', ENV: 'prod' };
(globalThis as any).__env = (k: string) => env[k];

let handler: any;
(globalThis as any).__setHandler = (h: any) => { handler = h; };

let failed = 0, passed = 0;
const check = (name: string, cond: any, detail = '') => {
  if (cond) { passed++; console.log('  ok   ' + name + (detail ? `  (${detail})` : '')); }
  else { failed++; console.log('  FAIL ' + name + (detail ? `  -> ${detail}` : '')); }
};
const post = (body: any, origin: string | null = ORIGIN, extraHeaders: any = {}) => handler(new Request('https://x/mentor', {
  method: 'POST',
  headers: { ...(origin ? { origin } : {}), 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7, 10.0.0.1', ...extraHeaders },
  body: typeof body === 'string' ? body : JSON.stringify(body),
}));
const base = (over: any = {}) => ({
  device_id: 'devicetest0001', kind: 'hint', attempts: 3,
  exercise: { title: 'Маржа', prompt: 'Порахуй маржу' },
  code: 'SELECT (price_uah - cost_uah) / price_uah FROM products',
  lastError: '', lastCheckMessage: 'Кількість рядків правильна, але значення відрізняються.',
  checkStage: 'visible', checkCode: 'values', ...over,
});
const text = (s: string) => ({ id: 'm', content: [{ type: 'text', text: s }], stop_reason: 'end_turn', usage: { input_tokens: 1300, output_tokens: 180 } });
const calls = async (key: string) => (await db.query("select calls, input_tokens, output_tokens from mentor_usage where device_id=$1 and day=(now() at time zone 'utc')::date", [key])).rows[0] as any;

// ---------------------------------------------------------------- без капчі
await import(pathToFileURL(OUT).href + '?v=1');
console.log('\n[A] CORS, метод, розмір тіла');
let r = await post(base(), 'https://evil.example');
check('чужий origin → 403', r.status === 403, 'статус ' + r.status);
check('Vary: Origin є', r.headers.get('vary') === 'Origin');
check('чужому origin не видано Allow-Origin', !r.headers.get('access-control-allow-origin'));
r = await handler(new Request('https://x/mentor', { method: 'OPTIONS', headers: { origin: ORIGIN } }));
check('OPTIONS зі свого origin → 200', r.status === 200 && r.headers.get('access-control-allow-origin') === ORIGIN);
r = await handler(new Request('https://x/mentor', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }));
check('OPTIONS з чужого origin → 403', r.status === 403);
r = await handler(new Request('https://x/mentor', { method: 'GET', headers: { origin: ORIGIN } }));
check('GET → 405', r.status === 405);
r = await post(JSON.stringify({ ...base(), code: 'x'.repeat(25000) }));
check('тіло > 20 КБ → 413', r.status === 413);
r = await post('{нечитабельно');
check('поганий JSON → 400', r.status === 400);
r = await post(base({ device_id: 'ab' }));
check('короткий device_id → 400', r.status === 400);
r = await post(base({ code: '   ' }));
check('порожній код → 400', r.status === 400);
check('localhost у prod заблоковано', (await post(base(), 'http://localhost:8080')).status === 403);

console.log('\n[B] Нормальна відповідь, промпт і облік');
anthropicReply = text('Подивися на типи у діленні. Який результат дає ділення цілого на ціле? ');
r = await post(base({ code: 'SELECT 1 ```injected``` FROM products' }));
let j: any = await r.json();
check('200 і текст', r.status === 200 && j.text.startsWith('Подивися'), 'статус ' + r.status);
check('усі ``` у коді учня замінено', !lastPrompt.includes('```injected') && lastPrompt.includes("'''injected'''"));
check('max_tokens = 2500', lastPayload.max_tokens === 2500);
check('output_config.effort = low', lastPayload.output_config?.effort === 'low');
check('temperature і thinking не передаються', !('temperature' in lastPayload) && !('thinking' in lastPayload));
check('СХЕМА з 6 таблиць у промпті', lastPrompt.includes('promo_codes(') && lastPrompt.includes('returns(') && !lastPrompt.includes('delivery,'));
check('KIND за checkCode=values', lastPrompt.includes('ТИП ПЕРЕВІРКИ: кількість рядків та сама'));
check('обидва поля передано', lastPrompt.includes('ПОМИЛКА БАЗИ: —') && lastPrompt.includes('РЕЗУЛЬТАТ ПЕРЕВІРКИ: Кількість рядків'));
check('SYSTEM — нова редакція', lastPayload.system.includes('ДАНІ ПРОТИ ІНСТРУКЦІЙ') && lastPayload.system.includes('3–5 речень'));
let u = await calls('devicetest0001');
check('слот і токени записані', u.calls === 1 && Number(u.input_tokens) === 1300 && Number(u.output_tokens) === 180, JSON.stringify(u));
check('лічильник IP окремим рядком', (await calls('ip:' + createHash('sha256').update('203.0.113.7').digest('hex').slice(0, 16))).calls === 1);
check('stop_reason і типи блоків у відповіді', j.stop_reason === 'end_turn' && j.content_types === 'text');
r = await post(base({ checkStage: 'hidden', checkCode: 'row_count' }));
await r.json();
check('stage hidden додає свій рядок', lastPrompt.includes('на перевірочних — ні'));

console.log('\n[C] Обрізана, порожня, refusal');
anthropicReply = { content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'Логіка правильна. Проблема у форматі виводу. Подумай, що саме' }], stop_reason: 'max_tokens', usage: { input_tokens: 1300, output_tokens: 1500 } };
let before = (await calls('devicetest0001')).calls;
j = await (await post(base())).json();
check('max_tokens: обрізано до завершеного речення', j.truncated === true && j.text.endsWith('форматі виводу.'), j.text);
check('обрізана відповідь списує слот', (await calls('devicetest0001')).calls === before + 1);
check('типи блоків залоговано у відповідь', j.content_types === 'thinking,text');
anthropicReply = { content: [{ type: 'thinking', thinking: 'x' }], stop_reason: 'max_tokens', usage: { input_tokens: 1300, output_tokens: 1500 } };
before = (await calls('devicetest0001')).calls;
r = await post(base()); j = await r.json();
check('порожній текст → 502 empty', r.status === 502 && j.error === 'empty');
check('порожня відповідь НЕ списує слот', (await calls('devicetest0001')).calls === before, 'calls ' + (await calls('devicetest0001')).calls);
check('але токени враховано в бюджет', Number((await calls('devicetest0001')).output_tokens) > 0);
anthropicReply = { content: [], stop_reason: 'refusal', usage: { input_tokens: 1300, output_tokens: 20 } };
before = (await calls('devicetest0001')).calls;
r = await post(base()); j = await r.json();
check('refusal → 200 з м\'яким текстом', r.status === 200 && j.refusal === true && j.text.includes('Тут я не допоможу'));
check('refusal не списує слот', (await calls('devicetest0001')).calls === before);
anthropicReply = { content: [{ type: 'text', text: 'Коротко' }], stop_reason: 'max_tokens', usage: { input_tokens: 10, output_tokens: 1500 } };
r = await post(base()); j = await r.json();
check('обрізок < 40 символів → empty', r.status === 502 && j.error === 'empty');

console.log('\n[D] Збої моделі й бази');
anthropicReply = 'abort';
before = (await calls('devicetest0001')).calls;
r = await post(base()); j = await r.json();
check('таймаут/abort → 504 і м\'який текст', r.status === 504 && j.error === 'timeout' && j.text.includes('надто довго'));
check('після таймауту слот звільнено', (await calls('devicetest0001')).calls === before);
anthropicReply = '400effort';
r = await post(base()); j = await r.json();
check('400 про output_config: другий запит без нього', !('output_config' in lastPayload), JSON.stringify(Object.keys(lastPayload)));
check('після запасного шляху все одно є відповідь або 502', r.status === 502 || r.status === 200);
dbDown = true;
r = await post(base()); j = await r.json();
check('база недоступна → 503, модель не викликана (fail-closed)', r.status === 503 && j.error === 'db');
dbDown = false;

console.log('\n[E] Ліміти');
await db.query("update mentor_usage set calls = 200 where device_id='devicetest0001'");
anthropicReply = text('ок');
r = await post(base()); j = await r.json();
check('ліміт пристрою 200 → 429 device_limit', r.status === 429 && j.reason === 'device_limit' && j.text.includes('вичерпано'));
// Текст відмови свідомо без числа: для клієнта без віджета капчі ліміт інший (20), і згадка «200» брехала б.
await db.query("update mentor_usage set calls = 0, input_tokens = 0, output_tokens = 0");
await db.query("select public.mentor_tokens('other-device', 4000000, 4000000)");  // $2.40
r = await post(base()); j = await r.json();
check('бюджет не вичерпано ($2.40 з $3) → працює', r.status === 200, 'статус ' + r.status);
await db.query("select public.mentor_tokens('other-device', 2000000, 2000000)");  // всього $3.60
r = await post(base()); j = await r.json();
check('бюджет вичерпано → 429 budget', r.status === 429 && j.reason === 'budget' && j.text.includes('відпочиває'));

console.log('\n[F] Капча (є секрет TURNSTILE_SECRET_KEY)');
await db.query('delete from mentor_usage'); await db.query('delete from mentor_ip_burst');
env = { ...env, TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' };
await import(pathToFileURL(OUT).href + '?v=2');   // новий ізолят: константи читаються заново
anthropicReply = text('Підказка з капчею.');
r = await post(base()); j = await r.json();
check('без токена → 403 captcha_required', r.status === 403 && j.error === 'captcha_required' && j.text.includes('ШІ-наставник'));
check('капча не списала слот', !(await calls('devicetest0001')));
siteverifyOk = true; siteverifyCalls = 0;
r = await post(base({ captcha_token: 'XXXX.DUMMY.TOKEN.XXXX' })); j = await r.json();
check('валідний токен → 200 і маркер сесії', r.status === 200 && typeof j.pass === 'string' && j.pass.startsWith('v1.'), JSON.stringify(j).slice(0, 120));
check('siteverify викликано один раз', siteverifyCalls === 1);
const pass = j.pass;
r = await post(base({ mentor_pass: pass })); j = await r.json();
check('маркер приймається без нового siteverify', r.status === 200 && siteverifyCalls === 1 && !j.pass);
r = await post(base({ mentor_pass: pass.slice(0, -2) + 'ff' })); j = await r.json();
check('підроблений маркер відкинуто', r.status === 403 && j.error === 'captcha_required');
siteverifyOk = false;
r = await post(base({ captcha_token: 'bad' })); j = await r.json();
check('невалідний токен → 403 captcha', r.status === 403 && j.error === 'captcha' && j.text.includes('не вдалася'));
siteverifyOk = true; siteverifyDown = true;
r = await post(base({ captcha_token: 'XXXX.DUMMY.TOKEN.XXXX' })); j = await r.json();
check('Cloudflare недосяжний → учня пропущено (turnstile_unavailable)', r.status === 200 && !j.pass);
siteverifyDown = false;
r = await post(base({ captcha: 'unavailable' })); j = await r.json();
check('віджет не завантажився у клієнта → пропущено', r.status === 200);


// ---------------------------------------------------------------- згортка mentor_usage (п.26)
// Перевіряємо не «функція не падає», а що саме вона робить із цифрами: старі рядки зникають
// із детальної таблиці, але їхні підсумки лишаються в архіві, а свіжі рядки не чіпаються.
{
  await db.exec(`delete from mentor_usage; delete from mentor_usage_archive;`);
  const old = `(now() at time zone 'utc')::date - 40`;
  const fresh = `(now() at time zone 'utc')::date - 3`;
  await db.exec(`
    insert into mentor_usage (device_id, day, calls, input_tokens, output_tokens) values
      ('dev-a',  ${old},   5, 1000, 200),
      ('dev-b',  ${old},   3,  600, 120),
      ('ip:beef',${old},   8,    0,   0),
      ('dev-c',  ${fresh}, 7, 1400, 300);
  `);
  const removed = (await db.query<{ mentor_usage_rollup: number }>(`select mentor_usage_rollup(30)`)).rows[0].mentor_usage_rollup;
  check('згортка видалила лише рядки старші за 30 діб', removed === 3, `видалено ${removed}`);

  const left = (await db.query<{ device_id: string }>(`select device_id from mentor_usage order by device_id`)).rows;
  check('свіжий рядок лишився недоторканим', left.length === 1 && left[0].device_id === 'dev-c');

  const a = (await db.query<{ devices: number; calls: string; input_tokens: string; output_tokens: string }>(
    `select devices, calls, input_tokens, output_tokens from mentor_usage_archive`)).rows;
  check('архів має рівно одну добу', a.length === 1, `діб: ${a.length}`);
  // пристроїв 2 (dev-a, dev-b) — рядок 'ip:beef' не пристрій; звернень 8 = 5+3 без 'ip:'
  check('архів рахує пристрої без рядків ip:', a[0] && a[0].devices === 2, JSON.stringify(a[0]));
  check('архів рахує звернення без подвоєння ip:', a[0] && Number(a[0].calls) === 8, JSON.stringify(a[0]));
  check('архів зберіг токени', a[0] && Number(a[0].input_tokens) === 1600 && Number(a[0].output_tokens) === 320, JSON.stringify(a[0]));

  // повторний запуск не має ні падати, ні псувати вже збережену добу
  const again = (await db.query<{ mentor_usage_rollup: number }>(`select mentor_usage_rollup(30)`)).rows[0].mentor_usage_rollup;
  const a2 = (await db.query<{ n: string }>(`select count(*) n from mentor_usage_archive`)).rows[0];
  check('повторна згортка безпечна', again === 0 && Number(a2.n) === 1, `видалено ${again}, діб ${a2.n}`);
}


// ---------------------------------------------------------------- запобіжник від витоку назв
console.log('\n[З] Запобіжник: назва зі схеми, якої немає в коді учня');
{
  // Блок стоїть після перевірок капчі, тож вона ввімкнена — даємо кожному запиту токен.
  siteverifyOk = true; siteverifyDown = false;
  await db.exec('delete from mentor_ip_burst');
  const studentCode = 'SELECT product_name, price_uah FROM orders LIMIT 10';

  // 1. Чисто: модель назвала лише те, що вже є в коді учня — повтору бути не повинно.
  anthropicCalls = 0;
  anthropicReply = text('У твоєму запиті після FROM стоїть orders, а назви товарів живуть в іншій таблиці. Де саме їх шукати за схемою?');
  await db.exec('delete from mentor_ip_burst');
  let g = await post(base({ captcha_token: 'ok', code: studentCode, device_id: 'guard-clean-001' }));
  let gj: any = await g.json();
  check('назва з коду учня (orders) не вважається витоком', g.status === 200 && gj.retried === false, JSON.stringify({ s: g.status, r: gj.retried }));
  check('без витоку модель викликано рівно раз', anthropicCalls === 1, 'викликів ' + anthropicCalls);

  // 2. Витік: названо products, якого в коді учня немає. Повтор має виправити.
  anthropicCalls = 0;
  anthropicReply = [
    text('Назви товарів лежать у таблиці products, а ти читаєш orders. Яку таблицю взяти?'),
    text('Ти читаєш таблицю із замовленнями, а потрібні назви товарів. Подивись у схемі, де вони живуть. Яку таблицю поставити у FROM?'),
  ];
  await db.exec('delete from mentor_ip_burst');
  g = await post(base({ captcha_token: 'ok', code: studentCode, device_id: 'guard-retry-001' }));
  gj = await g.json();
  check('витік спричинив повтор', gj.retried === true, JSON.stringify(gj).slice(0, 160));
  check('повтор зроблено одним додатковим викликом', anthropicCalls === 2, 'викликів ' + anthropicCalls);
  check('у підсумковій відповіді витоку немає', !/products/.test(gj.text), gj.text);
  check('підказку не підмінено заглушкою', gj.guarded === false && /FROM/.test(gj.text), JSON.stringify(gj).slice(0, 160));

  // 3. Витік і після повтору — показуємо нейтральний текст, а не відповідь.
  anthropicCalls = 0;
  anthropicReply = [
    text('Назви товарів лежать у таблиці products. Яку таблицю взяти?'),
    text('Я ж кажу: це products. Яку таблицю взяти?'),
  ];
  await db.exec('delete from mentor_ip_burst');
  g = await post(base({ captcha_token: 'ok', code: studentCode, device_id: 'guard-fallback-1' }));
  gj = await g.json();
  check('повторний витік → guarded', gj.guarded === true, JSON.stringify(gj).slice(0, 160));
  check('назви у відповіді немає', !/products/.test(gj.text), gj.text);
  check('нейтральний текст усе одно веде далі (є запитання)', /\?\s*$/.test(gj.text.trim()), gj.text);

  // 4. Регістр має значення: учень написав "Order_ID", схема має order_id — це витік.
  anthropicCalls = 0;
  anthropicReply = [
    text('У таблиці ідентифікатор називається order_id, маленькими літерами. Як це записати?'),
    text('Подвійні лапки роблять назву чутливою до регістру, тому написання має збігтися зі схемою точно. Як записати назву, щоб збіг був точним?'),
  ];
  await db.exec('delete from mentor_ip_burst');
  g = await post(base({ captcha_token: 'ok', code: 'SELECT "Order_ID", order_date FROM orders LIMIT 20', device_id: 'guard-case-0001' }));
  gj = await g.json();
  check('order_id при "Order_ID" у коді — витік', gj.retried === true, JSON.stringify(gj).slice(0, 160));
  check('order_date з коду учня витоком не вважається', !/order_date.*витік/.test(JSON.stringify(gj)));

  // 5. Назва, яку вже назвала сама база в помилці, витоком не є.
  anthropicCalls = 0;
  anthropicReply = text('База каже, що customers не знайдено через зайву літеру. Що саме відрізняється?');
  await db.exec('delete from mentor_ip_burst');
  g = await post(base({ captcha_token: 'ok', code: 'SELECT * FROM customerss', lastError: 'relation "customers" does not exist', device_id: 'guard-fromerr-01' }));
  gj = await g.json();
  check('назва з повідомлення бази витоком не є', gj.retried === false, JSON.stringify(gj).slice(0, 160));

  // 6. Задовга відповідь — повтор, але не підміна.
  anthropicCalls = 0;
  const longText = 'слово '.repeat(130).trim() + '?';
  anthropicReply = [text(longText), text('Коротка підказка про те, де шукати. Що в запиті не збігається з умовою?')];
  await db.exec('delete from mentor_ip_burst');
  g = await post(base({ captcha_token: 'ok', code: studentCode, device_id: 'guard-toolong-01' }));
  gj = await g.json();
  check('задовга відповідь спричинила повтор', gj.retried === true && anthropicCalls === 2, JSON.stringify({ r: gj.retried, c: anthropicCalls }));
  check('після повтору взято коротку відповідь', gj.text.split(/\s+/).length <= 100, String(gj.text.split(/\s+/).length));

  // 7. Обидва виклики оплачено: токени списано двічі.
  const u = await calls('guard-toolong-01');
  check('токени другого виклику теж обліковано', Number(u.input_tokens) === 2600, JSON.stringify(u));
}


// ---------------------------------------------------------------- м'які перевірки запобіжника
console.log('\n[І] Відбиток SYSTEM-промпту (kind: version)');
{
  anthropicCalls = 0;
  const vr = await post({ kind: 'version' });
  const vj: any = await vr.json();
  const { execFileSync } = await import('node:child_process');
  const out = String(execFileSync('node', ['tools/system_sha.mjs'])).trim();
  const want = /system_sha=([0-9a-f]{16}) system_chars=(\d+)/.exec(out)!;
  check('kind:version віддає відбиток промпту', vr.status === 200 && /^[0-9a-f]{16}$/.test(vj.system_sha || ''), JSON.stringify(vj));
  check('відбиток збігається з tools/system_sha.mjs', vj.system_sha === want[1] && vj.system_chars === Number(want[2]), `функція ${vj.system_sha}/${vj.system_chars}, файл ${want[1]}/${want[2]}`);
  check('kind:version не викликає модель', anthropicCalls === 0, 'викликів ' + anthropicCalls);
}

console.log('\n[И] Запобіжник: обсяг, запитання в кінці, жіночий рід');
{
  siteverifyOk = true; siteverifyDown = false;
  await db.exec('delete from mentor_ip_burst');
  const okCode = 'SELECT * FROM orders';

  // Немає запитання в кінці — повтор; якщо модель виправилась, беремо її текст.
  anthropicCalls = 0;
  anthropicReply = [
    text('У твоєму запиті немає групування. Подумай, що саме розбиває рядки на групи.'),
    text('У твоєму запиті немає групування. Що саме розбиває рядки на групи?'),
  ];
  await db.exec('delete from mentor_ip_burst');
  let g = await post(base({ captcha_token: 'ok', code: okCode, device_id: 'soft-noq-00001' }));
  let gj: any = await g.json();
  check('відповідь без запитання спричинила повтор', gj.retried === true && anthropicCalls === 2, JSON.stringify({ r: gj.retried, c: anthropicCalls }));
  check('після повтору відповідь закінчується запитанням', /\?$/.test(gj.text.trim()), gj.text);

  // Жіночий рід у звертанні — повтор.
  anthropicCalls = 0;
  anthropicReply = [
    text('Яку колонку ти б дописала, щоб вийшов підсумок?'),
    text('Яку колонку дописати, щоб вийшов підсумок?'),
  ];
  await db.exec('delete from mentor_ip_burst');
  g = await post(base({ captcha_token: 'ok', code: okCode, device_id: 'soft-fem-00001' }));
  gj = await g.json();
  check('жіночий рід у звертанні спричинив повтор', gj.retried === true, JSON.stringify(gj).slice(0, 140));
  check('після повтору роду немає', !/дописала/.test(gj.text), gj.text);

  // Жіночий рід про перевірку чи базу — НЕ привід для повтору (хибне спрацювання).
  anthropicCalls = 0;
  anthropicReply = text('Перевірка не зарахувала запит, бо база не знайшла колонку. Що в назві не збігається?');
  await db.exec('delete from mentor_ip_burst');
  g = await post(base({ captcha_token: 'ok', code: okCode, device_id: 'soft-nofalse-1' }));
  gj = await g.json();
  check('«перевірка зарахувала» не вважається звертанням', gj.retried === false && anthropicCalls === 1, JSON.stringify({ r: gj.retried, c: anthropicCalls }));

  // Чоловічий рід у звертанні — теж повтор (дірка, знайдена на прогоні 4).
  anthropicCalls = 0;
  anthropicReply = [
    text('Ти написав назву з помилкою. Що в ній не збігається зі схемою?'),
    text('У твоєму запиті назва написана з помилкою. Що в ній не збігається зі схемою?'),
  ];
  await db.exec('delete from mentor_ip_burst');
  g = await post(base({ captcha_token: 'ok', code: okCode, device_id: 'soft-masc-0001' }));
  gj = await g.json();
  check('чоловічий рід у звертанні спричинив повтор', gj.retried === true && anthropicCalls === 2, JSON.stringify({ r: gj.retried, c: anthropicCalls }));
  check('після повтору чоловічого роду немає', !/написав/.test(gj.text), gj.text);

  // «ти бачиш рядків» — родовий відмінок множини, а не дієслово: повтору бути не повинно.
  anthropicCalls = 0;
  anthropicReply = text('Скільки ти бачиш рядків у результаті, і скільком клієнтам вони належать?');
  await db.exec('delete from mentor_ip_burst');
  g = await post(base({ captcha_token: 'ok', code: okCode, device_id: 'soft-nofalse-2' }));
  gj = await g.json();
  check('родовий відмінок на -ів не вважається звертанням', gj.retried === false && anthropicCalls === 1, JSON.stringify({ r: gj.retried, c: anthropicCalls }));

  // Абзаци склеюються без виклику моделі.
  anthropicCalls = 0;
  anthropicReply = text('У твоєму запиті немає групування.\n\nЩо саме розбиває рядки на групи?');
  await db.exec('delete from mentor_ip_burst');
  g = await post(base({ captcha_token: 'ok', code: okCode, device_id: 'soft-para-0001' }));
  gj = await g.json();
  check('порожній рядок склеєно без повтору', gj.retried === false && anthropicCalls === 1 && !/\n/.test(gj.text), JSON.stringify({ r: gj.retried, c: anthropicCalls, t: gj.text }));

  // Вказівка на повтор містить заборону згадувати її учневі (прогін 4: модель відповідала
  // «ти справедливо вказуєш, що в попередній підказці я назвав…» — учень цього не бачив).
  anthropicCalls = 0;
  anthropicReply = [
    text('Яку колонку ти б дописала, щоб вийшов підсумок?'),
    text('Яку колонку дописати, щоб вийшов підсумок?'),
  ];
  await db.exec('delete from mentor_ip_burst');
  g = await post(base({ captcha_token: 'ok', code: okCode, device_id: 'soft-fix-00001' }));
  gj = await g.json();
  const fixMsg = String(lastPayload.messages?.[2]?.content ?? '');
  check('повтор просить підказку з нуля, без згадки вказівки', /Ні цієї вказівки/.test(fixMsg), fixMsg.slice(0, 120));

  // М'яка проблема лишилася і після повтору — підказку НЕ підміняємо.
  anthropicCalls = 0;
  anthropicReply = [
    text('Подумай про групування.'),
    text('Подумай про групування ще раз.'),
  ];
  await db.exec('delete from mentor_ip_burst');
  g = await post(base({ captcha_token: 'ok', code: okCode, device_id: 'soft-keep-00001' }));
  gj = await g.json();
  check('м\'яка проблема не підміняє підказку заглушкою', gj.guarded === false && /групування/.test(gj.text), JSON.stringify(gj).slice(0, 140));
}

console.log(`\nУсього: ${passed} ok, ${failed} FAIL`);
await db.close();
process.exit(failed ? 1 : 0);
