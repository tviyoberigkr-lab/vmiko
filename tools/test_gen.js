#!/usr/bin/env node
/*
 * Тести генератора D1 «Кошик». Без залежностей: node tools/test_gen.js
 * Перевіряє обидва профілі (visible, hidden): обсяги, детермінованість, закладені інсайти, контракт схеми з документацією.
 * CoLaba Production
 */
'use strict';
const fs = require('fs');
const path = require('path');
const gen = require('./gen_koshyk.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name + (detail ? '  (' + detail + ')' : '')); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); }
}
const fmt = (x) => (typeof x === 'number' ? (Math.round(x * 1000) / 1000).toString() : String(x));

function analyse(profile) {
  const ds = gen.generate(profile);
  const T = ds.tables;
  const scale = gen.PROFILES[profile].scale;
  console.log(`\n[${profile}] seed=${gen.PROFILES[profile].seed} scale=${scale}`);

  // 1. Обсяги
  check('customers = 20000 × scale', T.customers.length === Math.round(20000 * scale), T.customers.length);
  check('orders у межах 55–85 тис. × scale', T.orders.length >= 55000 * scale && T.orders.length <= 85000 * scale, T.orders.length);
  check('order_items ≤ 100 000 (ліміт мобільного браузера зі спеки)', T.order_items.length <= 100000, T.order_items.length);
  check('products 200–400', T.products.length >= 200 && T.products.length <= 400, T.products.length);
  check('promo_codes = 10', T.promo_codes.length === 10);
  check('returns > 0', T.returns.length > 0, T.returns.length);
  check('рівно 6 таблиць', Object.keys(T).length === 6);

  // 2. Цілісність ключів
  const custIds = new Set(T.customers.map((c) => c.customer_id));
  const prodIds = new Set(T.products.map((p) => p.product_id));
  const orderById = new Map(T.orders.map((o) => [o.order_id, o]));
  check('order_id унікальні', orderById.size === T.orders.length);
  check('усі orders.customer_id існують', T.orders.every((o) => custIds.has(o.customer_id)));
  check('усі order_items.order_id існують', T.order_items.every((i) => orderById.has(i.order_id)));
  check('усі order_items.product_id існують', T.order_items.every((i) => prodIds.has(i.product_id)));
  check('кожне замовлення має ≥1 позицію', (() => { const s = new Set(T.order_items.map((i) => i.order_id)); return T.orders.every((o) => s.has(o.order_id)); })());
  check('дати замовлень 2024-01-01…2026-09-30', T.orders.every((o) => o.order_date >= '2024-01-01' && o.order_date <= '2026-09-30'));
  check('order_date = дата з created_at', T.orders.every((o) => o.created_at.slice(0, 10) === o.order_date));
  check('price_uah і cost_uah — цілі (для пастки цілочисельного ділення, М1 день 5)', T.products.every((p) => Number.isInteger(p.price_uah) && Number.isInteger(p.cost_uah)));
  check('собівартість < ціни', T.products.every((p) => p.cost_uah < p.price_uah));
  // total = сума позицій − знижка
  const itemsByOrder = new Map();
  for (const it of T.order_items) { const a = itemsByOrder.get(it.order_id) || []; a.push(it); itemsByOrder.set(it.order_id, a); }
  check('total_uah = Σ(quantity×unit_price) − discount_uah', T.orders.every((o) => {
    const sub = itemsByOrder.get(o.order_id).reduce((s, i) => s + i.quantity * i.unit_price_uah, 0);
    return Math.abs(sub - o.discount_uah - o.total_uah) < 0.011;
  }));

  // 3. NULL у delivery_date
  const cancelled = T.orders.filter((o) => o.status === 'cancelled');
  check('скасовані мають delivery_date = NULL', cancelled.length > 0 && cancelled.every((o) => o.delivery_date === null), cancelled.length + ' скасованих');
  check('delivered/returned мають delivery_date', T.orders.filter((o) => o.status === 'delivered' || o.status === 'returned').every((o) => o.delivery_date !== null && o.delivery_date >= o.order_date));
  const nullShare = T.orders.filter((o) => o.delivery_date === null).length / T.orders.length;
  check('частка NULL у delivery_date 5–12% (пастка COUNT(*) vs COUNT(col))', nullShare > 0.05 && nullShare < 0.12, fmt(nullShare));
  check('кожне повернення посилається на замовлення зі статусом returned', T.returns.every((r) => orderById.get(r.order_id).status === 'returned'));

  // 4. Провал виручки в березні 2025
  const revByMonth = {};
  for (const o of T.orders) { const m = o.order_date.slice(0, 7); revByMonth[m] = (revByMonth[m] || 0) + o.total_uah; }
  const mar = revByMonth['2025-03'];
  const neigh = (revByMonth['2025-02'] + revByMonth['2025-04']) / 2;
  check('виручка 03.2025 < 75% від середнього лютий/квітень', mar < 0.75 * neigh, 'ratio=' + fmt(mar / neigh));
  const mar24 = revByMonth['2024-03'] / ((revByMonth['2024-02'] + revByMonth['2024-04']) / 2);
  const mar26 = revByMonth['2026-03'] / ((revByMonth['2026-02'] + revByMonth['2026-04']) / 2);
  check('березень 2024 і 2026 без провалу (>0.85) — провал саме 2025', mar24 > 0.85 && mar26 > 0.85, `2024=${fmt(mar24)} 2026=${fmt(mar26)}`);
  // 2025 — найнижчий місяць року
  const months2025 = Object.keys(revByMonth).filter((m) => m.startsWith('2025-'));
  const minMonth = months2025.reduce((a, b) => (revByMonth[a] < revByMonth[b] ? a : b));
  check('березень — мінімум виручки 2025 року (DATE_TRUNC це покаже)', minMonth === '2025-03', minMonth);
  // причина: промокод VESNA25 майже не спрацьовував у березні
  const vesna = T.promo_codes.find((p) => p.code === 'VESNA25').promo_code_id;
  const vMar = T.orders.filter((o) => o.promo_code_id === vesna && o.order_date.startsWith('2025-03')).length;
  const vApr = T.orders.filter((o) => o.promo_code_id === vesna && o.order_date.startsWith('2025-04')).length;
  check('VESNA25: у березні 2025 застосувань ≪ ніж у квітні (збій промокоду)', vMar * 3 < vApr, `березень=${vMar} квітень=${vApr}`);

  // 5. Дублікати: той самий клієнт + сума + хвилина
  const groups = new Map();
  for (const o of T.orders) {
    const k = o.customer_id + '|' + o.total_uah + '|' + o.created_at.slice(0, 16);
    groups.set(k, (groups.get(k) || 0) + 1);
  }
  let extra = 0;
  for (const n of groups.values()) if (n > 1) extra += n - 1;
  const dupShare = extra / T.orders.length;
  check('частка дублікатів 2.5–3.5%', dupShare >= 0.025 && dupShare <= 0.035, fmt(dupShare * 100) + '%');

  // 6. Telegram: вищий середній чек, гірші повторні покупки
  const chOf = new Map(T.customers.map((c) => [c.customer_id, c.acquisition_channel]));
  const stats = {};
  const perCust = new Map();
  for (const o of T.orders) {
    if (o.status === 'cancelled') continue;
    const ch = chOf.get(o.customer_id);
    const s = stats[ch] || (stats[ch] = { sum: 0, n: 0 });
    s.sum += o.total_uah; s.n++;
    perCust.set(o.customer_id, (perCust.get(o.customer_id) || 0) + 1);
  }
  const repeat = {};
  for (const [cid, n] of perCust) {
    const ch = chOf.get(cid);
    const r = repeat[ch] || (repeat[ch] = { buyers: 0, rep: 0 });
    r.buyers++; if (n >= 2) r.rep++;
  }
  const aov = Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, v.sum / v.n]));
  const rr = Object.fromEntries(Object.entries(repeat).map(([k, v]) => [k, v.rep / v.buyers]));
  const others = Object.keys(aov).filter((k) => k !== 'telegram');
  const minOtherAov = Math.min(...others.map((k) => aov[k]));
  const maxOtherRr = Math.max(...others.map((k) => rr[k]));
  check('Telegram: середній чек вищий за кожен інший канал на ≥20%', aov.telegram > 1.2 * minOtherAov && others.every((k) => aov.telegram > aov[k] * 1.2), 'telegram=' + Math.round(aov.telegram) + ' max інших=' + Math.round(Math.max(...others.map((k) => aov[k]))));
  check('Telegram: частка повторних покупців нижча за кожен інший канал', rr.telegram < maxOtherRr && others.every((k) => rr.telegram < rr[k] - 0.1), 'telegram=' + fmt(rr.telegram) + ' min інших=' + fmt(Math.min(...others.map((k) => rr[k]))));

  // 7. Павербанки: пік у листопаді 2025
  const pbIds = new Set(T.products.filter((p) => p.category === 'Павербанки').map((p) => p.product_id));
  const pbByMonth = {};
  for (const it of T.order_items) {
    if (!pbIds.has(it.product_id)) continue;
    const m = orderById.get(it.order_id).order_date.slice(0, 7);
    pbByMonth[m] = (pbByMonth[m] || 0) + it.quantity;
  }
  const nov = pbByMonth['2025-11'] || 0;
  const rest2025 = Object.entries(pbByMonth).filter(([m]) => m.startsWith('2025-') && m !== '2025-11').map(([, v]) => v);
  const avgRest = rest2025.reduce((a, b) => a + b, 0) / rest2025.length;
  check('павербанки: продажі в 11.2025 ≥ 3× середнього місяця 2025', nov >= 3 * avgRest, `листопад=${nov} середнє=${Math.round(avgRest)}`);
  check('є товари з «павербанк» у назві (для ILIKE)', T.products.some((p) => /павербанк/i.test(p.product_name)));

  // 8. «Сироти»
  const buyers = new Set(T.orders.map((o) => o.customer_id));
  const orphanShare = 1 - buyers.size / T.customers.length;
  check('клієнти без замовлень 10–25%', orphanShare > 0.1 && orphanShare < 0.25, fmt(orphanShare));
  const sold = new Set(T.order_items.map((i) => i.product_id));
  const unsold = T.products.filter((p) => !sold.has(p.product_id)).length;
  check('товари без продажів ≥ 5', unsold >= 5, unsold);

  // 9. Міста (HAVING > 500 клієнтів на видимому)
  const byCity = {};
  for (const c of T.customers) byCity[c.city] = (byCity[c.city] || 0) + 1;
  const big = Object.values(byCity).filter((n) => n > 500 * scale).length;
  check('міст з >500×scale клієнтів: 4–10 (є і великі, і малі)', big >= 4 && big <= 10, big);
  check('Львів присутній', byCity['Львів'] > 0);

  // 10. Статуси
  const st = new Set(T.orders.map((o) => o.status));
  check('статуси = {delivered, cancelled, returned, in_transit}', ['delivered', 'cancelled', 'returned', 'in_transit'].every((s) => st.has(s)) && st.size === 4, [...st].join(','));
  check('є замовлення > 5000 грн зі статусом delivered', T.orders.some((o) => o.total_uah > 5000 && o.status === 'delivered'));
  check('є замовлення за грудень 2025', T.orders.some((o) => o.order_date.startsWith('2025-12')));
  return ds;
}

