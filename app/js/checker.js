/*
 * Детермінована перевірка результатів SQL: порівняння результату учня з еталоном.
 * Чистий модуль без залежностей: працює і в браузері (воркер БД), і в Node (tools/test_checker.js).
 *
 * Результат запиту: { fields: [{ name, dataTypeID }], rows: [[...], ...] }  (рядки — масиви значень)
 *
 * Правила (розділ 4 специфікації, тип «SQL-задача»):
 *  - порядок рядків враховується лише якщо в еталоні є ORDER BY на верхньому рівні (або ordered: true у вправі);
 *  - назви колонок ігноруються (якщо не checkColumnNames: true);
 *  - порядок колонок може відрізнятися (allowColumnReorder, за замовчуванням так);
 *  - числа порівнюються з допуском (за замовчуванням 0.01 абсолютно);
 *  - нічиї в сортуванні: orderKey — індекси колонок еталона, за якими перевіряється порядок;
 *  - режим subset: для запитів з LIMIT без ORDER BY (будь-які N рядків з правильної множини).
 *
 * CoLaba Production
 */

const NUMERIC_TYPES = new Set([20, 21, 23, 700, 701, 1700, 26]); // int8, int2, int4, float4, float8, numeric, oid

/** Прибирає коментарі й рядкові літерали, щоб шукати ключові слова лише в коді. */
export function stripSqlNoise(sql) {
  let out = '';
  let i = 0;
  const s = String(sql);
  while (i < s.length) {
    const c = s[i];
    const n = s[i + 1];
    if (c === '-' && n === '-') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; out += ' '; continue; }
    if (c === "'") { i++; while (i < s.length) { if (s[i] === "'" && s[i + 1] === "'") { i += 2; continue; } if (s[i] === "'") break; i++; } i++; out += "''"; continue; }
    if (c === '"') { i++; while (i < s.length && s[i] !== '"') i++; i++; out += '"x"'; continue; }
    if (c === '$') { // $$ ... $$ або $tag$ ... $tag$
      const m = /^\$[A-Za-z_]*\$/.exec(s.slice(i));
      if (m) { const end = s.indexOf(m[0], i + m[0].length); i = end < 0 ? s.length : end + m[0].length; out += "''"; continue; }
    }
    out += c; i++;
  }
  return out;
}

/** Чи є ORDER BY на верхньому рівні запиту (не в підзапиті, не у вікні OVER (...)). */
export function hasTopLevelOrderBy(sql) {
  const s = stripSqlNoise(sql);
  let depth = 0;
  let top = '';
  for (const ch of s) {
    if (ch === '(') { depth++; top += ' '; continue; }
    if (ch === ')') { depth = Math.max(0, depth - 1); top += ' '; continue; }
    top += depth === 0 ? ch : ' ';
  }
  return /\border\s+by\b/i.test(top);
}

/** Нормалізує одне значення до порівнюваного вигляду. */
export function normalizeValue(v, dataTypeID) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number') return Object.is(v, -0) ? 0 : v;
  if (typeof v === 'boolean') return v;
  if (v instanceof Date) return isNaN(v.getTime()) ? String(v) : v.toISOString();
  if (typeof v === 'string') {
    if (NUMERIC_TYPES.has(dataTypeID) && /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(v.trim())) return Number(v);
    if (v === 'NaN' && NUMERIC_TYPES.has(dataTypeID)) return NaN;
    return v;
  }
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function normalizeResult(res) {
  const types = (res.fields || []).map((f) => f.dataTypeID);
  return {
    fields: res.fields || [],
    rows: (res.rows || []).map((r) => r.map((v, i) => normalizeValue(v, types[i]))),
  };
}

function valuesEqual(a, b, tol) {
  if (a === null || b === null) return a === b;
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) && Number.isNaN(b);
    return Math.abs(a - b) <= tol.abs || Math.abs(a - b) <= tol.rel * Math.max(Math.abs(a), Math.abs(b));
  }
  return a === b;
}
function rowsEqual(r1, r2, tol) {
  if (r1.length !== r2.length) return false;
  for (let i = 0; i < r1.length; i++) if (!valuesEqual(r1[i], r2[i], tol)) return false;
  return true;
}
function keyOf(v, decimals) {
  if (v === null) return '\u0000N';
  if (typeof v === 'number') return 'n' + (Number.isNaN(v) ? 'NaN' : v.toFixed(decimals));
  if (typeof v === 'boolean') return 'b' + v;
  return 's' + v;
}
const rowKey = (r, decimals) => r.map((v) => keyOf(v, decimals)).join('\u0001');

