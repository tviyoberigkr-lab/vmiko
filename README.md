# Vmiko — навчання дата-аналітики через практику

Україномовний застосунок (PWA): SQL-вправи по 3–7 хвилин просто в браузері, з перевіркою на прихованих даних.
Зараз це прототип: модуль М1, дні 1–2 (21 вправа), датасет D1 «Кошик».

- Специфікація треку: `docs/track_data_analyst.md`
- Схема бази «Кошик»: `docs/schema_koshyk.md`
- Чому зроблено саме так (і зауваження до спеки): `docs/decisions.md`
- Що готово, що далі, відомі проблеми: `docs/status.md`

---

## 1. Запустити на своєму комп'ютері

Потрібен **Node.js** (версія 20 або новіша): завантажте з https://nodejs.org (кнопка «LTS») і встановіть, як звичайну програму.

1. Відкрийте папку проєкту `vmiko` у терміналі.
   Windows: відкрийте папку в Провіднику, клацніть в адресному рядку, наберіть `cmd` і натисніть Enter.
2. Наберіть:
   ```
   node tools/serve.js
   ```
3. Відкрийте в браузері **http://localhost:8080**.
4. Щоб зупинити сервер — у терміналі натисніть `Ctrl + C`.

Просто відкрити `app/index.html` подвійним кліком **не вийде**: браузер не запускає базу даних з файлів на диску. Потрібен сервер із кроку 2.

Подивитися з телефона в тій самій Wi-Fi мережі можна, але офлайн-режим і встановлення на головний екран там не запрацюють (вони потребують https) — для цього є GitHub Pages (розділ 2).

## 2. Опублікувати в інтернеті (GitHub Pages) — один раз

1. Зареєструйтесь на https://github.com (якщо ще немає акаунта).
2. Створіть репозиторій: кнопка **New** → назва, наприклад `vmiko` → **Public** → **Create repository**.
3. Завантажте файли проєкту. Найпростіше — встановити **GitHub Desktop** (https://desktop.github.com): *File → Add local repository* → оберіть папку `vmiko` → **Publish repository**.
   (Через веб-інтерфейс можна, але там ліміт 100 файлів за раз, а у `app/vendor/pglite` великі файли — краще GitHub Desktop.)
4. На сторінці репозиторію: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
5. Відкрийте вкладку **Actions** і дочекайтеся зеленої галочки «Deploy to GitHub Pages» (1–2 хв).
6. Адреса сайту з'явиться в **Settings → Pages**, наприклад `https://ваш-логін.github.io/vmiko/`.

Далі будь-яка зміна, надіслана в гілку `main` (у GitHub Desktop: **Commit** → **Push**), публікується автоматично. Налаштування цього — у `.github/workflows/pages.yml`: він публікує тільки папку `app/`.

## 3. Перевірки (для розробника)

```
npm install                      # один раз: ставить PGlite для тестів
node tools/test_gen.js           # генератор датасету: обсяги, закладені інсайти, частка дублікатів
node tools/test_checker.js       # порівняння результатів SQL (модульні + на справжньому Postgres)
node tools/test_content.js       # уроки: еталони на обох наборах, стартовий код, блоки Parsons
python3 tools/smoke_browser.py   # застосунок у headless Chrome (потрібен pip install playwright і Chrome)
```

## 4. Як влаштовано

```
app/                      ← це і є сайт (його публікує GitHub Pages)
  index.html, css/, icons/, manifest.webmanifest, sw.js (офлайн)
  js/main.js              інтерфейс: план дня, вправи 4 типів, підказки
  js/storage.js           збереження прогресу (зараз localStorage; потім підміняється на Supabase)
  js/db.js, db-worker.js  PostgreSQL (PGlite) в окремому потоці, таймаут 10 с
  js/sqlrunner.js         безпечне виконання запиту учня, завантаження датасету
  js/checker.js           порівняння результату учня з еталоном
  js/mentor.js            ШІ-наставник — поки заглушка (підказки рівнів 1–2 від автора працюють)
  content/                уроки у форматі JSON
  data/                   датасети JSON (видимий і прихований) — генеруються
  vendor/pglite/          PGlite 0.5.17 (копія з npm; Apache 2.0)
data/                     ті самі датасети в SQL (CREATE TABLE + INSERT) — для pgAdmin/DBeaver
tools/                    генератор, тести, локальний сервер
docs/                     специфікація, схема, рішення, статус, скриншоти
```

### Оновити датасет
Змінили `tools/gen_koshyk.js` → підніміть `DATASET_VERSION` → `node tools/gen_koshyk.js` → оновіть версію у `docs/schema_koshyk.md`, у `dataset_version` уроків і в `HEAVY_VERSION` у `app/sw.js` → запустіть тести.

### Оновити PGlite
`npm install @electric-sql/pglite@НОВА_ВЕРСІЯ` → `node tools/vendor_pglite.js` → оновіть `HEAVY_VERSION` і список файлів `chunk-*.js` у `app/sw.js` → запустіть `tools/smoke_browser.py`.

### Формат вправи (у `app/content/m1/dayN.json`)

| Поле | Для типів | Значення |
|---|---|---|
| `id`, `type`, `title`, `minutes` (1–7), `device` (`any`/`prefer_desktop`) | усі | `type`: `card`, `choice`, `sql`, `parsons` |
| `screens` + `question{prompt, options}` | card | 1–5 екранів і контрольне питання |
| `prompt`, `options[{text, correct, explain}]`, `sandbox?`, `table?` | choice | пояснення має кожен варіант; `sandbox` — запит, який можна запустити; `table` — маленька таблиця для «передбач результат» |
| `prompt`, `starter`, `reference`, `check?`, `hints[2]`, `success?`, `starterPasses?` | sql | `reference` — еталонний запит |
| `blocks` (правильний порядок), `distractors`, `reference`, `check?`, `hints` | parsons | блоки показуються перемішаними |
| `check.mode: "subset"`, `rowCount`, `referenceFull` | sql/parsons | для `LIMIT` без `ORDER BY` |
| `check.ordered`, `check.orderKey`, `check.tolerance`, `check.checkColumnNames` | sql/parsons | тонке налаштування перевірки, див. `docs/decisions.md` (Р4) |

*CoLaba Production*
