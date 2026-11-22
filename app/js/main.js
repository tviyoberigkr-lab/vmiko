/*
 * Vmiko — головний модуль інтерфейсу.
 * Без фреймворків: стан у store (storage.js), рендер — шаблонні рядки, події — делегування.
 * CoLaba Production
 */
import { editorHtml, syncEditor, handleRunShortcut } from './editor.js';
import { LocalStorageAdapter, MemoryAdapter, createProgressStore, describeSaveError } from './storage.js';
import { createDb, ensureServiceWorker } from './db.js';
import { hintAvailability, getHint, aiApplies, AI_LEVEL } from './mentor.js';
import { explainPgError } from './checker.js';

const $app = document.getElementById('app');
const state = { days: [], byId: new Map(), dbStatus: 'idle', dbInfo: null, dbError: null, runResults: {}, checkResults: {}, hintTexts: {}, busy: false };
let store;
let db;

// ------------------------------------------------------------------ утиліти
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** Мінімальна розмітка: **жирний**, `код`, перенос рядка. Спершу екранування — HTML з контенту не виконується. */
function md(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
}
function hashStr(s) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function shuffled(arr, seedStr) {
  let a = hashStr(seedStr);
  const rnd = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const r = arr.slice();
  for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; }
  return r;
}
const STATUS_LABEL = { not_started: 'не почато', in_progress: 'в процесі', submitted: 'перевіряється', passed: 'зроблено', needs_retry: 'спробуй ще' };
const STATUS_ICON = { not_started: '○', in_progress: '◐', submitted: '…', passed: '✓', needs_retry: '↻' };
const TYPE_LABEL = { card: 'Картка', choice: 'Вибір', sql: 'SQL-задача', parsons: 'Збери з блоків', milestone: 'Підсумок' };

function dayProgress(day) {
  const done = day.exercises.filter((e) => store.exercise(e.id).status === 'passed').length;
  return { done, total: day.exercises.length };
}
function nextUnpassed(day, afterIdx = -1) {
  for (let i = afterIdx + 1; i < day.exercises.length; i++) if (store.exercise(day.exercises[i].id).status !== 'passed') return day.exercises[i];
  for (let i = 0; i <= afterIdx; i++) if (store.exercise(day.exercises[i].id).status !== 'passed') return day.exercises[i];
  return null;
}
function continueTarget() {
  const cur = store.get().current;
  if (cur && state.byId.has(cur.exerciseId)) {
    const { day, idx } = state.byId.get(cur.exerciseId);
    if (store.exercise(cur.exerciseId).status !== 'passed') return { day, ex: day.exercises[idx] };
    const n = nextUnpassed(day, idx);
    if (n) return { day, ex: n };
  }
  for (const day of state.days) { const n = nextUnpassed(day); if (n) return { day, ex: n }; }
  return null;
}

// ------------------------------------------------------------------ рендер: головна
function renderHome() {
  const target = continueTarget();
  let cont = '';
  if (target) {
    const st = store.exercise(target.ex.id);
    const idx = target.day.exercises.indexOf(target.ex) + 1;
    let ctx = st.status === 'not_started' ? `Наступна: «${esc(target.ex.title)}»` : `Ти зупинився на «${esc(target.ex.title)}»`;
    ctx += ` · день ${target.day.day}, вправа ${idx} з ${target.day.exercises.length}`;
    if (st.code && st.code.trim() && st.status !== 'passed') ctx += ' · твій код збережено';
    cont = `<section class="continue"><p class="ctx">${ctx}</p><a class="btn primary big" href="#/ex/${target.ex.id}" data-testid="continue">Продовжити</a></section>`;
  } else {
    cont = `<section class="continue"><p class="ctx">Усі вправи виконано (${state.days.length} ${plural(state.days.length, 'день', 'дні', 'днів')}). Повтори будь-яку вправу зі списку нижче.</p></section>`;
  }
  const days = state.days.map((day) => {
    const p = dayProgress(day);
    const items = day.exercises.map((e, i) => {
      const st = store.exercise(e.id).status;
      return `<li class="ex-item st-${st}"><a href="#/ex/${e.id}"><span class="ico" aria-hidden="true">${STATUS_ICON[st]}</span><span class="t">${i + 1}. ${esc(e.title)}</span><span class="meta">${TYPE_LABEL[e.type]} · ${e.minutes} хв</span></a></li>`;
    }).join('');
    const pct = Math.round((p.done / p.total) * 100);
    return `<section class="day">
      <h2>День ${day.day}. ${esc(day.title)}</h2>
      <div class="progress" role="progressbar" aria-valuenow="${p.done}" aria-valuemax="${p.total}"><div style="width:${pct}%"></div></div>
      <p class="pmeta">${p.done} з ${p.total} вправ · ${p.done >= 3 ? 'мінімум дня виконано ✓' : `до мінімуму дня: ${3 - p.done}`}</p>
      <ol class="ex-list">${items}</ol>
    </section>`;
  }).join('');
  $app.innerHTML = `
    <header class="top"><div class="brand">Vmiko</div><div class="db-status" data-testid="db-status">${dbStatusText()}</div></header>
    <main class="home">
      <p class="module">${esc(state.moduleTitle)}</p>
      ${cont}
      ${days}
      <footer class="foot">
        <div class="settings" data-testid="settings">
          <button class="btn" data-act="export" data-testid="export">Зберегти прогрес у файл</button>
          <button class="btn" data-act="import" data-testid="import">Відновити з файлу</button>
        </div>
        <button class="btn link" data-act="reset">Скинути прогрес</button>
        <p class="sig">CoLaba Production</p>
      </footer>
    </main>`;
}

