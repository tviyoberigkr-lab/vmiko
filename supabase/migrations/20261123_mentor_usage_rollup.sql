-- Vmiko · ШІ-наставник: прибирання денних лічильників (23.11.2026).
-- Аркуш «ДО_ВИПРАВЛЕННЯ_mentor», п. 26: mentor_usage росте без меж.
--
-- Рішення: НЕ просто видаляти старі рядки, а спершу згортати їх у добовий підсумок.
-- Комісія пропонувала cron з видаленням старше 30 днів. Видалення без згортки знищило б
-- цифри пілоту: скільки підказок на день, скільки пристроїв, скільки токенів — саме те,
-- чим вимірюється, чи потрібен наставник узагалі. Детальні рядки «пристрій × доба» після
-- місяця справді не потрібні, добовий підсумок — потрібен завжди і важить ~40 байтів на добу.
--
-- Чому без pg_cron. Розширення в проєкті доступне, але не встановлене, і встановлювати його
-- заради одного прибирання не варто: (1) локальний тестовий стенд на PGlite не має pg_cron,
-- тож міграція перестала б застосовуватись у тестах і ми втратили б перевірку 50 кейсами;
-- (2) у базі без трафіку нема чого прибирати, тож «працює навіть без запитів» — перевага
-- на папері. Беремо той самий підхід, що вже діє для хвилинних відер у mentor_reserve:
-- рідкісний виклик із самого робочого шляху.
--
-- Куди вставлено виклик: у mentor_tokens, а не в mentor_reserve. mentor_reserve — найкритичніша
-- функція (атомарний резерв чотирьох рівнів), її тіло не чіпаємо без потреби. mentor_tokens
-- викликається після кожної відповіді моделі, цього досить: при 200 зверненнях на добу
-- ймовірність 1 % дає ≈2 прибирання на день, а пропущений день при терміні 30 діб не значить нічого.
--
-- CoLaba Production

-- ---------------------------------------------------------------- архів

create table if not exists public.mentor_usage_archive (
  day date primary key,
  devices int not null,           -- скільки різних пристроїв зверталося того дня (рядки 'ip:…' не рахуються)
  calls bigint not null,          -- звернень за добу (так само без 'ip:…', щоб не подвоювати)
  input_tokens bigint not null,
  output_tokens bigint not null,
  archived_at timestamptz not null default now()
);
alter table public.mentor_usage_archive enable row level security;
-- Політик немає навмисно: читає й пише лише service_role (він RLS обходить).

-- ---------------------------------------------------------------- згортка + прибирання

create or replace function public.mentor_usage_rollup(p_keep_days int default 30)
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_cutoff  date := (now() at time zone 'utc')::date - greatest(p_keep_days, 1);
  v_removed int := 0;
begin
  insert into public.mentor_usage_archive (day, devices, calls, input_tokens, output_tokens)
  select u.day,
         (count(*) filter (where u.device_id not like 'ip:%'))::int,
         coalesce(sum(u.calls) filter (where u.device_id not like 'ip:%'), 0),
         coalesce(sum(u.input_tokens), 0),
         coalesce(sum(u.output_tokens), 0)
    from public.mentor_usage u
   where u.day < v_cutoff
   group by u.day
  on conflict (day) do nothing;

  delete from public.mentor_usage where day < v_cutoff;
  get diagnostics v_removed = row_count;
  return v_removed;
end;
$$;

-- ---------------------------------------------------------------- облік токенів + рідкісна згортка

-- Те саме, що було (мова змінена з sql на plpgsql заради умовного виклику згортки).
-- Семантика вставки й злиття не змінена жодним символом.
create or replace function public.mentor_tokens(p_device text, p_in bigint, p_out bigint)
returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.mentor_usage (device_id, day, calls, input_tokens, output_tokens)
  values (p_device, (now() at time zone 'utc')::date, 0, p_in, p_out)
  on conflict (device_id, day) do update
    set input_tokens  = mentor_usage.input_tokens  + excluded.input_tokens,
        output_tokens = mentor_usage.output_tokens + excluded.output_tokens,
        updated_at    = now();

  -- Прибирання замість cron: рідко й дешево. Термін зберігання детальних рядків — 30 діб.
  if random() < 0.01 then
    perform public.mentor_usage_rollup(30);
  end if;
end;
$$;

grant execute on function public.mentor_usage_rollup(int) to service_role;
grant execute on function public.mentor_tokens(text, bigint, bigint) to service_role;
