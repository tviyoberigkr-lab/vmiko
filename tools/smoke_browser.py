#!/usr/bin/env python3
"""
Наскрізна перевірка застосунку в headless Chrome (Playwright for Python).
Запуск:  python3 tools/smoke_browser.py   (потрібні: pip install playwright; Chrome/Chromium)
Перевіряє: старт PGlite у воркері, виконання SQL у браузері, перевірку на прихованих даних,
Parsons, вибір, автозбереження після перезавантаження, таймаут важкого запиту, офлайн через service worker.
CoLaba Production
"""
import os, re, subprocess, sys, time, json, shutil

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8765
BASE = f"http://localhost:{PORT}/"
CHROME = os.environ.get("CHROME") or shutil.which("google-chrome") or shutil.which("chromium") or shutil.which("chromium-browser")
SHOTS = os.path.join(ROOT, "docs", "screenshots")

passed = failed = 0
def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1; print("  ok   " + name + (f"  ({detail})" if detail else ""))
    else:
        failed += 1; print("  FAIL " + name + (f"  -> {detail}" if detail else ""))

def main():
    os.makedirs(SHOTS, exist_ok=True)
    srv = subprocess.Popen(["node", os.path.join(ROOT, "tools", "serve.js"), str(PORT)], stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    time.sleep(0.8)
    errors = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=CHROME, headless=True, args=["--no-sandbox"])
            ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True, locale="uk-UA")
            page = ctx.new_page()
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
            page.on("pageerror", lambda e: errors.append(str(e)))

            print("\n[1] Старт і завантаження бази")
            t0 = time.time()
            page.goto(BASE)
            page.wait_for_function("window.__vmikoDbInfo !== undefined", timeout=120000)
            info = page.evaluate("window.__vmikoDbInfo")
            check("PGlite стартував у воркері і завантажив обидва набори", info["datasetVersion"] == "koshyk-1.0.0", json.dumps(info["timings"]))
            print(f"      (з відкриття сторінки до готовності бази: {time.time()-t0:.1f} с; persistent={info.get('persistent')}, fromCache={info.get('fromCache')})")
            page.evaluate("window.__vmikoDbInfo = undefined")
            t0 = time.time()
            page.reload()
            page.wait_for_function("window.__vmikoDbInfo !== undefined", timeout=120000)
            info2 = page.evaluate("window.__vmikoDbInfo")
            check("повторний запуск бере базу з IndexedDB (без повторного завантаження)", info2.get("fromCache") is True, json.dumps(info2["timings"]))
            print(f"      (повторний запуск: {time.time()-t0:.1f} с)")
            page.screenshot(path=os.path.join(SHOTS, "01_home.png"), full_page=False)

            print("\n[2] SQL-задача: запуск і перевірка")
            page.goto(BASE + "#/ex/m1-d2-02")
            ed = page.locator("[data-testid=editor]")
            ed.fill("SELECT * FROM customers WHERE city = 'Львів'")
            page.click("[data-testid=run]")
            page.wait_for_selector("[data-testid=result]", timeout=20000)
            meta = page.locator(".rmeta").inner_text()
            check("SQL виконався в браузері, є таблиця результату", "рядк" in meta and "5 колон" in meta, meta)
            page.screenshot(path=os.path.join(SHOTS, "02_sql_run.png"), full_page=False)
            page.click("[data-testid=check]")
            page.wait_for_selector("[data-testid=verdict]", timeout=30000)
            v = page.locator("[data-testid=verdict]").inner_text()
            check("правильний запит зараховано (видимі + приховані дані)", "Правильно" in v, v[:120])
            check("з'явилась кнопка «Далі»", page.locator("[data-testid=next]").count() == 1)
            page.screenshot(path=os.path.join(SHOTS, "03_sql_passed.png"), full_page=True)

            print("\n[3] Неправильні відповіді")
            page.goto(BASE + "#/ex/m1-d2-04")
            page.locator("[data-testid=editor]").fill("SELECT order_id, order_date, total_uah FROM orders WHERE total_uah > 5000")
            page.click("[data-testid=check]")
            page.wait_for_selector("[data-testid=verdict]", timeout=30000)
            v = page.locator("[data-testid=verdict]").inner_text()
            check("запит без умови статусу не зараховано", "✗" in v, v[:120])
            page.locator("[data-testid=editor]").fill("SELECT * FROM customers WHERE city = Львів")
            page.click("[data-testid=run]")
            page.wait_for_selector(".result.err", timeout=20000)
            check("помилка «без лапок» пояснена українською", "лапки" in page.locator(".result.err").inner_text())

            print("\n[4] Автозбереження і повернення в ту саму точку")
            draft = "SELECT order_id, order_date, total_uah\nFROM orders\nWHERE total_uah > 5000 AND -- чернетка"
            page.locator("[data-testid=editor]").fill(draft)
            saved = page.evaluate("JSON.parse(localStorage.getItem('vmiko:progress')).exercises['m1-d2-04'].code")
            check("код записано в localStorage одразу після введення", saved == draft)
            page.goto(BASE)  # «закрили» і відкрили застосунок
            page.reload()
            page.wait_for_selector("[data-testid=continue]")
            href = page.locator("[data-testid=continue]").get_attribute("href")
            ctxline = page.locator(".ctx").inner_text()
            check("«Продовжити» веде на ту саму вправу", href == "#/ex/m1-d2-04", href)
            check("рядок контексту згадує збережений код", "код збережено" in ctxline, ctxline)
            page.click("[data-testid=continue]")
            page.wait_for_selector("[data-testid=editor]")
            page.wait_for_function("window.__vmikoDbInfo !== undefined", timeout=120000)
            check("редактор відновив текст після перезавантаження", page.locator("[data-testid=editor]").input_value() == draft)
            st = page.evaluate("JSON.parse(localStorage.getItem('vmiko:progress')).exercises['m1-d2-04'].status")
            check("статус вправи збережено (needs_retry після невдалої перевірки)", st == "needs_retry", st)
            page.screenshot(path=os.path.join(SHOTS, "04_restored.png"), full_page=False)

            print("\n[5] Підказки")
            page.click("[data-testid=hint]"); page.click("[data-testid=hint]")
            hint3 = page.locator("[data-testid=hint]")
            check("підказки 1–2 відкриті, 3 (ШІ) доступна після 2 спроб", page.locator(".hint").count() == 2)
            page.wait_for_selector("[data-testid=editor]")
            page.locator("[data-testid=editor]").fill("SELECT 1")
            page.click("[data-testid=check]"); page.wait_for_selector("[data-testid=verdict]")
            if page.locator("[data-testid=hint]").count():
                page.click("[data-testid=hint]")
            check("підказка 3 показує заглушку ШІ-наставника", "ШІ-наставник ще не підключений" in page.locator(".hints").inner_text())

            print("\n[6] Parsons (збирання з блоків)")
            page.goto(BASE + "#/ex/m1-d1-06")
            for b in ["SELECT", "product_name, price_uah", "FROM products", "LIMIT 5"]:
                page.locator(".p-pool .blk", has_text=re.compile("^" + re.escape(b) + "$")).first.click()
            ans = page.locator("[data-testid=p-answer]").inner_text().replace("\n", " ")
            check("блоки зібрано у правильному порядку", ans.split() == "SELECT product_name, price_uah FROM products LIMIT 5".split(), ans)
            page.click("[data-testid=check]")
            page.wait_for_selector("[data-testid=verdict]", timeout=30000)
            check("Parsons зараховано виконанням зібраного запиту", "Правильно" in page.locator("[data-testid=verdict]").inner_text())
            page.screenshot(path=os.path.join(SHOTS, "05_parsons.png"), full_page=True)

            print("\n[7] Вибір і картка")
            page.goto(BASE + "#/ex/m1-d1-03")
            page.locator(".opt").nth(1).click(); page.click("[data-testid=check]")
            check("неправильний варіант показує пояснення", page.locator(".explain.wrong").count() == 1)
            page.locator(".opt").nth(2).click(); page.click("[data-testid=check]")
            check("правильний варіант зараховано", page.locator("[data-testid=done]").count() == 1)
            page.goto(BASE + "#/ex/m1-d1-01")
            for _ in range(4): page.click("[data-testid=screen-next]")
            page.locator(".opt").first.click(); page.locator("[data-act=check-choice]").click()
            check("картка: 4 екрани + контрольне питання зараховано", page.locator("[data-testid=done]").count() == 1)
            page.goto(BASE)
            prog = page.locator(".pmeta").first.inner_text()
            check("прогрес дня видно на головній", prog.startswith("3 з 10"), prog)
            page.screenshot(path=os.path.join(SHOTS, "06_home_progress.png"), full_page=True)

            print("\n[8] Захист від зависання (важкий запит)")
            page.goto(BASE + "#/ex/m1-d1-08")
            page.wait_for_function("window.__vmikoDbInfo !== undefined", timeout=120000)  # goto(BASE) вище = повне перезавантаження
            page.locator("[data-testid=editor]").fill("SELECT count(*) FROM order_items a, order_items b")
            t1 = time.time()
            page.click("[data-testid=run]")
            page.wait_for_selector(".result.err", timeout=40000)
            msg = page.locator(".result.err").inner_text()
            check("запит зупинено за таймаутом, інтерфейс живий", "занадто довго" in msg, f"{time.time()-t1:.1f} с")
            page.wait_for_function("document.querySelector('[data-testid=run]') && !document.querySelector('[data-testid=run]').disabled", timeout=120000)
            page.locator("[data-testid=editor]").fill("SELECT count(*) FROM customers")
            page.click("[data-testid=run]")
            page.wait_for_selector("[data-testid=result]", timeout=30000)
            check("після перезапуску база знову працює", "1 рядок" in page.locator(".rmeta").inner_text())

            print("\n[9] Офлайн (service worker)")
            page.goto(BASE)
            page.wait_for_function("navigator.serviceWorker && navigator.serviceWorker.controller !== null", timeout=60000)
            # дочекатися, поки SW докешує важкі файли
            n = 0
            for _ in range(120):
                n = page.evaluate("async () => (await (await caches.open('heavy-pglite-0.5.17-koshyk-1.0.0')).keys()).length")
                if n >= 15: break
                time.sleep(0.5)
            check("service worker закешував PGlite і датасети", n >= 15, f"{n} файлів")
            ctx.set_offline(True)
            page.evaluate("window.__vmikoDbInfo = undefined")
            page.reload()
            page.wait_for_function("window.__vmikoDbInfo !== undefined", timeout=120000)
            page.goto(BASE + "#/ex/m1-d1-08")
            page.locator("[data-testid=editor]").fill("SELECT * FROM customers LIMIT 5")
            page.click("[data-testid=run]")
            page.wait_for_selector("[data-testid=result]", timeout=30000)
            check("без мережі застосунок відкрився і SQL виконується", "5 рядків" in page.locator(".rmeta").inner_text())
            ctx.set_offline(False)
            browser.close()
    finally:
        srv.terminate()
    real_errors = [e for e in errors if "Failed to load resource" not in e and "ERR_INTERNET_DISCONNECTED" not in e]
    check("немає помилок JavaScript у консолі", not real_errors, "; ".join(real_errors[:5]))
    print(f"\nРезультат: {passed} пройдено, {failed} провалено. Скриншоти: {SHOTS}")
    sys.exit(1 if failed else 0)

if __name__ == "__main__":
    main()