// Повертає HTML (у стані error — з кнопкою «Спробувати ще»); вставляти через innerHTML.
const DB_STAGE = { start: 'готуюсь', engine: 'завантажую рушій бази', 'engine-init': 'запускаю PostgreSQL', data: 'завантажую дані', import: 'імпортую таблиці (лише перший раз)', verify: 'перевіряю базу на пристрої' };
const fmtMb = (b) => (b / 1048576).toFixed(1).replace('.', ',');
function dbStatusText() {
  const p = state.dbProgress;
  switch (state.dbStatus) {
    case 'loading': {
      let s = 'База завантажується' + (p && DB_STAGE[p.stage] ? ': ' + DB_STAGE[p.stage] : '') + '…';
      if (p && p.loaded > 0) s += p.total >= p.loaded ? ` ${fmtMb(p.loaded)} з ${fmtMb(p.total)} МБ (${Math.floor((p.loaded / p.total) * 100)}%)` : ` ${fmtMb(p.loaded)} МБ`;
      return esc(s);
    }
    case 'restarting': return esc(p && p.attempt ? `База перезапускається (спроба ${p.attempt + 1} з 3)…` : 'База перезапускається…');
    case 'ready': return esc(`База готова · ${state.dbInfo ? (state.dbInfo.timings.total / 1000).toFixed(1) + ' с' + (state.dbInfo.fromCache ? ' (з пристрою)' : '') : ''}`);
    case 'error': {
      const e = state.dbError || {};
      const why = e.code === 'stall' ? 'завантаження зупинилось (повільна або перервана мережа)'
        : e.code === 'network' || (typeof navigator !== 'undefined' && navigator.onLine === false) ? 'немає з\'єднання з інтернетом'
        : e.code === 'http' ? 'сервер не віддав файл (' + (e.message || '') + ')'
        : (e.message || 'невідома помилка');
      return `${esc('База не завантажилась: ' + why + '.')} <button class="btn" style="margin-top:6px" data-act="db-retry" data-testid="db-retry">Спробувати ще</button>`;
    }
    default: return '';
  }
}

// ------------------------------------------------------------------ рендер: вправа
function renderExercise(id) {
  const ref = state.byId.get(id);
  if (!ref) { location.hash = '#/'; return; }
  const { day, idx } = ref;
  const ex = day.exercises[idx];
  const st = store.exercise(id);
  if (st.status === 'not_started') store.updateExercise(id, { status: 'in_progress' });
  const cur = store.get().current;
  if (!cur || cur.exerciseId !== id) store.setCurrent(day.id, id);
  const p = dayProgress(day);
  const passed = store.exercise(id).status === 'passed';

  let body = '';
  if (ex.type === 'card') body = cardBody(ex);
  else if (ex.type === 'choice') body = choiceBody(ex);
  else if (ex.type === 'sql') body = sqlBody(ex);
  else if (ex.type === 'parsons') body = parsonsBody(ex);
  else if (ex.type === 'milestone') body = milestoneBody(ex);

  const next = nextUnpassed(day, idx);
  const done = passed ? `<section class="done" data-testid="done">
      <p class="ok">✓ Вправу зараховано</p>
      ${ex.success ? `<p>${md(ex.success)}</p>` : ''}
      ${next ? `<a class="btn primary big" href="#/ex/${next.id}" data-testid="next">Далі</a>` : `<p>День ${day.day} завершено! 🎉</p><a class="btn primary big" href="#/">До плану</a>`}
    </section>` : '';

  $app.innerHTML = `
    <header class="top ex-top">
      <a class="back" href="#/" aria-label="До плану">←</a>
      <div class="ex-pos">День ${day.day} · ${idx + 1} / ${day.exercises.length}</div>
      <div class="db-status small">${state.dbStatus === 'ready' ? '' : dbStatusText()}</div>
    </header>
    <div class="progress thin"><div style="width:${Math.round((p.done / p.total) * 100)}%"></div></div>
    <main class="exercise type-${ex.type}" data-ex="${ex.id}">
      ${ex.project ? `<p class="ex-project" data-testid="project">${esc(ex.project)}</p>` : ''}
      <p class="ex-kind">${TYPE_LABEL[ex.type]} · ~${ex.minutes} хв · <span class="st">${STATUS_LABEL[store.exercise(id).status]}</span></p>
      <h1>${esc(ex.title)}</h1>
      ${body}
      ${done}
    </main>`;
  if (ex.type === 'sql') {
    const ta = $app.querySelector('textarea.sql');
    syncEditor(ta); // не фокусуємо автоматично на телефоні — клавіатура закриває екран
  }
}

