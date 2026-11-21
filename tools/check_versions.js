#!/usr/bin/env node
/*
 * Перевірка узгодженості версій і списку кешу service worker: node tools/check_versions.js
 *
 * Навіщо: heavy-кеш SW («спершу кеш») називається за версією PGlite і dataset_version. Якщо оновити
 * датасет або PGlite і забути змінити константи в app/sw.js, учні отримають старі файли з кешу.
 * Цей тест падає, щойно версії розійдуться:
 *  1. app/sw.js: HEAVY_VERSION складено саме з PGLITE_VERSION і DATASET_VERSION;
 *  2. PGLITE_VERSION == app/vendor/pglite/package.json == devDependencies у package.json (Node-тести на тому ж рушії);
 *  3. DATASET_VERSION == dataset_version у кожному дні content/ і в meta обох датасетів app/data/koshyk_*.json;
 *  4. SHELL у sw.js: кожен файл існує; є всі js/*.js, усі дні з content/index.json і всі іконки з manifest;
 *  5. EXPECTED_SIZES у app/js/db-worker.js == реальні розміри pglite.wasm/.data/initdb.wasm і датасетів
 *     (для прогресу «X з Y МБ»; node tools/check_versions.js --write оновлює їх сам).
 * CoLaba Production
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'app');
let failed = 0, passed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log('  ok   ' + name + (detail ? `  (${detail})` : '')); }
  else { failed++; console.log('  FAIL ' + name + (detail ? `  -> ${detail}` : '')); }
}
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const json = (p) => JSON.parse(read(p));

const sw = read('app/sw.js');
const constOf = (name) => { const m = sw.match(new RegExp(`const ${name} = '([^']+)'`)); return m ? m[1] : null; };
const PGLITE = constOf('PGLITE_VERSION');
const DATASET = constOf('DATASET_VERSION');

console.log('\n[1] app/sw.js');
check('PGLITE_VERSION і DATASET_VERSION оголошені', PGLITE && DATASET, `${PGLITE} / ${DATASET}`);
check('HEAVY_VERSION складено з PGLITE_VERSION і DATASET_VERSION',
  /const HEAVY_VERSION = `heavy-pglite-\$\{PGLITE_VERSION\}-\$\{DATASET_VERSION\}`;/.test(sw));

console.log('\n[2] Версія PGlite');
const vendorVer = json('app/vendor/pglite/package.json').version;
check('vendor/pglite == PGLITE_VERSION у sw.js', vendorVer === PGLITE, `vendor ${vendorVer}, sw ${PGLITE}`);
const dev = (json('package.json').devDependencies || {})['@electric-sql/pglite'];
check('package.json devDependencies == vendor (Node-тести на тому ж рушії, що й браузер)', dev && dev.replace(/^[~^]/, '') === vendorVer, `package.json ${dev}`);

console.log('\n[3] Версія датасету');
const index = json('app/content/index.json');
const dayVers = index.days.map((d) => [d.file, json('app/' + d.file).dataset_version]);
const bad = dayVers.filter(([, v]) => v !== DATASET);
check(`dataset_version у ${dayVers.length} днях == DATASET_VERSION`, bad.length === 0, bad.map(([f, v]) => `${f}: ${v}`).join('; ') || DATASET);
if (index.dataset_version !== undefined) check('content/index.json dataset_version == DATASET_VERSION', index.dataset_version === DATASET, index.dataset_version);
for (const f of ['koshyk_visible.json', 'koshyk_hidden.json']) {
  const head = Buffer.alloc(2048);
  const fd = fs.openSync(path.join(APP, 'data', f), 'r'); fs.readSync(fd, head, 0, 2048, 0); fs.closeSync(fd);
  const m = head.toString('utf8').match(/"dataset_version"\s*:\s*"([^"]+)"/);
  check(`meta.dataset_version у data/${f} == DATASET_VERSION`, m && m[1] === DATASET, m ? m[1] : 'не знайдено');
}

console.log('\n[4] Список SHELL у sw.js');
const shellSrc = sw.match(/const SHELL = \[([\s\S]*?)\];/);
const shell = shellSrc ? [...shellSrc[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
check('SHELL знайдено', shell.length > 0, `${shell.length} файлів`);
const missingFiles = shell.filter((f) => f !== './' && !fs.existsSync(path.join(APP, f)));
check('кожен файл зі SHELL існує', missingFiles.length === 0, missingFiles.join(', '));
const jsFiles = fs.readdirSync(path.join(APP, 'js')).filter((f) => f.endsWith('.js')).map((f) => 'js/' + f);
const noJs = jsFiles.filter((f) => !shell.includes(f));
check('усі app/js/*.js є в SHELL (інакше офлайн зламається)', noJs.length === 0, noJs.join(', '));
const noDays = index.days.map((d) => d.file).filter((f) => !shell.includes(f));
check('усі дні з content/index.json є в SHELL', noDays.length === 0, noDays.join(', '));
const icons = (json('app/manifest.webmanifest').icons || []).map((i) => i.src.replace(/^\.\//, ''));
const noIcons = icons.filter((f) => !shell.includes(f));
check('усі іконки з manifest є в SHELL', noIcons.length === 0, noIcons.join(', '));

console.log('\n[5] Очікувані розміри важких файлів у db-worker.js (для прогресу «X з Y МБ»)');
const workerPath = path.join(APP, 'js', 'db-worker.js');
const worker = fs.readFileSync(workerPath, 'utf8');
const sizeOf = (p) => fs.statSync(path.join(APP, p)).size;
const actual = { 'pglite.wasm': sizeOf('vendor/pglite/pglite.wasm'), 'pglite.data': sizeOf('vendor/pglite/pglite.data'), 'initdb.wasm': sizeOf('vendor/pglite/initdb.wasm'), visible: sizeOf('data/koshyk_visible.json'), hidden: sizeOf('data/koshyk_hidden.json') };
const sm = worker.match(/const EXPECTED_SIZES = (\{[^\n]*\});/);
const declared = sm ? JSON.parse(sm[1]) : null;
const sizesOk = declared && Object.keys(actual).every((k) => declared[k] === actual[k]);
if (!sizesOk && process.argv.includes('--write') && sm) {
  fs.writeFileSync(workerPath, worker.replace(sm[0], `const EXPECTED_SIZES = ${JSON.stringify(actual)};`));
  console.log('  записано нові розміри в app/js/db-worker.js');
  check('EXPECTED_SIZES оновлено (--write)', true);
} else {
  check('EXPECTED_SIZES == реальні розміри файлів', sizesOk, sizesOk ? '' : `треба ${JSON.stringify(actual)} — запустіть з --write`);
}

console.log(`\nРезультат: ${passed} пройдено, ${failed} провалено.`);
process.exit(failed ? 1 : 0);
