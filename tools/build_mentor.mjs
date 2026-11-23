/*
 * Збирає з supabase/functions/mentor/index.ts той самий файл без РЯДКОВИХ коментарів:
 * build/mentor/index.ts. Потрібен лише через інструмент деплою — він приймає вміст файлу
 * текстом в одному виклику, і повний файл (54 КБ) туди вже не влазить.
 *
 * Що саме прибирається: рядки, які цілком є коментарем (// …, /* … *\/, * …).
 * Код, рядкові літерали й кінцеві коментарі в рядку з кодом не чіпаються, а все, що
 * всередині багаторядкових шаблонів (SYSTEM, SCHEMA, user), не чіпається взагалі —
 * інакше можна було б зіпсувати промпт.
 *
 * Перевірка збірки: node tools/system_sha.mjs і node tools/system_sha.mjs build мусять дати
 * однаковий відбиток, а тести — пройти проти збірки (MENTOR_SRC=build/mentor/index.ts).
 * CoLaba Production
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const src = readFileSync(path.join(ROOT, 'supabase/functions/mentor/index.ts'), 'utf8');

const lines = src.split('\n');
const out = [];
let inTemplate = false, inBlock = false;
for (const line of lines) {
  const t = line.trim();
  // Непроекранований бекквот перемикає стан «усередині шаблону».
  const ticks = (line.match(/(^|[^\\])`/g) || []).length;

  if (!inTemplate) {
    if (inBlock) { if (t.endsWith('*/')) inBlock = false; continue; }
    if (t.startsWith('/*') && !t.endsWith('*/')) { inBlock = true; continue; }
    if (t.startsWith('/*') || t.startsWith('//')) continue;
    if (t === '') { if (out.length && out[out.length - 1] !== '') out.push(''); if (ticks % 2) inTemplate = !inTemplate; continue; }
  }
  out.push(line);
  if (ticks % 2) inTemplate = !inTemplate;
}

const text = out.join('\n');
mkdirSync(path.join(ROOT, 'build/mentor'), { recursive: true });
writeFileSync(path.join(ROOT, 'build/mentor/index.ts'), text);
console.log(`build/mentor/index.ts: ${text.length} символів (було ${src.length})`);
