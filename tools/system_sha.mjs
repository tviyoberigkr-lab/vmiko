/*
 * Відбиток SYSTEM-промпту наставника з РЕПОЗИТОРІЮ.
 * Порівнюється з тим, що віддає жива функція на запит {"kind":"version"}.
 * Збігається — у базі крутиться рівно цей промпт; не збігається — деплой відстав або
 * хтось правив промпт мимо репозиторію (таке вже було 23.11.2026, див. ПРОГІН_04).
 * CoLaba Production
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Без аргументів — джерело; `node tools/system_sha.mjs build` — збірка для деплою.
const rel = process.argv[2] === 'build' ? '../build/mentor/index.ts' : '../supabase/functions/mentor/index.ts';
const src = readFileSync(new URL(rel, import.meta.url), 'utf8');
const m = src.match(/const SYSTEM = `([\s\S]*?)`;\n/);
if (!m) { console.error('SYSTEM у файлі не знайдено'); process.exit(1); }
// У коді це шаблонний рядок без підстановок, тож вміст дорівнює тексту промпту один в один.
const system = m[1];
const sha = createHash('sha256').update(system, 'utf8').digest('hex').slice(0, 16);
console.log(`system_sha=${sha} system_chars=${system.length}`);