/** Порівняння двох мультимножин рядків з допуском. */
function multisetEqual(exp, act, tol) {
  if (exp.length !== act.length) return false;
  const decimals = Math.max(0, Math.round(-Math.log10(tol.abs || 1e-9)));
  const e = exp.map((r) => [rowKey(r, decimals), r]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const a = act.map((r) => [rowKey(r, decimals), r]).sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  let ok = true;
  for (let i = 0; i < e.length; i++) if (!rowsEqual(e[i][1], a[i][1], tol)) { ok = false; break; }
  if (ok) return true;
  // Запасний шлях для чисел на межі округлення: жадібне зіставлення (лише для невеликих результатів).
  if (exp.length > 3000) return false;
  const used = new Array(act.length).fill(false);
  for (const r of exp) {
    let found = -1;
    for (let j = 0; j < act.length; j++) if (!used[j] && rowsEqual(r, act[j], tol)) { found = j; break; }
    if (found < 0) return false;
    used[found] = true;
  }
  return true;
}

function columnSignature(rows, col, decimals) {
  return rows.map((r) => keyOf(r[col], decimals)).sort().join('\u0002');
}

/** Шукає перестановку колонок учня, за якої колонки збігаються з еталонними (за вмістом). */
function findColumnMapping(exp, act, tol) {
  const n = exp.fields.length;
  if (n > 8 || exp.rows.length !== act.rows.length) return null;
  const decimals = Math.max(0, Math.round(-Math.log10(tol.abs || 1e-9)));
  const es = [], as = [];
  for (let i = 0; i < n; i++) { es.push(columnSignature(exp.rows, i, decimals)); as.push(columnSignature(act.rows, i, decimals)); }
  const map = [];
  const used = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    let j = as.findIndex((sig, k) => !used[k] && sig === es[i]);
    if (j < 0) return null;
    used[j] = true; map.push(j);
  }
  return map;
}
const permute = (rows, map) => rows.map((r) => map.map((j) => r[j]));

/**
 * Головна функція.
 * @param expected  результат еталонного запиту
 * @param actual    результат запиту учня
 * @param opts      { ordered, orderKey, mode: 'exact'|'subset', rowCount, tolerance: {abs, rel}, checkColumnNames, allowColumnReorder }
 * @returns { ok, code, message }  message — українською, для учня
 */
export function compareResults(expected, actual, opts = {}) {
  const tol = { abs: 0.01, rel: 1e-9, ...(opts.tolerance || {}) };
  const exp = normalizeResult(expected);
  const act = normalizeResult(actual);
  const nE = exp.fields.length, nA = act.fields.length;

  if (nE !== nA) {
    return { ok: false, code: 'columns_count', message: `Кількість колонок не та: потрібно ${nE}, у тебе ${nA}.` };
  }
  if (opts.checkColumnNames) {
    const en = exp.fields.map((f) => f.name.toLowerCase()), an = act.fields.map((f) => f.name.toLowerCase());
    const missing = en.filter((x) => !an.includes(x));
    if (missing.length) return { ok: false, code: 'column_names', message: `Назви колонок мають бути: ${en.join(', ')}. Бракує: ${missing.join(', ')}.` };
  }

  if (opts.mode === 'subset') {
    // будь-які rowCount рядків з повної правильної множини
    const want = opts.rowCount;
    if (want != null && act.rows.length !== want) {
      return { ok: false, code: 'row_count', message: `Потрібно рівно ${want} рядків, у тебе ${act.rows.length}.` };
    }
    const decimals = Math.max(0, Math.round(-Math.log10(tol.abs || 1e-9)));
    const basePool = new Map();
    for (const r of exp.rows) { const k = rowKey(r, decimals); basePool.set(k, (basePool.get(k) || 0) + 1); }
    const tryWith = (rows) => {
      if (rows.length && !basePool.has(rowKey(rows[0], decimals))) return false; // швидке відсіювання
      const used = new Map();
      for (const r of rows) {
        const k = rowKey(r, decimals);
        const u = (used.get(k) || 0) + 1;
        if (u > (basePool.get(k) || 0)) return false;
        used.set(k, u);
      }
      return true;
    };
    if (tryWith(act.rows)) return { ok: true, code: 'ok', message: 'Правильно!' };
    if (opts.allowColumnReorder !== false && nE <= 6) {
      for (const p of permutations(nE)) if (tryWith(permute(act.rows, p))) return { ok: true, code: 'ok', message: 'Правильно!' };
    }
    return { ok: false, code: 'values', message: 'Колонки або значення не ті: рядки не збігаються з даними таблиці.' };
  }

  if (exp.rows.length !== act.rows.length) {
    return { ok: false, code: 'row_count', message: `Кількість рядків не та: потрібно ${exp.rows.length}, у тебе ${act.rows.length}.` };
  }

  const ordered = opts.ordered === true;
  let actRows = act.rows;

  const attempt = (rows) => {
    if (!multisetEqual(exp.rows, rows, tol)) return 'values';
    if (ordered) {
      const key = opts.orderKey && opts.orderKey.length ? opts.orderKey : [...Array(nE).keys()];
      for (let i = 0; i < rows.length; i++) {
        for (const k of key) if (!valuesEqual(exp.rows[i][k], rows[i][k], tol)) return 'order';
      }
    }
    return 'ok';
  };

  let verdict = attempt(actRows);
  if (verdict === 'values' && opts.allowColumnReorder !== false) {
    const map = findColumnMapping(exp, act, tol);
    if (map && map.some((j, i) => j !== i)) {
      actRows = permute(act.rows, map);
      verdict = attempt(actRows);
    }
  }
  if (verdict === 'ok') return { ok: true, code: 'ok', message: 'Правильно!' };
  if (verdict === 'order') return { ok: false, code: 'order', message: 'Рядки правильні, але порядок не той. Перевір ORDER BY і напрям сортування (ASC/DESC).' };
  return { ok: false, code: 'values', message: 'Кількість рядків правильна, але значення відрізняються. Перевір умови, обчислення і колонки.' };
}

