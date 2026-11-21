#!/usr/bin/env node
/*
 * Копіює потрібні браузеру файли PGlite з node_modules у app/vendor/pglite/.
 * Запускати лише при оновленні версії PGlite (npm install, потім npm run vendor).
 * Результат комітиться в репозиторій — сайт працює без збирання.
 * CoLaba Production
 */
'use strict';
const fs = require('fs');
const path = require('path');
const src = path.join(__dirname, '..', 'node_modules', '@electric-sql', 'pglite');
const dst = path.join(__dirname, '..', 'app', 'vendor', 'pglite');
if (!fs.existsSync(src)) { console.error('Немає node_modules/@electric-sql/pglite — спершу виконайте: npm install'); process.exit(1); }
fs.rmSync(dst, { recursive: true, force: true });
fs.mkdirSync(path.join(dst, 'fs'), { recursive: true });
const dist = path.join(src, 'dist');
let n = 0, bytes = 0;
const copy = (from, to) => { fs.copyFileSync(from, to); n++; bytes += fs.statSync(to).size; };
for (const f of fs.readdirSync(dist)) {
  if ((f === 'index.js' || /^chunk-.*\.js$/.test(f)) || ['pglite.wasm', 'pglite.data', 'initdb.wasm'].includes(f)) copy(path.join(dist, f), path.join(dst, f));
}
for (const f of fs.readdirSync(path.join(dist, 'fs'))) if (/\.js$/.test(f)) copy(path.join(dist, 'fs', f), path.join(dst, 'fs', f));
for (const f of ['LICENSE', 'package.json']) if (fs.existsSync(path.join(src, f))) copy(path.join(src, f), path.join(dst, f));
const ver = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8')).version;
fs.writeFileSync(path.join(dst, 'VERSION.txt'), `@electric-sql/pglite ${ver}\nСкопійовано tools/vendor_pglite.js\n`);
console.log(`PGlite ${ver}: скопійовано ${n} файлів, ${(bytes / 1048576).toFixed(1)} МБ -> ${dst}`);
