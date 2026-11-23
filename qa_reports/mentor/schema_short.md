# D1 «Кошик» — схема бази даних

Версія датасету: **koshyk-1.0.0** (константа `DATASET_VERSION` у `tools/gen_koshyk.js`).
Генератор: `tools/gen_koshyk.js` · тести: `tools/test_gen.js`.

Український інтернет-магазин побутової техніки та дрібниць. Гроші — у гривнях (UAH). Діалект SQL — PostgreSQL.

## Набори

| Набір | seed | Масштаб | Клієнтів | Замовлень | Позицій | Де лежить |
|---|---|---|---|---|---|---|
| Видимий (`visible`) | 20251101 | 1.0 | 20 000 | ≈69 600 | ≈88 500 | `data/koshyk_visible.sql`, `app/data/koshyk_visible.json`; у застосунку — схема `public` |
| Прихований перевірочний (`hidden`) | 777013 | 0.3 | 6 000 | ≈21 000 | ≈26 800 | `data/koshyk_hidden.sql`, `app/data/koshyk_hidden.json`; у застосунку — схема `hidden` |

Схема (таблиці, колонки, типи) однакова; значення різні; закладені закономірності ті самі. Точні кількості рядків друкує `node tools/gen_koshyk.js`.

## Таблиці

### `customers` — клієнти

| Колонка | Тип | Опис |
|---|---|---|
| `customer_id` | integer, PK | Ідентифікатор клієнта |
| `full_name` | text | Ім'я та прізвище (вигадані) |
| `city` | text | Місто українською: «Київ», «Львів», «Івано-Франківськ»… (24 міста) |
| `registered_at` | date | Дата реєстрації (2023-09 … 2026-09) |
| `acquisition_channel` | text | Канал залучення: `organic`, `google_ads`, `instagram`, `telegram`, `referral`, `email` |

### `products` — товари

| Колонка | Тип | Опис |
|---|---|---|
| `product_id` | integer, PK | Ідентифікатор товару |
| `product_name` | text | Назва, напр. «Павербанк Baseus Pro 20000 мАг 42» |
| `category` | text | Одна з 15 категорій: «Павербанки», «Навушники», «Електрочайники», «Пилососи», «Блендери», «Кавоварки», «Смарт-годинники», «Зарядні пристрої», «Кабелі та адаптери», «Освітлення», «Праски», «Мікрохвильовки», «Фени», «Ваги», «Кухонне приладдя» |
| `brand` | text | Бренд: Xiaomi, Philips, Bosch, Tefal, Samsung, Baseus, Anker, JBL, Rowenta, Gorenje, 2E, Gelius, Vinga, Ardesto |
| `price_uah` | integer | Поточна ціна, ціле число гривень |
| `cost_uah` | integer | Собівартість, ціле число гривень |

`price_uah` і `cost_uah` навмисно **цілі** — на них працює пастка М1 день 5: `(price_uah - cost_uah) / price_uah` дає 0, правильно — `::numeric`.
