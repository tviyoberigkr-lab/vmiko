/*
 * Підсвічування синтаксису SQL: прозорий <textarea> поверх <pre> з розфарбованою копією тексту.
 * Без залежностей. Текст і курсор лишаються рідними (textarea), тож клавіатура, виділення,
 * автозбереження й автокорекція телефонів працюють як раніше. Див. docs/decisions.md, Р7.
 * CoLaba Production
 */
const WORDS = new Set(('SELECT FROM WHERE GROUP BY HAVING ORDER LIMIT JOIN ON AS AND OR NOT IN BETWEEN LIKE ILIKE IS NULL ' +
  'CASE WHEN THEN ELSE END DISTINCT COUNT SUM AVG MIN MAX DATE_TRUNC COALESCE NULLIF WITH OVER PARTITION ' +
  'LEFT RIGHT INNER OUTER FULL CROSS USING UNION ALL ASC DESC OFFSET TRUE FALSE').split(' '));
const TOKEN = /(--[^\n]*)|('(?:[^']|'')*'?)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z_0-9]*)/g;

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Текст -> HTML зі span-ами. Довжина видимого тексту не змінюється (вирівнювання з textarea). */
export function highlight(code) {
  let out = '', last = 0, m;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(code))) {
    let cls = null;
    if (m[1]) cls = 'c';
    else if (m[2]) cls = 's';
    else if (m[3]) cls = 'n';
    else if (WORDS.has(m[4].toUpperCase())) cls = 'k';
    out += esc(code.slice(last, m.index));
    out += cls ? `<span class="t-${cls}">${esc(m[0])}</span>` : esc(m[0]);
    last = m.index + m[0].length;
  }
  // завершальний пробіл, щоб остання порожня стрічка мала висоту в <pre>
  return out + esc(code.slice(last)) + '\n ';
}

/** HTML редактора (для шаблону main.js). attrs — готовий рядок атрибутів textarea. */
export function editorHtml(code, attrs, escFn) {
  return `<div class="sqled"><pre class="sqled-hl" aria-hidden="true">${highlight(code)}</pre>` +
    `<textarea class="sql" ${attrs}>${escFn(code)}</textarea></div>`;
}

/** Підігнати висоту textarea під текст і оновити підсвічування. */
export function syncEditor(ta) {
  if (!ta) return;
  const pre = ta.previousElementSibling;
  if (pre && pre.classList.contains('sqled-hl')) pre.innerHTML = highlight(ta.value);
  ta.style.height = 'auto';
  ta.style.height = (ta.scrollHeight + ta.offsetHeight - ta.clientHeight) + 'px';
}

/** Ctrl/Cmd+Enter у редакторі = «Запустити». Повертає true, якщо подію оброблено. */
export function handleRunShortcut(e, root) {
  if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey) || !e.target.matches || !e.target.matches('textarea.sql')) return false;
  e.preventDefault();
  const btn = root.querySelector('[data-act="run"]');
  if (btn && !btn.disabled) btn.click();
  return true;
}
