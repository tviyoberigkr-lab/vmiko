#!/usr/bin/env node
/*
 * Перевірка контенту уроків (app/content): структура, еталони на обох датасетах, стартовий код, Parsons,
 * три рівні підказок без готового запиту (підказки 1–2 не повторюють еталон: ліміт токенів підряд і спільних літералів), посилання index.json на дні, додаткові розв'язки з tools/content_cases.json
 * (інші правильні записи мають зараховуватися, типові помилки — ні).
 * Запуск: node tools/test_content.js
 * CoLaba Production
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) passed++;
  else { failed++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}
(async () => {
  const root = path.join(__dirname, '..');
  const R = await import(pathToFileURL(path.join(root, 'app/js/sqlrunner.js')).href);
  const C = await import(pathToFileURL(path.join(root, 'app/js/checker.js')).href);
  const { PGlite } = await import(pathToFileURL(path.join(root, 'node_modules/@electric-sql/pglite/dist/index.js')).href);
  const db = new PGlite();
  await db.waitReady;
  const vis = JSON.parse(fs.readFileSync(path.join(root, 'app/data/koshyk_visible.json'), 'utf8'));
  await R.loadDataset(db, vis, R.VISIBLE);
  await R.loadDataset(db, JSON.parse(fs.readFileSync(path.join(root, 'app/data/koshyk_hidden.json'), 'utf8')), R.HIDDEN);
  const index = JSON.parse(fs.readFileSync(path.join(root, 'app/content/index.json'), 'utf8'));
  const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'content_cases.json'), 'utf8'));
  delete cases._about;
  const ids = new Set();
  const exById = new Map();
  const TYPES = new Set(['card', 'choice', 'sql', 'parsons', 'milestone']);
  const HINT_MAX_RUN = 7, HINT_MAX_LITS = 2, HINT_MAX_RUN_EXAMPLE = 10;
  const tokens = (s) => String(s).toLowerCase().match(/'[^']*'|[a-zа-яіїєґ_][\wа-яіїєґ]*|\d+(?:\.\d+)?|::|<>|>=|<=|!=|\S/g) || [];
  const literals = (s) => new Set(String(s).toLowerCase().match(/'[^']*'|\b\d{2,}(?:\.\d+)?\b/g) || []);
  const maxRun = (a, b) => {
    let best = 0;
    for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
      let k = 0;
      while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k]) k++;
      if (k > best) best = k;
    }
    return best;
  };
  const norm = (s) => String(s).toLowerCase().replace(/[\s;]+/g, ' ').trim();

  // index.json: кожен день має унікальний id, файл існує, дні йдуть по порядку
  console.log('\n[index.json]');
  check('index.json: є хоча б один день', Array.isArray(index.days) && index.days.length > 0);
  check('index.json: id днів унікальні', new Set(index.days.map((d) => d.id)).size === index.days.length);
  check('index.json: файли днів унікальні', new Set(index.days.map((d) => d.file)).size === index.days.length);
  for (const d of index.days) check(`index.json: файл ${d.file} існує`, fs.existsSync(path.join(root, 'app', d.file)));
  const swText = fs.readFileSync(path.join(root, 'app/sw.js'), 'utf8');
  for (const d of index.days) check(`sw.js: ${d.file} є в офлайн-кеші`, swText.includes(`'${d.file}'`));

  for (const [di, d] of index.days.entries()) {
    if (!fs.existsSync(path.join(root, 'app', d.file))) continue;
    const day = JSON.parse(fs.readFileSync(path.join(root, 'app', d.file), 'utf8'));
    console.log(`\n[${day.id}] ${day.title} — ${day.exercises.length} вправ`);
    check(`${day.id}: id збігається з index.json`, day.id === d.id);
    check(`${day.id}: номер дня = позиція в index.json (${di + 1})`, day.day === di + 1, day.day);
    check(`${day.id}: 8–12 вправ на день`, day.exercises.length >= 8 && day.exercises.length <= 12, day.exercises.length);
    check(`${day.id}: dataset_version = ${vis.meta.dataset_version}`, day.dataset_version === vis.meta.dataset_version);
    const total = day.exercises.reduce((s, e) => s + e.minutes, 0);
    console.log(`  сумарно ${total} хв`);
    check(`${day.id}: порція ≈30 хв (25–40)`, total >= 25 && total <= 40, total);
    check(`${day.id}: id вправ мають префікс дня`, day.exercises.every((e) => e.id.startsWith(day.id + '-')));
    for (const e of day.exercises) {
      const tag = e.id;
      check(`${tag}: унікальний id`, !ids.has(e.id)); ids.add(e.id); exById.set(e.id, e);
      check(`${tag}: відомий тип`, TYPES.has(e.type), e.type);
      check(`${tag}: тривалість 1–7 хв`, e.minutes >= 1 && e.minutes <= 7, e.minutes);
      check(`${tag}: device any|prefer_desktop`, ['any', 'prefer_desktop'].includes(e.device));
      check(`${tag}: є title`, !!e.title);
      const opts = e.type === 'choice' ? e.options : e.type === 'card' ? (e.question || {}).options : null;
      if (opts) {
        check(`${tag}: рівно 1 правильний варіант`, opts.filter((o) => o.correct).length === 1);
        check(`${tag}: кожен варіант має пояснення`, opts.every((o) => o.explain && o.explain.length > 5));
      }
      if (e.type === 'card' || e.type === 'milestone') check(`${tag}: 1–5 екранів`, Array.isArray(e.screens) && e.screens.length >= 1 && e.screens.length <= 5);
      if (e.type === 'milestone') check(`${tag}: є бейдж (badge.title) і текст кнопки (cta)`, !!(e.badge && e.badge.title && e.cta));
      if (e.project !== undefined) check(`${tag}: project — непорожній рядок`, typeof e.project === 'string' && e.project.trim().length > 0);
      if (e.table) check(`${tag}: у міні-таблиці кожен рядок має стільки значень, скільки колонок`, e.table.rows.every((r) => r.length === e.table.columns.length));
      if (e.sandbox) { const r = await R.runReadOnly(db, e.sandbox, R.VISIBLE); check(`${tag}: sandbox-запит виконується`, r.ok, r.error); }
      if (e.type === 'sql' || e.type === 'parsons') {
        check(`${tag}: має 3 авторські підказки (напрям → місце → приклад)`, Array.isArray(e.hints) && e.hints.length === 3 && e.hints.every((h) => typeof h === 'string' && h.trim().length > 10));
        // жодна підказка не містить готового еталонного запиту
        check(`${tag}: підказки не містять готового еталону`, e.starterPasses || (e.hints || []).every((h) => !norm(h).includes(norm(e.reference))));
        // підказки 1 і 2 — напрям і структура, а не копія еталона: не більше HINT_MAX_RUN токенів еталона підряд
        // і не більше HINT_MAX_LITS його літералів (рядків і чисел ≥ 2 цифр); короткі еталони (< 12 токенів) і вправи «запусти готове» — виняток;
        // підказка 3 — приклад на іншій таблиці: ліміт м'якший
        if (!e.starterPasses) {
          const rt = tokens(e.reference), rl = literals(e.reference);
          for (const hi of [0, 1, 2]) {
            const h = e.hints[hi];
            const run = maxRun(tokens(h), rt);
            const lc = [...literals(h)].filter((x) => rl.has(x)).length;
            if (hi < 2 && rt.length >= 12) {
              check(`${tag}: підказка ${hi + 1} не повторює ${HINT_MAX_RUN}+ токенів еталона підряд (є ${run})`, run <= HINT_MAX_RUN, h);
              check(`${tag}: підказка ${hi + 1} не містить значень еталона (літералів ${lc}, ліміт ${HINT_MAX_LITS})`, lc <= HINT_MAX_LITS, h);
            }
            if (hi === 2) check(`${tag}: приклад (підказка 3) не повторює еталон довше ${HINT_MAX_RUN_EXAMPLE} токенів підряд (є ${run})`, run <= HINT_MAX_RUN_EXAMPLE, h);
          }
        }
        const opt = C.optionsForExercise(e);
        const refSql = opt.mode === 'subset' ? e.check.referenceFull : e.reference;
        const rv = await R.runReadOnly(db, refSql, R.VISIBLE);
        const rh = await R.runReadOnly(db, refSql, R.HIDDEN);
        check(`${tag}: еталон виконується на обох наборах`, rv.ok && rh.ok, rv.error || rh.error);
        check(`${tag}: еталон дає непорожній результат`, rv.ok && rv.rowCount > 0 && rh.rowCount > 0);
        if (opt.mode !== 'subset' && rv.ok && rh.ok) {
          const same = C.compareResults(rv, rh, opt).ok;
          check(`${tag}: результати на видимих і прихованих різні (інакше прихований набір нічого не ловить)`, !same);
        }
        if (opt.mode === 'subset') check(`${tag}: subset має rowCount і referenceFull`, e.check.rowCount > 0 && !!e.check.referenceFull);
        if (opt.orderKey) check(`${tag}: orderKey у межах колонок еталона`, rv.ok && opt.orderKey.every((k) => k >= 0 && k < rv.fields.length));
        const self = await R.checkExercise(db, e, e.reference);
        check(`${tag}: еталон проходить власну перевірку`, self.ok, JSON.stringify(self));
        if (e.type === 'sql' && e.starter && e.starter.trim()) {
          const st = await R.checkExercise(db, e, e.starter);
          check(`${tag}: стартовий код ${e.starterPasses ? 'проходить (так задумано)' : 'НЕ проходить'}`, !!st.ok === !!e.starterPasses, JSON.stringify(st).slice(0, 160));
        }
        if (e.type === 'parsons') {
          const assembled = e.blocks.join(' ');
          const r = await R.checkExercise(db, e, assembled);
          check(`${tag}: правильна збірка блоків проходить`, r.ok, assembled);
          // кожен блок-пастка, підставлений замість схожого правильного, має провалюватися
          for (const dis of e.distractors) {
            let bad = false;
            for (let i = 0; i < e.blocks.length; i++) {
              const alt = e.blocks.slice(); alt[i] = dis;
              const rr = await R.checkExercise(db, e, alt.join(' '));
              if (rr.ok) bad = true;
            }
            check(`${tag}: пастка «${dis}» не дає правильного результату`, !bad);
          }
        }
      }
    }
  }
  // Додаткові розв'язки: інші правильні записи і типові помилки
  console.log('\n[content_cases.json]');
  for (const [id, c] of Object.entries(cases)) {
    const e = exById.get(id);
    check(`${id}: вправа з content_cases існує і є sql/parsons`, !!e && (e.type === 'sql' || e.type === 'parsons'));
    if (!e) continue;
    for (const sql of c.pass || []) {
      const r = await R.checkExercise(db, e, sql);
      check(`${id}: інший правильний запис зараховується — ${sql.slice(0, 70)}…`, r.ok, JSON.stringify(r).slice(0, 200));
    }
    for (const sql of c.fail || []) {
      const r = await R.checkExercise(db, e, sql);
      check(`${id}: типова помилка НЕ зараховується — ${sql.slice(0, 70)}…`, !r.ok, JSON.stringify(r).slice(0, 200));
    }
  }
  await db.close();
  console.log(`\nРезультат: ${passed} пройдено, ${failed} провалено`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