function optionsHtml(ex, options, chosen, revealed) {
  return `<div class="options" role="radiogroup">${options.map((o, i) => {
    const sel = chosen === i;
    let cls = 'opt';
    if (sel) cls += ' sel';
    if (revealed && sel) cls += o.correct ? ' right' : ' wrong';
    return `<button class="${cls}" role="radio" aria-checked="${sel}" data-act="choose" data-i="${i}">${md(o.text)}</button>
      ${revealed && sel ? `<p class="explain ${o.correct ? 'right' : 'wrong'}">${md(o.explain)}</p>` : ''}`;
  }).join('')}</div>`;
}

function cardBody(ex) {
  const st = store.exercise(ex.id);
  const screen = Math.min(st.screen || 0, ex.screens.length);
  if (screen < ex.screens.length) {
    return `<div class="card-screen"><p>${md(ex.screens[screen])}</p></div>
      <div class="dots">${ex.screens.map((_, i) => `<span class="${i === screen ? 'on' : ''}"></span>`).join('')}<span class="${screen === ex.screens.length ? 'on' : ''}">?</span></div>
      <div class="actions">${screen > 0 ? '<button class="btn" data-act="screen-prev">Назад</button>' : ''}<button class="btn primary" data-act="screen-next" data-testid="screen-next">Далі</button></div>`;
  }
  const q = ex.question;
  return `<div class="q"><p>${md(q.prompt)}</p>${optionsHtml(ex, q.options, st.choice, st.revealed)}</div>
    <div class="actions"><button class="btn" data-act="screen-prev">Назад до картки</button>
    ${st.status !== 'passed' ? `<button class="btn primary" data-act="check-choice" ${st.choice == null ? 'disabled' : ''}>Перевірити</button>` : ''}</div>`;
}

/** Підсумкова картка модуля: екрани як у картки, наприкінці бейдж і кнопка-завершення (без питання). */
function milestoneBody(ex) {
  const st = store.exercise(ex.id);
  const screen = Math.min(st.screen || 0, ex.screens.length);
  if (screen < ex.screens.length) {
    return `<div class="card-screen"><p>${md(ex.screens[screen])}</p></div>
      <div class="dots">${ex.screens.map((_, i) => `<span class="${i === screen ? 'on' : ''}"></span>`).join('')}<span class="${screen === ex.screens.length ? 'on' : ''}">★</span></div>
      <div class="actions">${screen > 0 ? '<button class="btn" data-act="screen-prev">Назад</button>' : ''}<button class="btn primary" data-act="screen-next" data-testid="screen-next">Далі</button></div>`;
  }
  return `<div class="badge" data-testid="badge"><div class="badge-ico" aria-hidden="true">★</div><p class="badge-title">${esc(ex.badge.title)}</p>${ex.badge.text ? `<p class="badge-text">${esc(ex.badge.text)}</p>` : ''}</div>
    <div class="actions"><button class="btn" data-act="screen-prev">Назад</button>
    ${st.status !== 'passed' ? `<button class="btn primary" data-act="complete" data-testid="complete">${esc(ex.cta)}</button>` : ''}</div>`;
}

