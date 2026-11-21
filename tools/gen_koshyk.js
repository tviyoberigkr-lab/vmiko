#!/usr/bin/env node
/*
 * Генератор датасету D1 «Кошик» для Vmiko.
 * Детермінований: той самий seed + та сама версія = байт-у-байт той самий результат.
 * Без зовнішніх залежностей (лише Node.js).
 *
 * Запуск:   node tools/gen_koshyk.js            -> data/koshyk_visible.{sql,json}, data/koshyk_hidden.{sql,json}
 *           node tools/gen_koshyk.js --check    -> лише друкує підсумок, нічого не пише
 *
 * Схема (контракт) описана в docs/schema_koshyk.md і в константі SCHEMA нижче.
 * Якщо міняєте схему — міняйте обидва місця і підніміть DATASET_VERSION.
 *
 * CoLaba Production
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DATASET_VERSION = 'koshyk-1.0.0';

// Видимий набір — для учня, прихований — для перевірки (інший seed, менший масштаб, ті самі закономірності).
const PROFILES = {
  visible: { seed: 20251101, scale: 1.0 },
  hidden: { seed: 777013, scale: 0.3 },
};

// Межі даних
const DATE_FROM = '2024-01-01';
const DATE_TO = '2026-09-30'; // остання дата замовлення (включно)
const REG_FROM = '2023-09-01';

// ---------------------------------------------------------------- схема (контракт)
const SCHEMA = [
  {
    name: 'customers',
    columns: [
      ['customer_id', 'integer PRIMARY KEY'],
      ['full_name', 'text NOT NULL'],
      ['city', 'text NOT NULL'],
      ['registered_at', 'date NOT NULL'],
      ['acquisition_channel', 'text NOT NULL'],
    ],
  },
  {
    name: 'products',
    columns: [
      ['product_id', 'integer PRIMARY KEY'],
      ['product_name', 'text NOT NULL'],
      ['category', 'text NOT NULL'],
      ['brand', 'text NOT NULL'],
      ['price_uah', 'integer NOT NULL'],
      ['cost_uah', 'integer NOT NULL'],
    ],
  },
  {
    name: 'promo_codes',
    columns: [
      ['promo_code_id', 'integer PRIMARY KEY'],
      ['code', 'text NOT NULL'],
      ['discount_pct', 'integer NOT NULL'],
      ['valid_from', 'date NOT NULL'],
      ['valid_to', 'date NOT NULL'],
    ],
  },
  {
    name: 'orders',
    columns: [
      ['order_id', 'integer PRIMARY KEY'],
      ['customer_id', 'integer NOT NULL REFERENCES customers(customer_id)'],
      ['order_date', 'date NOT NULL'],
      ['created_at', 'timestamp NOT NULL'],
      ['status', 'text NOT NULL'],
      ['delivery_method', 'text NOT NULL'],
      ['delivery_date', 'date'],
      ['promo_code_id', 'integer REFERENCES promo_codes(promo_code_id)'],
      ['discount_uah', 'numeric(12,2) NOT NULL'],
      ['total_uah', 'numeric(12,2) NOT NULL'],
    ],
  },
  {
    name: 'order_items',
    columns: [
      ['order_item_id', 'integer PRIMARY KEY'],
      ['order_id', 'integer NOT NULL REFERENCES orders(order_id)'],
      ['product_id', 'integer NOT NULL REFERENCES products(product_id)'],
      ['quantity', 'integer NOT NULL'],
      ['unit_price_uah', 'integer NOT NULL'],
    ],
  },
  {
    name: 'returns',
    columns: [
      ['return_id', 'integer PRIMARY KEY'],
      ['order_id', 'integer NOT NULL REFERENCES orders(order_id)'],
      ['return_date', 'date NOT NULL'],
      ['reason', 'text NOT NULL'],
      ['refund_uah', 'numeric(12,2) NOT NULL'],
    ],
  },
];

// ---------------------------------------------------------------- PRNG
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function makeRng(seed) {
  const r = mulberry32(seed);
  const rng = {
    next: r,
    int: (lo, hi) => lo + Math.floor(r() * (hi - lo + 1)), // включно
    pick: (arr) => arr[Math.floor(r() * arr.length)],
    chance: (p) => r() < p,
    weighted(items, weightOf) {
      let total = 0;
      for (const it of items) total += weightOf(it);
      let x = r() * total;
      for (const it of items) {
        x -= weightOf(it);
        if (x < 0) return it;
      }
      return items[items.length - 1];
    },
    geometric(p) { // кількість "невдач" до першого успіху
      let k = 0;
      while (r() >= p && k < 60) k++;
      return k;
    },
    exp(mean) { return -Math.log(1 - r()) * mean; },
  };
  return rng;
}

// ---------------------------------------------------------------- дати
const DAY = 86400000;
const toMs = (iso) => Date.parse(iso + 'T00:00:00Z');
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const isoTs = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const ym = (ms) => isoDate(ms).slice(0, 7);

// ---------------------------------------------------------------- довідники
const CITIES = [
  ['Київ', 26], ['Харків', 9], ['Одеса', 8], ['Дніпро', 8], ['Львів', 9],
  ['Запоріжжя', 4], ['Вінниця', 4], ['Полтава', 3], ['Івано-Франківськ', 3], ['Тернопіль', 2.5],
  ['Чернівці', 2], ['Житомир', 2], ['Рівне', 2.2], ['Луцьк', 2], ['Ужгород', 1.4],
  ['Хмельницький', 2.1], ['Черкаси', 2], ['Суми', 1.6], ['Чернігів', 1.6], ['Кропивницький', 1.3],
  ['Миколаїв', 2], ['Біла Церква', 1.2], ['Кременчук', 1], ['Ірпінь', 1.1],
];

// Канали залучення. orders: середня кількість повторних замовлень; spend: схильність до дорожчих товарів.
const CHANNELS = [
  { code: 'organic', w: 30, repeatP: 0.085, spend: 1.0 },
  { code: 'google_ads', w: 22, repeatP: 0.095, spend: 1.0 },
  { code: 'instagram', w: 16, repeatP: 0.11, spend: 0.9 },
  { code: 'telegram', w: 18, repeatP: 0.55, spend: 2.3 }, // вищий чек, гірші повторні покупки
  { code: 'referral', w: 8, repeatP: 0.075, spend: 1.1 },
  { code: 'email', w: 6, repeatP: 0.08, spend: 1.0 },
];

const FIRST_NAMES = ['Олена', 'Андрій', 'Ірина', 'Олександр', 'Марія', 'Дмитро', 'Наталія', 'Сергій', 'Оксана', 'Віктор',
  'Юлія', 'Тарас', 'Катерина', 'Богдан', 'Світлана', 'Максим', 'Галина', 'Ігор', 'Тетяна', 'Роман',
  'Анна', 'Володимир', 'Людмила', 'Михайло', 'Христина', 'Назар', 'Вікторія', 'Остап', 'Софія', 'Євген',
  'Ганна', 'Петро', 'Дарина', 'Василь', 'Іванна', 'Артем', 'Леся', 'Степан', 'Уляна', 'Ярослав'];
const LAST_NAMES = ['Шевченко', 'Коваленко', 'Бондаренко', 'Ткаченко', 'Кравченко', 'Олійник', 'Мельник', 'Шевчук', 'Поліщук', 'Бойко',
  'Ковальчук', 'Лисенко', 'Марченко', 'Савченко', 'Руденко', 'Мороз', 'Павленко', 'Петренко', 'Гончаренко', 'Кузьменко',
  'Левченко', 'Харченко', 'Захарченко', 'Ковальов', 'Костенко', 'Гнатюк', 'Яковенко', 'Сидоренко', 'Іваненко', 'Литвиненко'];

// категорія: [назва-основа, мін ціна, макс ціна, вага в замовленнях, бренди]
const CATEGORIES = [
  ['Павербанки', 'Павербанк', 450, 3200, 5, ['Xiaomi', 'Baseus', 'Anker', '2E', 'Gelius']],
  ['Навушники', 'Навушники', 300, 6500, 8, ['JBL', 'Xiaomi', 'Samsung', 'Baseus', '2E']],
  ['Електрочайники', 'Електрочайник', 550, 3500, 7, ['Tefal', 'Philips', 'Bosch', 'Ardesto', 'Xiaomi']],
  ['Пилососи', 'Пилосос', 2200, 16000, 4, ['Xiaomi', 'Philips', 'Bosch', 'Rowenta', 'Samsung']],
  ['Блендери', 'Блендер', 700, 4500, 4, ['Philips', 'Bosch', 'Tefal', 'Ardesto', 'Gorenje']],
  ['Кавоварки', 'Кавоварка', 1800, 21000, 3, ['Philips', 'Bosch', 'Ardesto', 'Gorenje']],
  ['Смарт-годинники', 'Смарт-годинник', 900, 12000, 4, ['Xiaomi', 'Samsung', '2E', 'Gelius']],
  ['Зарядні пристрої', 'Зарядний пристрій', 200, 1500, 9, ['Baseus', 'Anker', 'Gelius', '2E', 'Xiaomi']],
  ['Кабелі та адаптери', 'Кабель', 90, 700, 10, ['Baseus', 'Gelius', '2E', 'Vinga']],
  ['Освітлення', 'LED-лампа', 120, 2500, 6, ['Xiaomi', 'Philips', 'Vinga', 'Ardesto']],
  ['Праски', 'Праска', 800, 5500, 3, ['Philips', 'Tefal', 'Rowenta', 'Bosch']],
  ['Мікрохвильовки', 'Мікрохвильова піч', 2500, 9000, 2, ['Samsung', 'Gorenje', 'Ardesto', 'Bosch']],
  ['Фени', 'Фен', 500, 7500, 4, ['Philips', 'Rowenta', 'Xiaomi', 'Bosch']],
  ['Ваги', 'Ваги', 250, 1800, 3, ['Xiaomi', 'Tefal', 'Ardesto', 'Vinga']],
  ['Кухонне приладдя', 'Набір ножів', 300, 3000, 4, ['Tefal', 'Ardesto', 'Gorenje', 'Vinga']],
];
const MODEL_SUFFIX = ['Mini', 'Pro', 'Max', 'Lite', 'Plus', 'S', 'X', 'Air', 'Neo', 'Go', 'One', 'Ultra'];

// Промокоди. VESNA25 — у березні 2025 «зламався» (закладений інсайт: провал виручки).
const PROMOS = [
  ['NEWYEAR24', 10, '2024-01-01', '2024-01-31'],
  ['VESNA24', 15, '2024-03-01', '2024-04-15'],
  ['SUMMER24', 10, '2024-06-01', '2024-08-31'],
  ['BLACK24', 20, '2024-11-20', '2024-12-02'],
  ['VESNA25', 15, '2025-03-01', '2025-04-15'], // зламаний з 1 по 31 березня 2025
  ['SUMMER25', 10, '2025-06-01', '2025-08-31'],
  ['BLACK25', 20, '2025-11-20', '2025-12-02'],
  ['VESNA26', 15, '2026-03-01', '2026-04-15'],
  ['SUMMER26', 10, '2026-06-01', '2026-08-31'],
  ['WELCOME', 5, '2024-01-01', '2026-12-31'], // для перших покупок
];
const PROMO_BROKEN = { code: 'VESNA25', from: '2025-03-01', to: '2025-03-31' };

const DELIVERY = [
  { name: 'Нова пошта', w: 68, dmin: 1, dmax: 3 },
  { name: 'Укрпошта', w: 20, dmin: 3, dmax: 8 },
  { name: 'Самовивіз', w: 12, dmin: 0, dmax: 2 },
];
const RETURN_REASONS = ['Не підійшов', 'Брак / несправність', 'Не відповідає опису', 'Передумав', 'Пошкоджено при доставці'];

// Сезонність виручки (множник частоти замовлень за місяцем року)
const MONTH_FACTOR = [0.85, 0.85, 0.95, 0.95, 0.95, 0.9, 0.9, 0.95, 1.0, 1.05, 1.45, 1.35];
function monthFactor(ms) {
  const m = new Date(ms).getUTCMonth();
  let f = MONTH_FACTOR[m];
  return f;
}

// ---------------------------------------------------------------- генерація
function generate(profileName) {
  const prof = PROFILES[profileName];
  const rng = makeRng(prof.seed);
  const N_CUSTOMERS = Math.round(20000 * prof.scale);

  // products
  const products = [];
  let pid = 1;
  for (const [cat, base, pmin, pmax, , brands] of CATEGORIES) {
    const n = 16 + rng.int(0, 6);
    for (let i = 0; i < n; i++) {
      const brand = rng.pick(brands);
      const price = Math.round((pmin + Math.pow(rng.next(), 1.6) * (pmax - pmin)) / 10) * 10 - 1; // 1299-подібні ціни
      let costRatio = 0.55 + rng.next() * 0.3;
      if (cat === 'Кабелі та адаптери' || cat === 'Зарядні пристрої') costRatio = 0.35 + rng.next() * 0.2; // висока маржа
      if (cat === 'Мікрохвильовки' || cat === 'Пилососи') costRatio = 0.72 + rng.next() * 0.15; // низька маржа
      const suffix = rng.pick(MODEL_SUFFIX);
      let capacity = '';
      if (cat === 'Павербанки') capacity = ' ' + rng.pick([5000, 10000, 20000, 30000]) + ' мАг';
      products.push({
        product_id: pid++,
        product_name: `${base} ${brand} ${suffix}${capacity} ${rng.int(10, 99)}`,
        category: cat,
        brand,
        price_uah: Math.max(price, 49),
        cost_uah: Math.max(Math.round(price * costRatio), 20),
        _cat: cat,
        _w: 1, // вага популярності всередині категорії
      });
    }
  }
  // кілька товарів ніколи не продавалися (для М2: «товари без продажів»)
  for (let i = 0; i < 9; i++) rng.pick(products)._w = 0;
  for (const p of products) if (p._w !== 0) p._w = 0.3 + rng.next();
  const catWeight = Object.fromEntries(CATEGORIES.map((c) => [c[0], c[3]]));
  const byCat = {};
  for (const p of products) (byCat[p._cat] = byCat[p._cat] || []).push(p);

  // promo codes
  const promos = PROMOS.map(([code, pct, f, t], i) => ({
    promo_code_id: i + 1, code, discount_pct: pct, valid_from: f, valid_to: t,
  }));

  // customers
  const customers = [];
  const regFrom = toMs(REG_FROM);
  const lastMs = toMs(DATE_TO);
  for (let i = 1; i <= N_CUSTOMERS; i++) {
    // реєстрації ростуть з часом: u^0.8 зсуває до пізніших дат
    const reg = regFrom + Math.floor(Math.pow(rng.next(), 1.15) * (lastMs - regFrom - 20 * DAY));
    const ch = rng.weighted(CHANNELS, (c) => c.w);
    customers.push({
      customer_id: i,
      full_name: `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`,
      city: rng.weighted(CITIES, (c) => c[1])[0],
      registered_at: isoDate(reg),
      acquisition_channel: ch.code,
      _ch: ch,
      _reg: reg,
    });
  }

  // orders (спершу як «події», потім пронумеруємо за часом)
  const raw = [];
  const fromMs = toMs(DATE_FROM);
  const promoActive = (ms) => promos.filter((p) => ms >= toMs(p.valid_from) && ms <= toMs(p.valid_to) && p.code !== 'WELCOME');
  const welcome = promos.find((p) => p.code === 'WELCOME');
  const brokenFrom = toMs(PROMO_BROKEN.from);
  const brokenTo = toMs(PROMO_BROKEN.to);
  const pbFrom = toMs('2025-11-01');
  const pbTo = toMs('2025-11-30');

  for (const c of customers) {
    if (rng.chance(0.12)) continue; // ніколи не купував — «сироти» для LEFT JOIN
    const nOrders = 1 + rng.geometric(c._ch.repeatP);
    let t = c._reg + rng.exp(20) * DAY;
    let first = true;
    for (let k = 0; k < nOrders; k++) {
      if (k > 0) t += (5 + rng.exp(47)) * DAY;
      if (t > lastMs + DAY - 1) break;
      if (t < fromMs) { first = false; continue; } // замовлення до 2024 не вивантажені
      // сезонність: проріджування
      if (!rng.chance(monthFactor(t) / 1.45)) { first = false; continue; }
      const day = Math.floor(t / DAY) * DAY;
      const inBroken = day >= brokenFrom && day <= brokenTo;
      // промокод
      let promo = null;
      const active = promoActive(day);
      if (first && rng.chance(0.35)) promo = welcome;
      else if (active.length && rng.chance(0.42)) promo = rng.pick(active);
      if (inBroken && promo && promo.code === PROMO_BROKEN.code) {
        // промокод не застосовується — більшість покупців кидають кошик
        if (rng.chance(0.85)) { first = false; continue; }
        promo = null;
      }
      if (inBroken && !promo && rng.chance(0.22)) { first = false; continue; } // загальний відтік у березні 2025 (банер, що не працював)
      raw.push({ c, day, promo, first });
      first = false;
    }
  }

  // час доби
  raw.forEach((o) => { o.ts = o.day + rng.int(7 * 3600, 23 * 3600 + 3540) * 1000; });
  raw.sort((a, b) => a.ts - b.ts || a.c.customer_id - b.c.customer_id);

  const orders = [];
  const items = [];
  const returns = [];
  let oid = 1;
  let iid = 1;
  let rid = 1;

  function buildItems(o, orderId, ch) {
    const n = rng.chance(0.78) ? 1 : rng.chance(0.75) ? 2 : 3;
    const lines = [];
    const isPbPeak = o.day >= pbFrom && o.day <= pbTo;
    for (let j = 0; j < n; j++) {
      const cat = rng.weighted(CATEGORIES, (cc) => {
        let w = catWeight[cc[0]];
        if (cc[0] === 'Павербанки' && isPbPeak) w *= 7; // аномальний пік павербанків у листопаді 2025
        return w;
      })[0];
      const pool = byCat[cat];
      // Telegram-клієнти тягнуться до дорожчих товарів
      const p = rng.weighted(pool, (pp) => pp._w * Math.pow(pp.price_uah / 1000 + 0.2, ch.spend - 1));
      if (p._w === 0) { j--; continue; }
      if (lines.find((l) => l.product_id === p.product_id)) continue;
      const qty = p.price_uah < 800 && rng.chance(0.25) ? 2 : 1;
      lines.push({ order_item_id: 0, order_id: orderId, product_id: p.product_id, quantity: qty, unit_price_uah: p.price_uah });
    }
    return lines;
  }

  for (const o of raw) {
    const orderId = oid++;
    const lines = buildItems(o, orderId, o.c._ch);
    const subtotal = lines.reduce((s, l) => s + l.quantity * l.unit_price_uah, 0);
    const discount = o.promo ? Math.round(subtotal * o.promo.discount_pct) / 100 : 0;
    const total = Math.round((subtotal - discount) * 100) / 100;
    const dm = rng.weighted(DELIVERY, (d) => d.w);
    // статус
    let status;
    const daysToEnd = (lastMs - o.day) / DAY;
    if (daysToEnd < 4 && rng.chance(0.8)) status = 'in_transit';
    else if (rng.chance(0.07)) status = 'cancelled';
    else if (rng.chance(0.045)) status = 'returned';
    else status = 'delivered';
    let delivery = null;
    if (status === 'delivered' || status === 'returned') delivery = o.day + rng.int(dm.dmin, dm.dmax) * DAY;
    const order = {
      order_id: orderId,
      customer_id: o.c.customer_id,
      order_date: isoDate(o.ts),
      created_at: isoTs(o.ts),
      status,
      delivery_method: dm.name,
      delivery_date: delivery === null ? null : isoDate(delivery),
      promo_code_id: o.promo ? o.promo.promo_code_id : null,
      discount_uah: discount,
      total_uah: total,
    };
    orders.push(order);
    for (const l of lines) { l.order_item_id = iid++; items.push(l); }
    if (status === 'returned') {
      returns.push({
        return_id: rid++,
        order_id: orderId,
        return_date: isoDate(delivery + rng.int(1, 14) * DAY),
        reason: rng.pick(RETURN_REASONS),
        refund_uah: total,
      });
    }
    // дублікат через подвійний клік: той самий клієнт, сума, хвилина; нове order_id
    if (rng.chance(0.031)) {
      const sec = new Date(o.ts).getUTCSeconds();
      const shift = sec >= 58 ? 0 : rng.int(1, 59 - sec);
      const dupId = oid++;
      const dupTs = o.ts + shift * 1000;
      orders.push({ ...order, order_id: dupId, created_at: isoTs(dupTs) });
      for (const l of lines) items.push({ ...l, order_item_id: iid++, order_id: dupId });
      if (status === 'returned') {
        returns.push({ return_id: rid++, order_id: dupId, return_date: returns[returns.length - 1].return_date, reason: returns[returns.length - 1].reason, refund_uah: total });
      }
    }
  }

  const clean = (rows) => rows.map((r) => {
    const o = {};
    for (const k of Object.keys(r)) if (!k.startsWith('_')) o[k] = r[k];
    return o;
  });
  return {
    meta: { dataset: 'D1 Кошик', dataset_version: DATASET_VERSION, profile: profileName, seed: prof.seed, scale: prof.scale, generated_by: 'tools/gen_koshyk.js', note: 'CoLaba Production' },
    tables: {
      customers: clean(customers),
      products: clean(products),
      promo_codes: promos,
      orders,
      order_items: items,
      returns,
    },
  };
}

// ---------------------------------------------------------------- вивід
function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  return "'" + String(v).replace(/'/g, "''") + "'";
}

function schemaSql(schemaName) {
  const q = schemaName ? schemaName + '.' : '';
  const out = [];
  if (schemaName) out.push(`CREATE SCHEMA IF NOT EXISTS ${schemaName};`);
  for (const t of [...SCHEMA].reverse()) out.push(`DROP TABLE IF EXISTS ${q}${t.name} CASCADE;`);
  for (const t of SCHEMA) {
    const cols = t.columns.map(([n, d]) => `  ${n} ${schemaName ? d.replace(/REFERENCES (\w+)/, `REFERENCES ${q}$1`) : d}`).join(',\n');
    out.push(`CREATE TABLE ${q}${t.name} (\n${cols}\n);`);
  }
  return out.join('\n');
}

function toSql(ds, schemaName) {
  const q = schemaName ? schemaName + '.' : '';
  const parts = [`-- Vmiko · D1 «Кошик» · ${ds.meta.dataset_version} · profile=${ds.meta.profile} seed=${ds.meta.seed}`, '-- Згенеровано tools/gen_koshyk.js. Не редагувати вручну. CoLaba Production', 'BEGIN;', schemaSql(schemaName)];
  for (const t of SCHEMA) {
    const rows = ds.tables[t.name];
    const cols = t.columns.map((c) => c[0]);
    for (let i = 0; i < rows.length; i += 1000) {
      const chunk = rows.slice(i, i + 1000).map((r) => '(' + cols.map((c) => sqlLiteral(r[c])).join(',') + ')');
      parts.push(`INSERT INTO ${q}${t.name} (${cols.join(',')}) VALUES\n${chunk.join(',\n')};`);
    }
  }
  parts.push('CREATE INDEX ON ' + q + 'orders(customer_id);', 'CREATE INDEX ON ' + q + 'orders(order_date);', 'CREATE INDEX ON ' + q + 'order_items(order_id);', 'ANALYZE;', 'COMMIT;');
  return parts.join('\n') + '\n';
}

function toJson(ds) {
  // компактно: колонки + масив рядків
  const tables = {};
  for (const t of SCHEMA) {
    const cols = t.columns.map((c) => c[0]);
    // types — тип без обмежень (для швидкого COPY у браузері), pk — первинний ключ (додається після завантаження)
    const types = t.columns.map(([, d]) => d.replace(/ PRIMARY KEY| NOT NULL| REFERENCES \w+\(\w+\)/g, '').trim());
    const pk = (t.columns.find(([, d]) => /PRIMARY KEY/.test(d)) || [])[0] || null;
    tables[t.name] = { columns: cols, types, pk, rows: ds.tables[t.name].map((r) => cols.map((c) => r[c])) };
  }
  return JSON.stringify({ meta: ds.meta, tables });
}

function summary(ds) {
  const s = {};
  for (const [k, v] of Object.entries(ds.tables)) s[k] = v.length;
  return s;
}

module.exports = { generate, toSql, toJson, schemaSql, SCHEMA, PROFILES, DATASET_VERSION, PROMO_BROKEN };

if (require.main === module) {
  const check = process.argv.includes('--check');
  // SQL — у data/ (для pgAdmin/psql/DBeaver і для людей); JSON — у app/data/ (його вантажить застосунок).
  const outDir = path.join(__dirname, '..', 'data');
  const appDir = path.join(__dirname, '..', 'app', 'data');
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(appDir, { recursive: true });
  for (const name of Object.keys(PROFILES)) {
    const t0 = Date.now();
    const ds = generate(name);
    console.log(`[${name}] rows:`, JSON.stringify(summary(ds)), `${Date.now() - t0} ms`);
    if (check) continue;
    // видимий — у схемі public; прихований — окремо (у застосунку вантажиться у схему hidden)
    fs.writeFileSync(path.join(outDir, `koshyk_${name}.sql`), toSql(ds, null));
    fs.writeFileSync(path.join(appDir, `koshyk_${name}.json`), toJson(ds));
  }
  if (!check) console.log('Записано: SQL ->', outDir, '; JSON ->', appDir);
}
