#!/usr/bin/env node
/*
 * Тести перевірки SQL-результатів.
 * Частина 1 — чисті модульні тести app/js/checker.js (без бази).
 * Частина 2 — наскрізні: справжній PostgreSQL (PGlite у Node) на видимому і прихованому датасетах,
 *             той самий код (app/js/sqlrunner.js), що працює у браузері.
 * Запуск: node tools/test_checker.js   (потрібен npm install для частини 2)
 * CoLaba Production
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}

(async () => {
  const root = path.join(__dirname, '..');
  const C = await import(pathToFileURL(path.join(root, 'app/js/checker.js')).href);
  const R = await import(pathToFileURL(path.join(root, 'app/js/sqlrunner.js')).href);
  const F = (n, t = 23) => ({ name: n, dataTypeID: t });

  console.log('\n[1] hasTopLevelOrderBy');
  check('простий ORDER BY', C.hasTopLevelOrderBy('SELECT * FROM t ORDER BY a'));
  check('без ORDER BY', !C.hasTopLevelOrderBy('SELECT * FROM t'));
  check('ORDER BY лише в підзапиті — ні', !C.hasTopLevelOrderBy('SELECT * FROM (SELECT * FROM t ORDER BY a LIMIT 3) s'));
  check('ORDER BY у вікні OVER(...) — ні', !C.hasTopLevelOrderBy('SELECT ROW_NUMBER() OVER (ORDER BY a) FROM t'));
  check('ORDER BY у рядку — ні', !C.hasTopLevelOrderBy("SELECT 'order by' FROM t"));
  check('ORDER BY у коментарі — ні', !C.hasTopLevelOrderBy('SELECT a FROM t -- order by a'));
  check('CTE + зовнішній ORDER BY — так', C.hasTopLevelOrderBy('WITH x AS (SELECT 1 a) SELECT * FROM x ORDER BY a DESC'));
  check('регістр і переноси: order\\n by', C.hasTopLevelOrderBy('select a from t order\n  by a'));

  console.log('\n[2] compareResults — модульні');
  const exp = { fields: [F('a'), F('b', 25)], rows: [[1, 'x'], [2, 'y'], [3, 'z']] };
  check('той самий результат — ok', C.compareResults(exp, exp).ok);
  check('інший порядок рядків без ordered — ok', C.compareResults(exp, { fields: exp.fields, rows: [[3, 'z'], [1, 'x'], [2, 'y']] }).ok);
  check('інший порядок рядків з ordered — order', C.compareResults(exp, { fields: exp.fields, rows: [[3, 'z'], [1, 'x'], [2, 'y']] }, { ordered: true }).code === 'order');
  check('назви колонок ігноруються', C.compareResults(exp, { fields: [F('id'), F('name', 25)], rows: exp.rows }).ok);
  check('checkColumnNames ловить іншу назву', !C.compareResults(exp, { fields: [F('id'), F('name', 25)], rows: exp.rows }, { checkColumnNames: true }).ok);
  check('переставлені колонки — ok', C.compareResults(exp, { fields: [F('b', 25), F('a')], rows: [['x', 1], ['y', 2], ['z', 3]] }).ok);
  check('переставлені колонки заборонені allowColumnReorder:false', !C.compareResults(exp, { fields: [F('b', 25), F('a')], rows: [['x', 1], ['y', 2], ['z', 3]] }, { allowColumnReorder: false }).ok);
  check('зайвий рядок — row_count', C.compareResults(exp, { fields: exp.fields, rows: [...exp.rows, [4, 'w']] }).code === 'row_count');
  check('зайва колонка — columns_count', C.compareResults(exp, { fields: [...exp.fields, F('c')], rows: exp.rows.map((r) => [...r, 0]) }).code === 'columns_count');
  check('інше значення — values', C.compareResults(exp, { fields: exp.fields, rows: [[1, 'x'], [2, 'y'], [3, 'Z']] }).code === 'values');
  const num = { fields: [F('v', 1700)], rows: [['10.004']] };
  check('numeric-рядок vs число в межах 0.01 — ok', C.compareResults(num, { fields: [F('v', 701)], rows: [[10.0]] }).ok);
  check('різниця 0.02 — не ok', !C.compareResults(num, { fields: [F('v', 701)], rows: [[10.03]] }).ok);
  check('bigint vs int — ok', C.compareResults({ fields: [F('c', 20)], rows: [[5]] }, { fields: [F('c', 23)], rows: [[BigInt(5)]] }).ok);
  check('NULL ≠ 0', !C.compareResults({ fields: [F('c')], rows: [[null]] }, { fields: [F('c')], rows: [[0]] }).ok);
  check('NULL = NULL', C.compareResults({ fields: [F('c')], rows: [[null]] }, { fields: [F('c')], rows: [[null]] }).ok);
  check('межа округлення (1.005 vs 1.0149) — ok через запасне зіставлення', C.compareResults({ fields: [F('v', 701)], rows: [[1.005], [2]] }, { fields: [F('v', 701)], rows: [[2], [1.0149]] }).ok);
  check('дублікати рядків враховуються (мультимножина)', !C.compareResults({ fields: [F('a')], rows: [[1], [1], [2]] }, { fields: [F('a')], rows: [[1], [2], [2]] }).ok);
  // нічиї в сортуванні: ключ сортування — колонка 1
  const tie = { fields: [F('name', 25), F('price')], rows: [['A', 100], ['B', 90], ['C', 90], ['D', 50]] };
  const tieAlt = { fields: tie.fields, rows: [['A', 100], ['C', 90], ['B', 90], ['D', 50]] };
  check('нічия без orderKey — строгий порядок падає', !C.compareResults(tie, tieAlt, { ordered: true }).ok);
  check('нічия з orderKey:[1] — ok', C.compareResults(tie, tieAlt, { ordered: true, orderKey: [1] }).ok);
  check('orderKey:[1], але неправильний порядок ключа — order', C.compareResults(tie, { fields: tie.fields, rows: [['D', 50], ['B', 90], ['C', 90], ['A', 100]] }, { ordered: true, orderKey: [1] }).code === 'order');
  // subset
  const full = { fields: [F('a')], rows: [[1], [2], [3], [4], [5]] };
  check('subset: будь-які 2 рядки з множини — ok', C.compareResults(full, { fields: [F('a')], rows: [[5], [3]] }, { mode: 'subset', rowCount: 2 }).ok);
  check('subset: рядок не з множини — fail', !C.compareResults(full, { fields: [F('a')], rows: [[5], [9]] }, { mode: 'subset', rowCount: 2 }).ok);
  check('subset: не та кількість — row_count', C.compareResults(full, { fields: [F('a')], rows: [[5]] }, { mode: 'subset', rowCount: 2 }).code === 'row_count');
  check('Date нормалізується', C.compareResults({ fields: [F('d', 1082)], rows: [[new Date('2025-03-01T00:00:00Z')]] }, { fields: [F('d', 1082)], rows: [[new Date('2025-03-01T00:00:00Z')]] }).ok);
  check('explainPgError: колонка без лапок', /лапки/.test(C.explainPgError('column "львів" does not exist')));

  // ------------------------------------------------------------------ Частина 2: PGlite
  console.log('\n[3] Наскрізні тести на PostgreSQL (PGlite)');
  let PGlite;
  try {
    ({ PGlite } = await import(pathToFileURL(path.join(root, 'node_modules/@electric-sql/pglite/dist/index.js')).href));
  } catch (e) {
    check('PGlite доступний (npm install)', false, e.message);
    return finish();
  }
  const t0 = Date.now();
  const db = new PGlite();
  await db.waitReady;
  const vis = JSON.parse(fs.readFileSync(path.join(root, 'app/data/koshyk_visible.json'), 'utf8'));
  const hid = JSON.parse(fs.readFileSync(path.join(root, 'app/data/koshyk_hidden.json'), 'utf8'));
  await R.loadDataset(db, vis, R.VISIBLE);
  await R.loadDataset(db, hid, R.HIDDEN);
  console.log(`  (ініціалізація + завантаження обох наборів: ${Date.now() - t0} мс)`);

  const cnt = await R.runReadOnly(db, 'SELECT count(*) FROM orders', R.VISIBLE);
  const cntH = await R.runReadOnly(db, 'SELECT count(*) FROM orders', R.HIDDEN);
  check('видимі дані в public', cnt.ok && cnt.rows[0][0] === vis.tables.orders.rows.length, JSON.stringify(cnt));
  check('приховані дані в hidden', cntH.ok && cntH.rows[0][0] === hid.tables.orders.rows.length);

  // безпека
  const del = await R.runReadOnly(db, 'DELETE FROM orders', R.VISIBLE);
  check('DELETE заборонено (read-only)', !del.ok && /read-only/i.test(del.error), del.error);
  const drop = await R.runReadOnly(db, 'DROP TABLE orders', R.VISIBLE);
  check('DROP заборонено', !drop.ok);
  const multi = await R.runReadOnly(db, 'SELECT 1; DELETE FROM orders', R.VISIBLE);
  check('кілька команд відхилено', !multi.ok, multi.error);
  const commit = await R.runReadOnly(db, 'COMMIT', R.VISIBLE);
  const afterCommit = await R.runReadOnly(db, 'DELETE FROM orders', R.VISIBLE);
  check('після COMMIT від учня наступний запит теж read-only', !afterCommit.ok, JSON.stringify(commit));
  const setp = await R.runReadOnly(db, 'SET search_path TO hidden', R.VISIBLE);
  const cnt2 = await R.runReadOnly(db, 'SELECT count(*) FROM orders', R.VISIBLE);
  check('SET search_path учня не протікає в наступний запит', setp.ok && cnt2.rows[0][0] === vis.tables.orders.rows.length);
  const semi = await R.runReadOnly(db, 'SELECT 1 ;  \n', R.VISIBLE);
  check('кінцева «;» дозволена', semi.ok);
  const cnt3 = await R.runReadOnly(db, 'SELECT count(*) FROM orders', R.VISIBLE);
  check('дані не змінилися після всіх спроб', cnt3.rows[0][0] === vis.tables.orders.rows.length);
  const err = await R.runReadOnly(db, "SELECT * FROM customers WHERE city = Львів", R.VISIBLE);
  check('помилка «без лапок» повертає текст для пояснення', !err.ok && /does not exist/.test(err.error), err.error);
  const il = await R.runReadOnly(db, "SELECT count(*) FROM products WHERE product_name ILIKE '%павербанк%'", R.VISIBLE);
  check('ILIKE з кирилицею працює (C.UTF-8)', il.ok && il.rows[0][0] > 0, JSON.stringify(il.rows));
  const dt = await R.runReadOnly(db, "SELECT DATE_TRUNC('month', order_date) m, SUM(total_uah)::numeric / COUNT(*) FROM orders GROUP BY 1 ORDER BY 1 LIMIT 3", R.VISIBLE);
  check('DATE_TRUNC, ::numeric працюють', dt.ok, dt.error);

  // наскрізна перевірка вправ
  const ex = (reference, check) => ({ reference, check });
  async function verdict(e, sql) { return R.checkExercise(db, e, sql); }

  const e1 = ex("SELECT * FROM customers WHERE city = 'Львів'");
  check('еквівалент: інший регістр і форматування', (await verdict(e1, "select *\nfrom CUSTOMERS\nwhere city='Львів';")).ok);
  check('еквівалент: колонки явно, в іншому порядку', (await verdict(e1, "SELECT acquisition_channel, registered_at, city, full_name, customer_id FROM customers WHERE city = 'Львів'")).ok);
  check('еквівалент: IN замість =', (await verdict(e1, "SELECT * FROM customers WHERE city IN ('Львів')")).ok);
  check('неправильне місто падає', !(await verdict(e1, "SELECT * FROM customers WHERE city = 'Київ'")).ok);
  check('регістр значення важливий: \'львів\' падає', !(await verdict(e1, "SELECT * FROM customers WHERE city = 'львів'")).ok);

  const e2 = ex("SELECT order_id, order_date, total_uah FROM orders WHERE total_uah > 5000 AND status = 'delivered'");
  check('еквівалент: умови в іншому порядку + дужки', (await verdict(e2, "SELECT order_id, order_date, total_uah FROM orders WHERE (status = 'delivered') AND (total_uah > 5000)")).ok);
  check('>= замість > — падає (межа 5000)', (() => true)() && !(await verdict(e2, "SELECT order_id, order_date, total_uah FROM orders WHERE total_uah >= 4000 AND status = 'delivered'")).ok);
  check('без умови статусу падає', !(await verdict(e2, "SELECT order_id, order_date, total_uah FROM orders WHERE total_uah > 5000")).ok);

  // підгонка під видимі дані: «жорстко вписаний» результат
  const e3 = ex("SELECT COUNT(*) FROM orders WHERE status = 'cancelled'");
  const visCancelled = (await R.runReadOnly(db, "SELECT COUNT(*) FROM orders WHERE status = 'cancelled'", R.VISIBLE)).rows[0][0];
  const hard = await verdict(e3, `SELECT ${visCancelled}`);
  check('жорстко вписане число проходить видимі, але падає на прихованих', !hard.ok && hard.stage === 'hidden', JSON.stringify(hard));
  const idHack = await verdict(e1, `SELECT * FROM customers WHERE customer_id IN (${(await R.runReadOnly(db, "SELECT customer_id FROM customers WHERE city='Львів'", R.VISIBLE)).rows.map((r) => r[0]).join(',')})`);
  check('перелік id з видимих даних падає на прихованих', !idHack.ok && idHack.stage === 'hidden', JSON.stringify(idHack).slice(0, 200));
  check('COUNT(*) vs COUNT(delivery_date) — різні результати (пастка дня 7)', !(await verdict(ex('SELECT COUNT(*) FROM orders'), 'SELECT COUNT(delivery_date) FROM orders')).ok);

  // ORDER BY
  const e4 = ex('SELECT product_name, price_uah FROM products ORDER BY price_uah DESC, product_id LIMIT 10');
  check('ORDER BY: правильне сортування проходить', (await verdict(e4, 'SELECT product_name, price_uah FROM products ORDER BY price_uah DESC, product_id LIMIT 10')).ok);
  const asc = await verdict(e4, 'SELECT product_name, price_uah FROM products ORDER BY price_uah ASC, product_id LIMIT 10');
  check('ORDER BY: ASC замість DESC падає', !asc.ok, asc.message);
  const e5 = ex("SELECT city, COUNT(*) AS n FROM customers GROUP BY city ORDER BY n DESC, city");
  const wrongOrder = await verdict(e5, 'SELECT city, COUNT(*) AS n FROM customers GROUP BY city ORDER BY city');
  check('ORDER BY: ті самі рядки в іншому порядку → code=order', !wrongOrder.ok && wrongOrder.code === 'order', JSON.stringify(wrongOrder));
  check('без ORDER BY в еталоні порядок учня не важливий', (await verdict(ex('SELECT city, COUNT(*) FROM customers GROUP BY city'), 'SELECT city, COUNT(*) FROM customers GROUP BY city ORDER BY 2 DESC')).ok);

  // числа і агрегати
  const e6 = ex("SELECT ROUND(AVG(total_uah), 2) FROM orders WHERE status = 'delivered'");
  check('AVG без ROUND проходить з допуском', (await verdict(e6, "SELECT AVG(total_uah) FROM orders WHERE status = 'delivered'")).ok);
  check('SUM/COUNT замість AVG проходить', (await verdict(e6, "SELECT SUM(total_uah)/COUNT(*) FROM orders WHERE status = 'delivered'")).ok);
  const e7 = ex('SELECT product_name, (price_uah - cost_uah)::numeric / price_uah AS m FROM products');
  check('цілочисельне ділення (пастка дня 5) падає', !(await verdict(e7, 'SELECT product_name, (price_uah - cost_uah) / price_uah FROM products')).ok);

  // subset
  const e8 = ex('SELECT order_id, order_date, total_uah FROM orders LIMIT 20', { mode: 'subset', rowCount: 20, referenceFull: 'SELECT order_id, order_date, total_uah FROM orders' });
  check('subset: LIMIT 20 проходить', (await verdict(e8, 'SELECT order_id, order_date, total_uah FROM orders LIMIT 20')).ok);
  check('subset: з ORDER BY order_id DESC теж проходить', (await verdict(e8, 'SELECT order_id, order_date, total_uah FROM orders ORDER BY order_id DESC LIMIT 20')).ok);
  check('subset: LIMIT 10 падає', !(await verdict(e8, 'SELECT order_id, order_date, total_uah FROM orders LIMIT 10')).ok);
  check('subset: пропущена кома (order_id total_uah) падає', !(await verdict(e8, 'SELECT order_id order_date, total_uah FROM orders LIMIT 20')).ok);

  await db.close();
  finish();
})().catch((e) => { console.error(e); process.exit(2); });

function finish() {
  console.log(`\nРезультат: ${passed} пройдено, ${failed} провалено`);
  process.exit(failed ? 1 : 0);
}