function miniTable(t) {
  return `<div class="tbl-wrap"><table class="res"><thead><tr>${t.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
    <tbody>${t.rows.map((r) => `<tr>${r.map((v) => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function choiceBody(ex) {
  const st = store.exercise(ex.id);
  const sandbox = ex.sandbox ? `<div class="sandbox"><pre class="sql-ro">${esc(ex.sandbox)}</pre>
      <button class="btn" data-act="run-sandbox" ${state.dbStatus !== 'ready' ? 'disabled' : ''}>▶ Запустити</button>
      ${resultHtml(state.runResults[ex.id])}</div>` : '';
  return `<p class="prompt">${md(ex.prompt)}</p>
    ${ex.table ? miniTable(ex.table) : ''}
    ${sandbox}
    ${optionsHtml(ex, ex.options, st.choice, st.revealed)}
    <div class="actions">${st.status !== 'passed' ? `<button class="btn primary" data-act="check-choice" ${st.choice == null ? 'disabled' : ''} data-testid="check">Перевірити</button>` : ''}</div>`;
}

const KEYWORDS = ['SELECT', '*', ',', 'FROM', 'WHERE', 'AND', 'OR', "' '", '=', '>', '<', 'LIMIT', '( )', ';',
  'IN', 'BETWEEN', 'ILIKE', 'IS NULL', 'ORDER BY', 'DESC', 'AS', 'COUNT(*)', 'SUM', 'AVG', 'GROUP BY', 'HAVING'];

function sqlBody(ex) {
  const st = store.exercise(ex.id);
  const code = st.code != null ? st.code : (ex.starter || '');
  const ready = state.dbStatus === 'ready';
  return `<p class="prompt">${md(ex.prompt)}</p>
    ${editorHtml(code, 'spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off" data-testid="editor" aria-label="SQL-редактор"', esc)}
    <div class="kbar" aria-label="Ключові слова">${KEYWORDS.map((k) => `<button class="k" data-act="kw" data-k="${esc(k)}">${esc(k)}</button>`).join('')}</div>
    <div class="actions">
      <button class="btn" data-act="run" ${ready && !state.busy ? '' : 'disabled'} data-testid="run">▶ Запустити</button>
      ${st.status !== 'passed' ? `<button class="btn primary" data-act="check-sql" ${ready && !state.busy ? '' : 'disabled'} data-testid="check">Перевірити</button>` : ''}
    </div>
    ${checkHtml(ex.id)}
    ${resultHtml(state.runResults[ex.id])}
    ${hintsHtml(ex)}`;
}

function parsonsBody(ex) {
  const st = store.exercise(ex.id);
  const all = shuffled([...ex.blocks, ...ex.distractors], ex.id);
  const chosen = st.parsons || [];
  const pool = all.filter((b) => !chosen.includes(b));
  const sql = chosen.join(' ');
  const ready = state.dbStatus === 'ready';
  return `<p class="prompt">${md(ex.prompt)}</p>
    <p class="lbl">Твій запит:</p>
    <div class="p-answer" data-testid="p-answer">${chosen.length ? chosen.map((b, i) => `<button class="blk in" data-act="p-out" data-i="${i}">${esc(b)}</button>`).join('') : '<span class="ph">Торкайся блоків нижче по черзі</span>'}</div>
    <p class="lbl">Блоки:</p>
    <div class="p-pool">${pool.map((b) => `<button class="blk" data-act="p-in" data-b="${esc(b)}">${esc(b)}</button>`).join('')}</div>
    <div class="actions">
      <button class="btn" data-act="p-clear" ${chosen.length ? '' : 'disabled'}>Очистити</button>
      <button class="btn" data-act="run" data-sql="parsons" ${ready && chosen.length && !state.busy ? '' : 'disabled'}>▶ Запустити</button>
      ${st.status !== 'passed' ? `<button class="btn primary" data-act="check-parsons" ${ready && chosen.length && !state.busy ? '' : 'disabled'} data-testid="check">Перевірити</button>` : ''}
    </div>
    ${sql ? `<pre class="sql-ro small">${esc(sql)}</pre>` : ''}
    ${checkHtml(ex.id)}
    ${resultHtml(state.runResults[ex.id])}
    ${hintsHtml(ex)}`;
}

function checkHtml(id) {
  const c = state.checkResults[id];
  if (!c) return '';
  if (c.pending) return '<div class="verdict pending">Перевіряю на видимих і перевірочних даних…</div>';
  if (c.ok) return `<div class="verdict ok" data-testid="verdict">✓ ${esc(c.message)}</div>`;
  const err = c.error ? `<p class="pg-hint">${esc(explainPgError(c.error))}</p><pre class="pg-err">${esc(c.error)}</pre>` : '';
  return `<div class="verdict bad" data-testid="verdict">✗ ${esc(c.message)}${err}</div>`;
}

function resultHtml(r) {
  if (!r) return '';
  if (r.pending) return '<div class="result pending">Виконую…</div>';
  if (r.timeout) return '<div class="result err">Запит виконувався занадто довго і був зупинений. Можливо, бракує умови або LIMIT. База перезапускається.</div>';
  if (!r.ok) return `<div class="result err"><p class="pg-hint">${esc(explainPgError(r.error))}</p><pre class="pg-err">${esc(r.error)}</pre></div>`;
  const head = r.fields.map((f) => `<th>${esc(f.name)}</th>`).join('');
  const fmt = (v) => {
    if (v === null) return '<span class="null">NULL</span>';
    if (v instanceof Date) return esc(v.toISOString().replace('T00:00:00.000Z', '').replace('T', ' ').replace('.000Z', ''));
    return esc(v);
  };
  const rows = r.rows.map((row) => `<tr>${row.map((v) => `<td>${fmt(v)}</td>`).join('')}</tr>`).join('');
  return `<div class="result" data-testid="result"><p class="rmeta">${r.rowCount} ${plural(r.rowCount, 'рядок', 'рядки', 'рядків')} · ${r.fields.length} ${plural(r.fields.length, 'колонка', 'колонки', 'колонок')} · ${r.ms} мс${r.truncated ? ' · показано перші 200' : ''}</p>
    <div class="tbl-wrap"><table class="res"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div></div>`;
}
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function hintsHtml(ex) {
  const st = store.exercise(ex.id);
  if (st.status === 'passed') return '';
  const av = hintAvailability(ex, st);
  const texts = state.hintTexts[ex.id] || {};
  const shownList = [];
  const maxShown = Math.min(st.hintsShown || 0, av.length);
  for (let l = 1; l <= maxShown; l++) {
    if (l === AI_LEVEL) {
      // Рівень 4 — ШІ дивиться на код учня; текст не зберігаємо між сесіями, лише в пам'яті сторінки
      const t = texts[AI_LEVEL];
      if (!t) continue;
      shownList.push(`<li class="hint lvl4"><b>Наставник (ШІ):</b> ${md(t)}</li>`);
      continue;
    }
    const t = (ex.hints || [])[l - 1];
    shownList.push(`<li class="hint lvl${l}"><b>Підказка ${l}${l === 3 ? ' (приклад)' : ''}:</b> ${md(t)}</li>`);
  }
  // Повідомлення наставника показуємо й тоді, коли рівень 4 НЕ зарахований показаним
  // (ліміт, бюджет, порожня відповідь, помилка в еталоні вправи): інакше учень не побачив би
  // нічого, а кнопка лишилася б єдиною реакцією на натискання.
  if (texts[AI_LEVEL] && maxShown < AI_LEVEL) {
    shownList.push(`<li class="hint lvl4"><b>Наставник (ШІ):</b> ${md(texts[AI_LEVEL])}</li>`);
  }
  const nextLvl = av.find((h) => !h.shown);
  let btn = '';
  if (nextLvl) {
    if (nextLvl.ai) {
      if (nextLvl.unlocked) btn = `<button class="btn link" data-act="hint" data-l="${AI_LEVEL}" data-testid="hint-ai">Запитати наставника (ШІ)</button>`;
      else btn = `<p class="muted">Наставник (ШІ) подивиться на твій код після підказки 3 і ${nextLvl.needAttempts || 2} ${plural(nextLvl.needAttempts || 2, 'спроби', 'спроб', 'спроб')} перевірки.</p>`;
    } else if (nextLvl.unlocked) btn = `<button class="btn link" data-act="hint" data-l="${nextLvl.level}" data-testid="hint">Підказка ${nextLvl.level}${nextLvl.level === 3 ? ': приклад' : ''}</button>`;
    else if (nextLvl.level === 3) btn = `<p class="muted">Підказка 3 (приклад) відкриється після ${nextLvl.needAttempts} ${plural(nextLvl.needAttempts, 'спроби', 'спроб', 'спроб')} перевірки.</p>`;
  } else if (texts[AI_LEVEL] && aiApplies(ex)) {
    btn = `<button class="btn link" data-act="hint" data-l="${AI_LEVEL}" data-testid="hint-ai">Запитати наставника ще раз</button>`;
  }
  return `<section class="hints"><ol>${shownList.join('')}</ol>${btn}</section>`;
}

// ------------------------------------------------------------------ дії
function currentEx() {
  const el = $app.querySelector('main.exercise');
  if (!el) return null;
  const ref = state.byId.get(el.dataset.ex);
  return ref ? ref.day.exercises[ref.idx] : null;
}
function rerender() { route(); }

async function onClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  const act = b.dataset.act;
  if (act === 'reset') {
    if (confirm('Скинути весь прогрес? Знімок поточного стану збережеться в браузері, але краще спершу натисни «Зберегти прогрес у файл».')) { await store.reset(); state.runResults = {}; state.checkResults = {}; rerender(); }
    return;
  }
  if (act === 'export') { exportProgress(); return; }
  if (act === 'import') { importProgress(); return; }
  const ex = currentEx();
  if (!ex) return;
  const st = store.exercise(ex.id);
  switch (act) {
    case 'screen-next': store.updateExercise(ex.id, { screen: Math.min((st.screen || 0) + 1, ex.screens.length) }); rerender(); break;
    case 'screen-prev': store.updateExercise(ex.id, { screen: Math.max((st.screen || 0) - 1, 0) }); rerender(); break;
    case 'choose':
      if (st.status === 'passed') return;
      store.updateExercise(ex.id, { choice: Number(b.dataset.i), revealed: false });
      rerender(); break;
    case 'check-choice': {
      const opts = ex.type === 'card' ? ex.question.options : ex.options;
      const ok = !!(opts[st.choice] && opts[st.choice].correct);
      store.updateExercise(ex.id, { revealed: true, attempts: (st.attempts || 0) + 1, status: ok ? 'passed' : 'needs_retry', ...(ok ? { passedAt: new Date().toISOString() } : {}) });
      rerender(); break;
    }
    case 'complete': // підсумкова картка (milestone): зараховується натисканням кнопки
      if (ex.type === 'milestone' && st.status !== 'passed') { store.updateExercise(ex.id, { attempts: (st.attempts || 0) + 1, status: 'passed', passedAt: new Date().toISOString() }); rerender(); }
      break;
    case 'kw': insertKeyword(b.dataset.k); break;
    case 'run': await runSql(ex, b.dataset.sql === 'parsons' ? (st.parsons || []).join(' ') : editorCode(ex)); break;
    case 'run-sandbox': await runSql(ex, ex.sandbox); break;
    case 'check-sql': await checkSql(ex, editorCode(ex)); break;
    case 'check-parsons': await checkSql(ex, (st.parsons || []).join(' ')); break;
    case 'p-in': if (st.status !== 'passed') { store.updateExercise(ex.id, { parsons: [...(st.parsons || []), b.dataset.b] }); delete state.checkResults[ex.id]; rerender(); } break;
    case 'p-out': if (st.status !== 'passed') { const a = (st.parsons || []).slice(); a.splice(Number(b.dataset.i), 1); store.updateExercise(ex.id, { parsons: a }); delete state.checkResults[ex.id]; rerender(); } break;
    case 'p-clear': if (st.status !== 'passed') { store.updateExercise(ex.id, { parsons: [] }); delete state.checkResults[ex.id]; rerender(); } break;
    case 'hint': {
      const level = Number(b.dataset.l);
      if (level === AI_LEVEL) {
        if (state.busy) return;
        state.busy = true; b.disabled = true; b.textContent = 'Наставник дивиться твій код…';
        try {
          const h = await getHint(ex, level, { code: mentorCode(ex, st), attempts: st.attempts, lastCheck: state.checkResults[ex.id] });
          state.hintTexts[ex.id] = { ...(state.hintTexts[ex.id] || {}), [AI_LEVEL]: h.text };
          // Ліміт, бюджет, порожня відповідь, таймаут: рівень 4 не вважається показаним і
          // звернення не рахується — учень зможе натиснути ще раз (текст усе одно видно).
          if (!h.error) store.updateExercise(ex.id, { hintsShown: Math.max(st.hintsShown || 0, AI_LEVEL), aiAsks: (st.aiAsks || 0) + 1 });
        } finally { state.busy = false; }
        rerender(); break;
      }
      const h = await getHint(ex, level, { code: mentorCode(ex, st), attempts: st.attempts, lastCheck: state.checkResults[ex.id] });
      state.hintTexts[ex.id] = { ...(state.hintTexts[ex.id] || {}), [level]: h.text };
      store.updateExercise(ex.id, { hintsShown: Math.max(st.hintsShown || 0, level) });
      rerender(); break;
    }
  }
}

/**
 * Код, який бачить наставник. Для Parsons на сторінці немає textarea, тому editorCode повернув би
 * стартовий код, а не відповідь учня — беремо зібрані блоки, як і перевірка (`check-parsons`).
 */
function mentorCode(ex, st) {
  return ex.type === 'parsons' ? (st.parsons || []).join(' ') : editorCode(ex);
}

function editorCode(ex) {
  const ta = $app.querySelector('textarea.sql');
  if (ta) return ta.value;
  const st = store.exercise(ex.id);
  return st.code != null ? st.code : (ex.starter || '');
}

function insertKeyword(k) {
  const ta = $app.querySelector('textarea.sql');
  if (!ta) return;
  let text = k, caretBack = 0;
  if (k === "' '") { text = "''"; caretBack = 1; }
  else if (k === '( )') { text = '()'; caretBack = 1; }
  else if (/^[A-Z]+$/.test(k)) text = k + ' ';
  else if (k === ',') text = ', ';
  else text = k === '*' ? '* ' : ' ' + k + ' ';
  const s = ta.selectionStart, eIdx = ta.selectionEnd;
  ta.value = ta.value.slice(0, s) + text + ta.value.slice(eIdx);
  const pos = s + text.length - caretBack;
  ta.setSelectionRange(pos, pos);
  ta.focus();
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

async function runSql(ex, sql) {
  state.runResults[ex.id] = { pending: true };
  state.busy = true; rerender();
  try {
    state.runResults[ex.id] = await db.run(sql);
  } catch (e) {
    state.runResults[ex.id] = e.code === 'timeout' ? { timeout: true } : { ok: false, error: e.message };
  }
  state.busy = false; rerender();
}

async function checkSql(ex, sql) {
  const st = store.exercise(ex.id);
  if (st.status === 'passed') return; // зараховане не перевіряємо повторно (інакше статус знизився б)
  // submitted пишеться і в сховище; якщо вкладку закриють посеред перевірки, createProgressStore при старті поверне in_progress
  store.updateExercise(ex.id, { status: 'submitted' });
  state.checkResults[ex.id] = { pending: true };
  state.busy = true; rerender();
  let res;
  try {
    res = await db.check(ex, sql);
  } catch (e) {
    res = { ok: false, message: e.code === 'timeout' ? 'Перевірка тривала занадто довго — запит зупинено. Можливо, він обробляє забагато рядків.' : 'Не вдалося перевірити: ' + e.message };
  }
  state.checkResults[ex.id] = res;
  if (res.stage === 'internal') {
    store.updateExercise(ex.id, { status: 'in_progress' }); // не рахуємо спробу — помилка контенту
  } else {
    store.updateExercise(ex.id, { attempts: (st.attempts || 0) + 1, status: res.ok ? 'passed' : 'needs_retry', ...(res.ok ? { passedAt: new Date().toISOString(), solution: sql } : {}) });
  }
  state.busy = false; rerender();
}

function onInput(e) {
  const ta = e.target.closest('textarea.sql');
  if (!ta) return;
  syncEditor(ta);
  const ex = currentEx();
  if (!ex) return;
  const st = store.exercise(ex.id);
  // автозбереження після кожної зміни; статус passed не скидаємо
  store.updateExercise(ex.id, { code: ta.value, status: st.status === 'passed' ? 'passed' : (st.status === 'needs_retry' ? 'needs_retry' : 'in_progress') });
}

// ------------------------------------------------------------------ маршрутизація
function route() {
  const h = location.hash || '#/';
  const m = /^#\/ex\/([\w-]+)/.exec(h);
  // зберегти позицію курсора редактора при перерендері
  const ta = $app.querySelector('textarea.sql');
  const sel = ta && document.activeElement === ta ? [ta.selectionStart, ta.selectionEnd] : null;
  if (m) renderExercise(m[1]); else renderHome();
  if (sel) { const t2 = $app.querySelector('textarea.sql'); if (t2) { t2.focus(); t2.setSelectionRange(sel[0], sel[1]); } }
}

// ------------------------------------------------------------------ збереження: банер, експорт, імпорт (група А)
const saveNotice = { mode: 'local', probeError: null, brokenDismissed: false };

/** Банер над застосунком, якщо прогрес не зберігається або був пошкоджений. Живе поза #app, тож рендер його не стирає. */
function updateSaveBanner() {
  const err = store.lastError || saveNotice.probeError;
  let msg = '';
  let closable = false;
  if (saveNotice.mode === 'memory') msg = 'Прогрес не зберігається: браузер не дає доступу до сховища (можливо, приватний режим). Перед закриттям збережи прогрес у файл.';
  else if (err) msg = `Прогрес не зберігається: ${describeSaveError(err)}. Збережи прогрес у файл, щоб не втратити зроблене.`;
  else if (store.brokenKey && !saveNotice.brokenDismissed) { msg = `Збережений прогрес був пошкоджений — відновлено те, що вдалося. Оригінал лишився в сховищі браузера (${store.brokenKey}).`; closable = true; }
  let el = document.getElementById('save-warn');
  if (!msg) { if (el) el.remove(); return; }
  if (el && el.dataset.msg === msg) return;
  if (!el) {
    el = document.createElement('div');
    el.id = 'save-warn'; el.className = 'save-warn'; el.setAttribute('role', 'alert'); el.dataset.testid = 'save-warn';
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-banner]');
      if (!b) return;
      if (b.dataset.banner === 'export') exportProgress();
      if (b.dataset.banner === 'close') { saveNotice.brokenDismissed = true; updateSaveBanner(); }
    });
    document.body.prepend(el);
  }
  el.dataset.msg = msg;
  el.innerHTML = `<p>${esc(msg)}</p><div class="save-warn-act"><button class="btn" data-banner="export">Експортувати</button>${closable ? '<button class="btn link" data-banner="close">Закрити</button>' : ''}</div>`;
}

