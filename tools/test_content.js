#!/usr/bin/env node
/*
 * Перевірка контенту уроків (app/content): структура, еталони на обох датасетах, стартовий код, Parsons.
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
  const ids = new Set();
  const TYPES = new Set(['card', 'choice', 'sql', 'parsons']);
  for (const d of index.days) {
    const day = JSON.parse(fs.readFileSync(path.join(root, 'app', d.file), 'utf8'));
    console.log(`\n[${day.id}] ${day.title} — ${day.exercises.length} вправ`);
    check(`${day.id}: id збігається з index.json`, day.id === d.id);
    check(`${day.id}: 8–12 вправ на день`, day.exercises.length >= 8 && day.exercises.length <= 12, day.exercises.length);
    check(`${day.id}: dataset_version = ${vis.meta.dataset_version}`, day.dataset_version === vis.meta.dataset_version);
    const total = day.exercises.reduce((s, e) => s + e.minutes, 0);
    console.log(`  сумарно ${total} хв`);
    for (const e of day.exercises) {
      const tag = e.id;
      check(`${tag}: унікальний id`, !ids.has(e.id)); ids.add(e.id);
      check(`${tag}: відомий тип`, TYPES.has(e.type), e.type);
      check(`${tag}: тривалість 1–7 хв`, e.minutes >= 1 && e.minutes <= 7, e.minutes);
      check(`${tag}: device any|prefer_desktop`, ['any', 'prefer_desktop'].includes(e.device));
      check(`${tag}: є title`, !!e.title);
      const opts = e.type === 'choice' ? e.options : e.type === 'card' ? (e.question || {}).options : null;
      if (opts) {
        check(`${tag}: рівно 1 правильний варіант`, opts.filter((o) => o.correct).length === 1);
        check(`${tag}: кожен варіант має пояснення`, opts.every((o) => o.explain && o.explain.length > 5));
      }
      if (e.type === 'card') check(`${tag}: 1–5 екранів`, e.screens.length >= 1 && e.screens.length <= 5);
      if (e.sandbox) { const r = await R.runReadOnly(db, e.sandbox, R.VISIBLE); check(`${tag}: sandbox-запит виконується`, r.ok, r.error); }
      if (e.type === 'sql' || e.type === 'parsons') {
        check(`${tag}: має 2 авторські підказки`, Array.isArray(e.hints) && e.hints.length >= 2);
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
  await db.close();
  console.log(`\nРезультат: ${passed} пройдено, ${failed} провалено`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
