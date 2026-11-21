/*
 * Замір продуктивності на реальному пристрої: відкрийте застосунок з ?perf=1
 * (наприклад https://…/vmiko/?perf=1) — унизу з'явиться панель. Після «База готова» зробіть скриншот.
 *
 * Показує ЛИШЕ виміряне на цьому пристрої (нічого не оцінює):
 *  - час від відкриття сторінки до готовності бази і розбивку з воркера (pgInit / fetch / load);
 *  - байти з мережі: сторінка + воркер БД + service worker (Resource Timing кожного, transferSize).
 *    Відповіді, які віддав SW, у таймлайні сторінки/воркера мають transferSize 0, а реальний мережевий
 *    запит видно в таймлайні SW — тож сума не рахує байти двічі. Таймлайн SW скидається, коли браузер
 *    його зупиняє (≈30 с простою), — тому знімок робіть одразу після «База готова»;
 *  - пам'ять головного потоку (performance.memory, лише Chrome/Android; пам'ять воркера браузер не дає);
 *  - місце на диску (navigator.storage.estimate: IndexedDB + кеші);
 *  - браузер, пристрій, тип мережі (якщо браузер повідомляє).
 * CoLaba Production
 */
const MB = (b) => (b / 1048576).toFixed(2) + ' МБ';

function pageNet() {
  let transfer = 0, decoded = 0, n = 0;
  for (const r of [...performance.getEntriesByType('navigation'), ...performance.getEntriesByType('resource')]) {
    transfer += r.transferSize || 0; decoded += r.decodedBodySize || 0; n++;
  }
  return { transfer, decoded, n };
}

async function browserLine() {
  const ua = navigator.userAgent;
  let hi = '';
  try {
    if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
      const v = await navigator.userAgentData.getHighEntropyValues(['model', 'platformVersion', 'fullVersionList']);
      const brand = (v.fullVersionList || []).filter((b) => !/Not.?A.?Brand/i.test(b.brand)).map((b) => b.brand + ' ' + b.version).join(', ');
      hi = [brand, v.platform + ' ' + (v.platformVersion || ''), v.model].filter(Boolean).join(' · ');
    }
  } catch (_) {}
  return hi || ua;
}

export function startPerfPanel() {
  const el = document.createElement('div');
  el.setAttribute('data-testid', 'perf-panel');
  el.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9999;max-height:55vh;overflow:auto;background:#111;color:#e8e8e8;font:12px/1.4 ui-monospace,monospace;padding:8px 10px;white-space:pre-wrap;opacity:.95';
  document.body.appendChild(el);
  const s = { dbStatus: 'старт', info: null, readyAt: null, progress: null, browser: '', storage: null, sw: null };
  const askSw = () => {
    const c = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (!c) return;
    const ch = new MessageChannel();
    ch.port1.onmessage = (e) => { s.sw = e.data; };
    c.postMessage({ type: 'vmiko-net-stats' }, [ch.port2]);
  };
  browserLine().then((b) => { s.browser = b; draw(); });

  function draw() {
    const p = pageNet();
    const w = s.info && s.info.net;
    const lines = [];
    lines.push('Vmiko · замір продуктивності (?perf=1) · CoLaba Production');
    lines.push('Статус бази: ' + s.dbStatus + (s.progress ? ` · ${MB(s.progress.loaded)}${s.progress.total ? ' з ' + MB(s.progress.total) : ''}` : ''));
    if (s.readyAt != null) {
      lines.push(`Час до «База готова»: ${(s.readyAt / 1000).toFixed(1)} с від відкриття сторінки`);
      const t = s.info.timings;
      lines.push(`  у воркері: усього ${(t.total / 1000).toFixed(1)} с (рушій ${(t.pgInit / 1000).toFixed(1)}, дані ${(t.fetch / 1000).toFixed(1)}, імпорт ${(t.load / 1000).toFixed(1)})`);
      lines.push(`  ${s.info.fromCache ? 'повторний старт — база з пристрою' : 'перший старт — дані завантажено й імпортовано'}${s.info.persistent ? '' : ' · УВАГА: база лише в пам\'яті'}${s.info.recovered ? ' · базу відновлено' : ''}`);
    }
    lines.push(`Мережа, сторінка: ${MB(p.transfer)} (${p.n} запитів, розпаковано ${MB(p.decoded)})`);
    if (w) lines.push(`Мережа, воркер БД: ${MB(w.transfer)} (${w.requests} запитів, розпаковано ${MB(w.decoded)})`);
    if (s.sw) lines.push(`Мережа, service worker: ${MB(s.sw.transfer)} (${s.sw.requests} запитів)`);
    lines.push(`Разом з мережі: ${MB(p.transfer + (w ? w.transfer : 0) + (s.sw ? s.sw.transfer : 0))}${w ? '' : ' (воркер ще не звітував)'}  · 0 — усе з кешу/пристрою`);
    if (performance.memory) {
      const m = performance.memory;
      lines.push(`Пам'ять JS головного потоку: ${MB(m.usedJSHeapSize)} з ліміту ${MB(m.jsHeapSizeLimit)} (воркер БД сюди не входить)`);
    } else lines.push('Пам\'ять: браузер не повідомляє (performance.memory є лише в Chrome)');
    if (s.storage) lines.push(`Диск (IndexedDB + кеші): ${MB(s.storage.usage || 0)} з ${MB(s.storage.quota || 0)}`);
    const c = navigator.connection;
    lines.push(`Пристрій: ядер ${navigator.hardwareConcurrency || '?'} · RAM ${navigator.deviceMemory ? '≈' + navigator.deviceMemory + ' ГБ' : '?'}${c ? ` · мережа ${c.effectiveType || '?'}${c.downlink ? ' ~' + c.downlink + ' Мбіт/с' : ''}` : ''}`);
    lines.push('Браузер: ' + (s.browser || navigator.userAgent));
    el.textContent = lines.join('\n');
  }

  draw();
  const timer = setInterval(() => { askSw(); draw(); }, 1000);
  return {
    onStatus(st, info) {
      if (st === 'loading') { s.dbStatus = 'завантажується (' + ((info && info.stage) || '') + ')'; s.progress = info && info.loaded ? info : s.progress; }
      else if (st === 'restarting') s.dbStatus = 'перезапуск, спроба ' + ((info && info.attempt) || '');
      else if (st === 'error') s.dbStatus = 'ПОМИЛКА: ' + ((info && info.message) || '');
      else if (st === 'ready') {
        s.dbStatus = 'готова'; s.info = info; s.readyAt = performance.now();
        if (navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then((e) => { s.storage = e; draw(); }).catch(() => {});
        askSw();
        setTimeout(() => { askSw(); setTimeout(() => { clearInterval(timer); draw(); }, 300); }, 3000);
      }
      draw();
    },
  };
}