function exportProgress() {
  const data = JSON.stringify(store.exportData(), null, 2);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  a.download = `vmiko-progress-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function importProgress() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'application/json,.json';
  inp.addEventListener('change', async () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    try {
      if (f.size > 5_000_000) throw new Error('файл завеликий для прогресу Vmiko.');
      const r = store.importData(JSON.parse(await f.text()));
      alert(`Прогрес відновлено з файлу: вправ — ${r.imported}, з них зараховано — ${r.passed}. Те, що вже було зроблено тут, збережено.`);
      rerender();
    } catch (e) {
      alert('Не вдалося відновити прогрес: ' + (e instanceof SyntaxError ? 'файл пошкоджений або це не JSON.' : e.message));
    }
  });
  inp.click();
}

// ------------------------------------------------------------------ старт
async function boot() {
  // Окремо перевіряємо читання і запис: якщо сховище лише переповнене, наявний прогрес усе одно завантажуємо.
  let adapter;
  try {
    localStorage.getItem('vmiko:progress');
    adapter = new LocalStorageAdapter();
    try { localStorage.setItem('vmiko:probe', '1'); localStorage.removeItem('vmiko:probe'); }
    catch (e) { saveNotice.probeError = e; console.warn('localStorage: запис не вдається', e); }
  } catch (e) {
    adapter = new MemoryAdapter(); saveNotice.mode = 'memory';
    console.warn('localStorage недоступний — прогрес не збережеться після закриття', e);
  }
  store = await createProgressStore(adapter); // битий запис не валить старт: нормалізація + копія :broken:
  store.subscribe((s, err, ev) => { if (ev === 'saved') saveNotice.probeError = null; updateSaveBanner(); });
  updateSaveBanner();
  window.addEventListener('pagehide', () => store.flushNow());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') store.flushNow(); });
  if (saveNotice.mode === 'local') {
    // інша вкладка (або PWA) записала прогрес — зливаємо з нашим, щоб не затерти її зарахування
    window.addEventListener('storage', (e) => {
      if (e.key !== null && e.key !== adapter.fullKey('progress')) return;
      store.reloadFromDisk().then((changed) => { if (changed && !$app.querySelector('textarea.sql:focus')) rerender(); })
        .catch((err) => console.warn('[storage] не вдалося підхопити зміни іншої вкладки', err));
    });
  }

  const index = await fetch('content/index.json').then((r) => r.json());
  state.moduleTitle = index.module;
  for (const d of index.days) {
    const day = await fetch(d.file).then((r) => r.json());
    state.days.push(day);
    day.exercises.forEach((e, idx) => state.byId.set(e.id, { day, idx }));
  }

  // Service worker — ДО старту БД: тоді воркер БД теж під контролем SW і важкі файли кешуються з першого запиту
  // (без подвійного завантаження, див. docs/decisions.md Р9).
  const perf = new URLSearchParams(location.search).has('perf') ? (await import('./perf.js')).startPerfPanel() : null;
  db = createDb({
    visibleUrl: new URL('data/koshyk_visible.json', location.href).href,
    hiddenUrl: new URL('data/koshyk_hidden.json', location.href).href,
    datasetVersion: state.days[0].dataset_version, // однакова для всіх днів (перевіряє tools/test_content.js)
    onStatus: (s, info) => {
      if (perf) perf.onStatus(s, info);
      const progressOnly = s === 'loading' && state.dbStatus === 'loading';
      state.dbStatus = s;
      if (s === 'loading' || s === 'restarting') state.dbProgress = info || null;
      if (s === 'ready') { state.dbInfo = info; window.__vmikoDbInfo = info; }
      if (s === 'error') state.dbError = info;
      if (!progressOnly && !$app.querySelector('textarea.sql:focus')) rerender();
      else {
        // прогрес або курсор у редакторі — не перемальовуємо, лише оновлюємо статус і кнопки
        $app.querySelectorAll('.db-status').forEach((el) => { el.innerHTML = dbStatusText(); });
        const ready = s === 'ready' && !state.busy;
        $app.querySelectorAll('button[data-act="run"], button[data-act="check-sql"]').forEach((b) => { b.disabled = !ready; });
      }
    },
  });
  state.dbStatus = 'loading'; // поки чекаємо SW — інтерфейс уже працює, кнопки SQL неактивні
  ensureServiceWorker('sw.js')
    .then((sw) => { window.__vmikoSw = sw; return db.init(); })
    .catch((e) => console.error('DB init failed', e));
  $app.addEventListener('click', (e) => { if (e.target.closest('[data-act="db-retry"]')) db.retry().catch(() => {}); });

  $app.addEventListener('click', onClick);
  $app.addEventListener('input', onInput);
  $app.addEventListener('keydown', (e) => handleRunShortcut(e, $app));
  window.addEventListener('resize', () => syncEditor($app.querySelector('textarea.sql')));
  window.addEventListener('hashchange', route);
  route();
  window.__vmiko = { store, db, state }; // для автотестів і налагодження

  // service worker реєструється вище, до старту БД (ensureServiceWorker)
}

boot().catch((e) => {
  console.error(e);
  $app.innerHTML = `<main class="fatal"><h1>Не вдалося запустити Vmiko</h1><pre>${esc(e.message)}</pre><p>Спробуйте оновити сторінку.</p></main>`;
});
