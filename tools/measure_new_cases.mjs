#!/usr/bin/env node
/*
 * Разовий інструмент: прогоняє кандидатів на нові кейси корпусу наставника через
 * СПРАВЖНІЙ checkExercise (app/js/sqlrunner.js) на обох датасетах і друкує те, що
 * учень побачив би насправді: stage, code, message, error.
 *
 * Навіщо: корпус заявляє, що всі lastCheckMessage одержані реальним прогоном.
 * Нові кейси (п.20 аркуша «ДО_ВИПРАВЛЕННЯ_mentor») мусять мати такий самий провенанс,
 * інакше прогін перевіряє мою уяву, а не наставника.
 *
 * Запуск: node tools/measure_new_cases.mjs
 * CoLaba Production
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const root = path.join(import.meta.dirname, '..');
const R = await import(pathToFileURL(path.join(root, 'app/js/sqlrunner.js')).href);
const { PGlite } = await import(pathToFileURL(path.join(root, 'node_modules/@electric-sql/pglite/dist/index.js')).href);

// усі вправи модуля 1 за id
const byId = new Map();
for (const f of fs.readdirSync(path.join(root, 'app/content/m1')).sort()) {
  if (!f.endsWith('.json')) continue;
  const d = JSON.parse(fs.readFileSync(path.join(root, 'app/content/m1', f), 'utf8'));
  for (const e of d.exercises || []) byId.set(e.id, e);
}

const db = new PGlite();
await db.waitReady;
const t0 = Date.now();
await R.loadDataset(db, JSON.parse(fs.readFileSync(path.join(root, 'app/data/koshyk_visible.json'), 'utf8')), R.VISIBLE);
await R.loadDataset(db, JSON.parse(fs.readFileSync(path.join(root, 'app/data/koshyk_hidden.json'), 'utf8')), R.HIDDEN);
console.error(`(обидва набори завантажено за ${Date.now() - t0} мс)`);

const candidates = [
  // --- Parsons: зібрано з блоків, серед них зайвий
  ['P01', 'm1-d3-11', "SELECT full_name, city FROM customers WHERE city IN ('Одеса', 'Харків', 'Дніпро') OR registered_at BETWEEN '2025-01-01' AND '2025-12-31'"],
  ['P02', 'm1-d3-11', "SELECT full_name, city FROM customers WHERE city IN ('Одеса', 'Харків', 'Дніпро') AND registered_at BETWEEN '2025-12-31' AND '2025-01-01'"],
  ['P03', 'm1-d3-11', "FROM customers SELECT full_name, city WHERE city IN ('Одеса', 'Харків', 'Дніпро') AND registered_at BETWEEN '2025-01-01' AND '2025-12-31'"],
  ['P04', 'm1-d4-09', "SELECT product_name, price_uah FROM products WHERE category = 'Кабелі та адаптери' ORDER BY price_uah DESC LIMIT 10"],
  ['P05', 'm1-d1-06', 'SELECT product_name, price_uah FROM orders LIMIT 5'],
  // --- columns_count: не та кількість колонок
  ['C01', 'm1-d10-08', "SELECT delivery_method, COUNT(*) FROM orders WHERE status = 'delivered' AND order_date BETWEEN '2025-01-01' AND '2025-12-31' GROUP BY delivery_method"],
  ['C02', 'm1-d10-08', "SELECT delivery_method, COUNT(*), AVG(total_uah), SUM(total_uah) FROM orders WHERE status = 'delivered' AND order_date BETWEEN '2025-01-01' AND '2025-12-31' GROUP BY delivery_method"],
  // --- X01: спершу логічна помилка (дасть повідомлення перевірки), потім помилка бази
  ['X01-крок1', 'm1-d10-08', "SELECT delivery_method, COUNT(*), AVG(total_uah) FROM orders WHERE order_date BETWEEN '2025-01-01' AND '2025-12-31' GROUP BY delivery_method"],
  ['X01-крок2', 'm1-d10-08', "SELECT delivery_method, COUNT(*), AVG(total_uah) FROM orders WHERE status = 'delivered' AND order_date BETWEEN '2025-01-01' AND '2025-12-31' GROUP BY delivery_metod"],
];

const out = [];
for (const [id, exId, sql] of candidates) {
  const ex = byId.get(exId);
  if (!ex) { console.error(`!! немає вправи ${exId}`); continue; }
  const r = await R.checkExercise(db, ex, sql);
  out.push({ id, exercise_id: exId, code_sql: sql, ok: r.ok, stage: r.stage, check_code: r.code ?? null, message: r.message ?? '', error: r.error ?? '' });
  console.log(`\n### ${id}  (${exId})`);
  console.log(`  ok=${r.ok} stage=${r.stage} code=${r.code ?? '—'}`);
  console.log(`  message: ${r.message ?? '—'}`);
  if (r.error) console.log(`  error:   ${r.error}`);
}
fs.writeFileSync(path.join(root, 'tools/measured_cases.json'), JSON.stringify(out, null, 1));
console.error('\nзаписано tools/measured_cases.json');
await db.close();