function permutations(n) {
  const res = [];
  const a = [...Array(n).keys()];
  const rec = (k) => {
    if (k === n) { res.push(a.slice()); return; }
    for (let i = k; i < n; i++) { [a[k], a[i]] = [a[i], a[k]]; rec(k + 1); [a[k], a[i]] = [a[i], a[k]]; }
  };
  if (n <= 6) rec(0); else res.push(a.slice());
  return res;
}

/**
 * Опції порівняння для вправи: явні налаштування вправи мають пріоритет над автоматикою.
 */
export function optionsForExercise(ex) {
  const check = ex.check || {};
  return {
    mode: check.mode || 'exact',
    rowCount: check.rowCount,
    ordered: check.ordered !== undefined ? check.ordered : (check.mode === 'subset' ? false : hasTopLevelOrderBy(ex.reference)),
    orderKey: check.orderKey,
    tolerance: check.tolerance,
    checkColumnNames: !!check.checkColumnNames,
    allowColumnReorder: check.allowColumnReorder !== false,
  };
}

/** Перекладає типові помилки Postgres на зрозумілу українську (оригінал лишається поруч). */
export function explainPgError(msg) {
  const m = String(msg || '');
  let r;
  if ((r = /column "([^"]+)" does not exist/i.exec(m))) return `Колонки «${r[1]}» немає. Перевір назву або, якщо це текст, візьми його в одинарні лапки: '${r[1]}'.`;
  if ((r = /relation "([^"]+)" does not exist/i.exec(m))) return `Таблиці «${r[1]}» немає. Перевір назву таблиці.`;
  if ((r = /syntax error at or near "([^"]*)"/i.exec(m))) return `Синтаксична помилка біля «${r[1]}». Перевір коми, лапки і порядок ключових слів.`;
  if (/syntax error at end of input/i.test(m)) return 'Запит обірвався: чогось бракує в кінці (колонки, таблиці чи умови).';
  if (/must appear in the GROUP BY clause/i.test(m)) return 'Колонка в SELECT має бути або в GROUP BY, або всередині агрегатної функції (SUM, COUNT…).';
  if (/cannot insert multiple commands/i.test(m)) return 'Тут виконується лише один запит за раз. Прибери зайві запити (після «;»).';
  if (/read-only transaction/i.test(m)) return 'У навчальній базі можна лише читати дані (SELECT). Змінювати таблиці не можна.';
  if (/division by zero/i.test(m)) return 'Ділення на нуль. Підказка: NULLIF(x, 0).';
  if (/operator does not exist/i.test(m)) return 'Типи не поєднуються (наприклад, текст порівнюється з числом). Перевір лапки і типи колонок.';
  if (/invalid input syntax for type/i.test(m)) return 'Значення не того формату (наприклад, дата чи число записані неправильно).';
  return 'Запит не виконався. Прочитай повідомлення бази нижче.';
}