const vis = analyse('visible');
const hid = analyse('hidden');

console.log('\n[загальне]');
const again = gen.generate('visible');
check('детермінованість: повторна генерація visible ідентична', gen.toJson(again) === gen.toJson(vis));
check('видимий і прихований відрізняються значеннями', gen.toJson(vis) !== gen.toJson(hid));
check('однакова схема (колонки) у visible і hidden', JSON.stringify(Object.keys(vis.tables.orders[0])) === JSON.stringify(Object.keys(hid.tables.orders[0])));
const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'schema_koshyk.md'), 'utf8');
const missing = [];
for (const t of gen.SCHEMA) {
  if (!doc.includes('`' + t.name + '`')) missing.push(t.name);
  for (const [c] of t.columns) if (!doc.includes('`' + c + '`')) missing.push(t.name + '.' + c);
}
check('контракт: кожна таблиця і колонка є в docs/schema_koshyk.md', missing.length === 0, missing.join(', ') || 'усі');
check('docs/schema_koshyk.md містить актуальну версію датасету', doc.includes(gen.DATASET_VERSION), gen.DATASET_VERSION);
// app/data має відповідати генератору
const appData = path.join(__dirname, '..', 'app', 'data', 'koshyk_visible.json');
if (fs.existsSync(appData)) {
  check('app/data/koshyk_visible.json збігається з генератором (не застарів)', fs.readFileSync(appData, 'utf8') === gen.toJson(vis));
} else {
  check('app/data/koshyk_visible.json існує', false, 'запустіть npm run build');
}

console.log(`\nРезультат: ${passed} пройдено, ${failed} провалено`);
process.exit(failed ? 1 : 0);
