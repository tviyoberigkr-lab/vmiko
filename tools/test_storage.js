#!/usr/bin/env node
/*
 * Тести шару збереження прогресу (app/js/storage.js) — у Node, без браузера.
 * «Вкладки» = кілька createProgressStore на спільному фейковому localStorage (або спільному MemoryAdapter).
 * Перевіряє: дві вкладки не гублять зарахування; битий запис не валить старт і лишає копію :broken:;
 * QuotaExceeded доходить до підписника, стан у пам'яті живий; submitted скидається при старті;
 * експорт/імпорт; знімок перед скиданням; обмеження довжини коду.
 * Запуск: node tools/test_storage.js
 * CoLaba Production
 */
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail !== undefined ? '  -> ' + detail : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setTimeout(r, 0)); // дати відпрацювати queueMicrotask(flush)

/** Фейковий localStorage з керованою квотою і поломкою читання. */
class FakeLocalStorage {
  constructor() { this.m = new Map(); this.quotaFull = false; this.readFails = false; }
  get length() { return this.m.size; }
  key(i) { return [...this.m.keys()][i] ?? null; }
  getItem(k) {
    if (this.readFails) { const e = new Error('The operation is insecure.'); e.name = 'SecurityError'; throw e; }
    return this.m.has(k) ? this.m.get(k) : null;
  }
  setItem(k, v) {
    if (this.quotaFull) { const e = new Error("Failed to execute 'setItem' on 'Storage': exceeded the quota."); e.name = 'QuotaExceededError'; e.code = 22; throw e; }
    this.m.set(k, String(v));
  }
  removeItem(k) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

// службові повідомлення storage.js (console.warn/error) у тесті очікувані — збираємо, а не друкуємо
const logged = [];
console.warn = (...a) => logged.push(['warn', a]);
console.error = (...a) => logged.push(['error', a]);

(async () => {
  const root = path.join(__dirname, '..');
  const S = await import(pathToFileURL(path.join(root, 'app/js/storage.js')).href);
  const KEY = 'vmiko:progress';
  const ls = () => globalThis.localStorage;
  const disk = () => JSON.parse(ls().getItem(KEY));
  const brokenKeys = () => [...ls().m.keys()].filter((k) => k.startsWith(KEY + ':broken:'));
  const fresh = () => { globalThis.localStorage = new FakeLocalStorage(); };
  const tab = () => S.createProgressStore(new S.LocalStorageAdapter());
  // завершити вправу так, як це робить main.js
  const pass = (st, id) => st.updateExercise(id, { attempts: (st.exercise(id).attempts || 0) + 1, status: 'passed', passedAt: new Date().toISOString(), solution: 'SELECT 1' });

  console.log('\n[1] Дві вкладки: застаріла вкладка не стирає passed (QA-02 К1)');
  fresh();
  let A = await tab(), B = await tab();
  pass(A, 'm1-d1-03'); await tick();
  check('A записала passed на диск', disk().exercises['m1-d1-03']?.status === 'passed');
  await B.flushNow(); // B стала прихованою, змін у неї не було
  check('B без змін нічого не пише — passed на місці', disk().exercises['m1-d1-03']?.status === 'passed');
  await sleep(2);
  B.updateExercise('m1-d1-05', { code: 'select 5' }); await tick();
  check('B змінила іншу вправу — обидві вправи на диску', disk().exercises['m1-d1-03']?.status === 'passed' && disk().exercises['m1-d1-05']?.code === 'select 5');
  await sleep(2);
  B.updateExercise('m1-d1-03', { code: 'select 3 -- B пише пізніше', status: 'in_progress', attempts: 0 }); await tick();
  const e3 = disk().exercises['m1-d1-03'];
  check('B пізніше змінила ТУ САМУ вправу — passed не знижено', e3.status === 'passed', e3.status);
  check('…код взято новіший (з B)', e3.code === 'select 3 -- B пише пізніше', e3.code);
  check('…attempts — максимум (1)', e3.attempts === 1, e3.attempts);
  check('…passedAt і solution збережені', !!e3.passedAt && e3.solution === 'SELECT 1');
  await A.reloadFromDisk();
  check('A після події storage бачить вправу з B', A.exercise('m1-d1-05').code === 'select 5');
  await A.flushNow();
  check('A після reload не перетирає B', disk().exercises['m1-d1-05']?.code === 'select 5');

  console.log('\n[2] Вкладки на спільному MemoryAdapter');
  {
    const mem = new S.MemoryAdapter();
    const X = await S.createProgressStore(mem), Y = await S.createProgressStore(mem);
    pass(X, 'm1-d2-01'); await tick();
    Y.setCurrent('m1-d2', 'm1-d2-02'); await tick();
    const d = await mem.load('progress');
    check('passed з X пережив запис Y', d.exercises['m1-d2-01']?.status === 'passed');
    check('current з Y записано', d.current?.exerciseId === 'm1-d2-02');
  }

  console.log('\n[3] mergeStates: правила і детермінізм');
  {
    const t1 = '2026-11-21T10:00:00.000Z', t2 = '2026-11-21T11:00:00.000Z';
    const a = { exercises: { x: { status: 'passed', attempts: 2, updatedAt: t1, passedAt: t1 } }, updatedAt: t1 };
    const b = { exercises: { x: { status: 'needs_retry', attempts: 1, code: 'new', updatedAt: t2 } }, updatedAt: t2 };
    const m = S.mergeStates(a, b);
    check('passed не понижується новішим needs_retry', m.exercises.x.status === 'passed');
    check('attempts = max', m.exercises.x.attempts === 2);
    check('код з новішого', m.exercises.x.code === 'new');
    check('злиття симетричне (a,b) == (b,a)', JSON.stringify(S.mergeStates(a, b)) === JSON.stringify(S.mergeStates(b, a)));
    const p = { exercises: { y: { status: 'in_progress', code: 'p', updatedAt: t1 } }, updatedAt: t1 };
    const q = { exercises: { y: { status: 'in_progress', code: 'q', updatedAt: t1 } }, updatedAt: t1 };
    check('рівний updatedAt — однаковий результат з обох боків (немає «пінг-понгу» вкладок)', JSON.stringify(S.mergeStates(p, q)) === JSON.stringify(S.mergeStates(q, p)));
    const sub = { exercises: { z: { status: 'submitted', updatedAt: t1 } } }, ip = { exercises: { z: { status: 'in_progress', updatedAt: t1 } } };
    check('рівний updatedAt: in_progress перемагає завислий submitted', S.mergeStates(sub, ip).exercises.z.status === 'in_progress');
    const mm = S.mergeStates(m, m);
    check('злиття ідемпотентне', JSON.stringify(S.mergeStates(mm, m)) === JSON.stringify(mm));
    check('вхідні об\'єкти не змінено', a.exercises.x.status === 'passed' && b.exercises.x.status === 'needs_retry');
  }

  console.log('\n[4] Скидання: знімок, мітка resetAt, стара вкладка не воскрешає стерте');
  fresh();
  A = await tab(); B = await tab();
  pass(A, 'm1-d1-01'); await tick();
  await B.reloadFromDisk();
  check('B бачить passed до скидання', B.exercise('m1-d1-01').status === 'passed');
  await sleep(2);
  await A.reset();
  const backup = JSON.parse(ls().getItem(KEY + ':backup'));
  check('знімок progress:backup містить passed', backup?.exercises?.['m1-d1-01']?.status === 'passed');
  check('на диску порожній стан з resetAt', disk().resetAt && Object.keys(disk().exercises).length === 0);
  await sleep(2);
  B.updateExercise('m1-d1-02', { code: 'після скидання' }); await tick();
  check('стара вкладка B не повернула стерту вправу', !disk().exercises['m1-d1-01'], JSON.stringify(disk().exercises));
  check('…але її зміна після скидання збережена', disk().exercises['m1-d1-02']?.code === 'після скидання');
  check('B тепер «бачила» скидання', B.get().resetAt === disk().resetAt);

  console.log('\n[5] Експорт / імпорт');
  {
    const file = JSON.parse(JSON.stringify({ app: 'vmiko', kind: 'progress', format: 1, state: backup }));
    const r = A.importData(file); await tick();
    check('імпорт повідомляє кількість і зараховані', r.imported === 1 && r.passed === 1, JSON.stringify(r));
    check('імпорт після скидання повернув passed на диск', disk().exercises['m1-d1-01']?.status === 'passed');
    check('імпорт злив, а не замінив (вправа B лишилась)', disk().exercises['m1-d1-02']?.code === 'після скидання');
    await sleep(2);
    B.updateExercise('m1-d1-04', { code: 'b' }); await tick();
    check('стара вкладка B після імпорту не стерла імпортоване', disk().exercises['m1-d1-01']?.status === 'passed');
    let threw = null;
    try { A.importData({ hello: 1 }); } catch (e) { threw = e.message; }
    check('чужий JSON відхилено з поясненням', threw && /не файл прогресу/.test(threw), threw);
    const ex = A.exportData();
    check('експорт: обгортка app/kind/state і копія, а не посилання', ex.app === 'vmiko' && ex.kind === 'progress' && ex.state !== A.get() && ex.state.exercises['m1-d1-01'].status === 'passed');
    check('експорт → імпорт «голого» стану теж приймається', (() => { try { A.importData(ex.state); return true; } catch { return false; } })());
  }

  console.log('\n[6] Пошкоджений запис (QA-02 К2): не падає, копія :broken: одна');
  const cases = [
    ['обрізаний JSON', '{"v":1,"exercises":{"m1-d1-01":{"status":"pas', true],
    ['сміття hello', 'hello', true],
    ['число 42', '42', true],
    ['рядок', '"abc"', true],
    ['масив', '["a"]', true],
    ['exercises: null', '{"v":1,"exercises":null}', true],
    ['exercises: []', '{"v":1,"exercises":[]}', true],
    ['code-об\'єкт і parsons-рядок', '{"v":1,"exercises":{"m1-d1-01":{"status":"passed","code":{"a":1},"parsons":"abc","screen":"x"}}}', true],
    ['__proto__ як id', '{"v":1,"exercises":{"__proto__":{"status":"passed"},"m1-d1-02":{"status":"passed"}}}', true],
    ['null (JSON)', 'null', false],
  ];
  for (const [name, raw, expectBroken] of cases) {
    fresh();
    ls().setItem(KEY, raw);
    let st = null, err = null;
    try { st = await tab(); } catch (e) { err = e; }
    const ok = !err && st && typeof st.get().exercises === 'object' && !Array.isArray(st.get().exercises);
    check(`${name}: старт без помилки, exercises — об'єкт`, ok, err && err.message);
    if (!ok) continue;
    if (expectBroken) {
      const bk = brokenKeys();
      check(`${name}: копія :broken: рівно одна і містить оригінал`, bk.length === 1 && (ls().getItem(bk[0]) === raw || JSON.parse(ls().getItem(bk[0])) !== undefined), bk.join(','));
      check(`${name}: store.brokenKey вказує на копію`, st.brokenKey === bk[0]);
    } else check(`${name}: копії немає (нічого не пошкоджено)`, brokenKeys().length === 0);
    st.updateExercise('m1-d1-09', { code: 'x' }); await tick();
    check(`${name}: після першої дії на диску коректний стан`, typeof disk().exercises === 'object' && !Array.isArray(disk().exercises) && disk().exercises['m1-d1-09']?.code === 'x');
  }
  {
    fresh();
    ls().setItem(KEY, '{"v":1,"exercises":{"m1-d1-01":{"status":"passed","code":{"a":1}}}}');
    const st = await tab();
    check('частково пошкоджена вправа: passed збережено, поле code відкинуто', st.exercise('m1-d1-01').status === 'passed' && !('code' in st.exercise('m1-d1-01')));
    check('__proto__ не змінює прототип', (() => { const n = S.normalize(JSON.parse('{"exercises":{"__proto__":{"status":"passed"}}}')).state; return Object.getPrototypeOf(n.exercises) === Object.prototype && Object.keys(n.exercises).length === 0; })());
    ls().setItem(KEY, 'знову сміття');
    await sleep(2);
    await tab();
    check('друга поломка: копія :broken: все одно одна (перезаписана)', brokenKeys().length === 1 && ls().getItem(brokenKeys()[0]) === 'знову сміття');
  }

  console.log('\n[7] Переповнене сховище (QA-02 С2): помилка доходить до підписника');
  {
    fresh();
    const st = await tab();
    const events = [];
    st.subscribe((s, err, ev) => events.push({ ev, err }));
    ls().quotaFull = true;
    pass(st, 'm1-d3-01'); await tick();
    const last = events[events.length - 1];
    check('підписник отримав save-failed з QuotaExceededError', last && last.ev === 'save-failed' && last.err?.name === 'QuotaExceededError', JSON.stringify(last && last.ev));
    check('describeSaveError: «сховище браузера переповнене»', S.describeSaveError(last.err) === 'сховище браузера переповнене');
    check('store.lastError виставлено', st.lastError?.name === 'QuotaExceededError');
    check('стан у пам\'яті живий (passed)', st.exercise('m1-d3-01').status === 'passed');
    check('прапорець dirty лишився — спроба повториться', st.dirty === true);
    ls().quotaFull = false;
    await st.flushNow();
    check('місце звільнилось → flushNow записав і подія saved без помилки', disk().exercises['m1-d3-01']?.status === 'passed' && events[events.length - 1].ev === 'saved' && events[events.length - 1].err === null && st.lastError === null);
  }
  {
    fresh();
    ls().setItem(KEY, JSON.stringify({ v: 1, exercises: { 'm1-d1-01': { status: 'passed' } } }));
    ls().quotaFull = true; // запис неможливий, але читання працює: прогрес має завантажитись
    const st = await tab();
    check('сховище повне на старті: наявний прогрес усе одно завантажено', st.exercise('m1-d1-01').status === 'passed');
  }
  {
    fresh();
    ls().setItem(KEY, JSON.stringify({ v: 1, exercises: { 'm1-d1-01': { status: 'passed' } } }));
    ls().readFails = true;
    const st = await tab();
    check('читання неможливе: старт без падіння, lastError є', st.lastError?.name === 'SecurityError');
    st.updateExercise('m1-d1-02', { code: 'x' }); await tick();
    ls().readFails = false;
    check('…і диск НЕ перезаписано порожнім станом', disk().exercises['m1-d1-01']?.status === 'passed' && !disk().exercises['m1-d1-02']);
  }

  console.log('\n[8] submitted при старті → in_progress (QA-01 С3, QA-02 Д4)');
  {
    fresh();
    ls().setItem(KEY, JSON.stringify({ v: 1, exercises: { 'm1-d1-01': { status: 'submitted', attempts: 0, updatedAt: '2026-11-21T10:00:00.000Z' }, 'm1-d1-02': { status: 'passed' } } }));
    const st = await tab();
    check('submitted → in_progress у пам\'яті', st.exercise('m1-d1-01').status === 'in_progress');
    check('passed не зачеплено', st.exercise('m1-d1-02').status === 'passed');
    await tick();
    check('виправлений статус записано на диск', disk().exercises['m1-d1-01'].status === 'in_progress', disk().exercises['m1-d1-01'].status);
  }

  console.log('\n[9] Обмеження довжини коду');
  {
    fresh();
    const st = await tab();
    st.updateExercise('m1-d1-01', { code: 'x'.repeat(3_000_000) }); await tick();
    check(`code обрізано до ${S.CODE_MAX}`, st.exercise('m1-d1-01').code.length === S.CODE_MAX && disk().exercises['m1-d1-01'].code.length === S.CODE_MAX);
    check('normalize теж обрізає задовгий код, не вважаючи це поломкою', (() => { const n = S.normalize({ exercises: { a: { status: 'in_progress', code: 'y'.repeat(S.CODE_MAX + 5) } } }); return n.state.exercises.a.code.length === S.CODE_MAX && !n.repaired; })());
  }

  check('storage.js повідомляв про збої в консоль (очікувано в цих сценаріях)', logged.length > 0, logged.length);
  console.log(`\nРазом: ${passed} пройдено, ${failed} провалено`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('ТЕСТ ВПАВ:', e); process.exit(1); });
