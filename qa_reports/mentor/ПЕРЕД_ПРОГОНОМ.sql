-- Vmiko · що треба зробити в базі ПЕРЕД повторним прогоном наставника (п.21 аркуша).
-- Підготовлено Маяком 23.11.2026. Застосовувати одним блоком, із підтвердженням власника.
--
-- Чому це потрібно саме зараз:
--  1) таблиця qa_mentor_runs не має колонок stop_reason, content_types, truncated, reason —
--     а критерій приймання прогону прямо вимагає «0 обрізаних» і «0 порожніх». Без цих колонок
--     ми б знову оцінювали на око (п.1 аркуша був виконаний лише наполовину);
--  2) дозвіл на анонімний запис був навмисно знешкоджений після першого прогону
--     (`with check (false)`), щоб сторінка не лишалася відкритою дірою. На час прогону його
--     треба повернути, після прогону — знову закрити (див. ПІСЛЯ_ПРОГОНУ.sql).

alter table public.qa_mentor_runs
  add column if not exists stop_reason   text,
  add column if not exists content_types text,
  add column if not exists truncated     boolean,
  add column if not exists reason        text;   -- причина відмови при 429 (device_limit, ip_burst…)

-- Повернути запис зі сторінки прогону. Політика вже існує, міняємо лише умову.
alter policy qa_insert_anon on public.qa_mentor_runs with check (true);
