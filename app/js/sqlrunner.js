/*
 * Робота з PGlite: завантаження датасету, безпечне виконання запиту учня, перевірка вправи.
 * Не залежить від DOM: використовується у воркері (браузер) і в Node-тестах.
 *
 * Безпека виконання:
 *  - кожен запит учня — в окремій транзакції BEGIN READ ONLY … ROLLBACK (змінити дані неможливо);
 *  - лише одна команда за раз (розширений протокол Postgres відхиляє кілька команд);
 *  - search_path задається на кожен запит: public = видимі дані, hidden = перевірочні.
 *  - зависання (нескінченний запит) обробляє головний потік: таймер + перезапуск воркера.
 *
 * CoLaba Production
 */
import { compareResults, optionsForExercise } from './checker.js';

export const VISIBLE = 'public';
export const HIDDEN = 'hidden';

const ident = (s) => '"' + String(s).replace(/"/g, '""') + '"';

function tsvEscape(v) {
  if (v === null || v === undefined) return '\\N';
  return String(v).replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

/** Завантажує датасет (JSON від tools/gen_koshyk.js) у вказану схему через COPY. */
export async function loadDataset(db, data, schema) {
  const s = ident(schema);
  await db.exec(`CREATE SCHEMA IF NOT EXISTS ${s};`);
  for (const [name, t] of Object.entries(data.tables)) {
    const cols = t.columns.map((c, i) => `${ident(c)} ${t.types[i]}`).join(', ');
    await db.exec(`DROP TABLE IF EXISTS ${s}.${ident(name)} CASCADE; CREATE TABLE ${s}.${ident(name)} (${cols});`);
    const tsv = t.rows.map((r) => r.map(tsvEscape).join('\t')).join('\n') + '\n';
    await db.query(`COPY ${s}.${ident(name)} (${t.columns.map(ident).join(', ')}) FROM '/dev/blob'`, [], { blob: new Blob([tsv]) });
    if (t.pk) await db.exec(`ALTER TABLE ${s}.${ident(name)} ADD PRIMARY KEY (${ident(t.pk)});`);
  }
  await db.exec(`ANALYZE;`);
  await db.exec(`CREATE TABLE IF NOT EXISTS public._vmiko_meta (schema_name text PRIMARY KEY, dataset_version text);
    INSERT INTO public._vmiko_meta VALUES ('${schema}', '${String(data.meta.dataset_version).replace(/'/g, "''")}')
    ON CONFLICT (schema_name) DO UPDATE SET dataset_version = EXCLUDED.dataset_version;`);
}

/** Прибирає кінцеві «;» і пробіли (PGlite.query приймає одну команду). */
export function cleanSql(sql) {
  return String(sql || '').replace(/[\s;]+$/g, '').trim();
}

/** Виконує один запит учня лише на читання. Повертає { ok, fields, rows (масиви), rowCount, ms } або { ok:false, error }. */
export async function runReadOnly(db, sql, schema = VISIBLE, { maxRows = Infinity } = {}) {
  const q = cleanSql(sql);
  if (!q) return { ok: false, error: 'Порожній запит.' };
  const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
  try {
    await db.exec(`BEGIN READ ONLY; SET LOCAL search_path TO ${ident(schema)};`);
    const res = await db.query(q, [], { rowMode: 'array' });
    const rows = res.rows.length > maxRows ? res.rows.slice(0, maxRows) : res.rows;
    return {
      ok: true,
      fields: res.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })),
      rows,
      rowCount: res.rows.length,
      truncated: res.rows.length > maxRows,
      ms: Math.round((typeof performance !== 'undefined' ? performance : Date).now() - t0),
    };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e), position: e && e.position };
  } finally {
    try { await db.exec('ROLLBACK;'); } catch (_) { /* транзакцію могли вже закрити */ }
  }
}

/**
 * Перевіряє розв'язок учня: еталон і запит учня виконуються на видимих і прихованих даних,
 * результати порівнюються (checker.compareResults).
 * Повертає { ok, stage: 'run'|'visible'|'hidden'|'ok', message, error? }
 */
export async function checkExercise(db, ex, studentSql) {
  const opts = optionsForExercise(ex);
  const refSql = opts.mode === 'subset' ? (ex.check.referenceFull || ex.reference) : ex.reference;
  for (const schema of [VISIBLE, HIDDEN]) {
    const stu = await runReadOnly(db, studentSql, schema);
    if (!stu.ok) return { ok: false, stage: 'run', message: 'Запит не виконався.', error: stu.error };
    const ref = await runReadOnly(db, refSql, schema);
    if (!ref.ok) return { ok: false, stage: 'internal', message: 'Помилка в еталоні вправи (не твоя провина). Повідом нам.', error: ref.error };
    const cmp = compareResults(ref, stu, opts);
    if (!cmp.ok) {
      if (schema === HIDDEN) {
        return { ok: false, stage: 'hidden', code: cmp.code, message: 'На видимих даних результат збігся, але на перевірочних — ні. Схоже, запит підігнаний під конкретні числа або умова записана не загально. ' + cmp.message };
      }
      return { ok: false, stage: 'visible', code: cmp.code, message: cmp.message };
    }
  }
  return { ok: true, stage: 'ok', message: 'Правильно! Запит дає правильний результат і на перевірочних даних.' };
}
