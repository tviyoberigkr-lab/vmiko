-- Vmiko · ШІ-наставник: чотири рівні лімітів і грошовий бюджет (22.11.2026).
-- Аркуш «ДО_ВИПРАВЛЕННЯ_mentor», п. 13–14 + рішення власника (чотири рівні, а не одна глобальна стеля).
--
-- Рівні захисту (усі перевіряються й резервуються в ОДНІЙ транзакції public.mentor_reserve):
--   1) пристрій: 200 звернень/добу;
--   2) IP: 500/добу + швидкісний 10/хв (ключ 'ip:<16 hex sha256>', без заголовка — 'ip:unknown');
--   3) стеля витрат одного пристрою: 3 % денного бюджету ($0.09) — страховка на випадок дорожчої моделі;
--   4) глобальний бюджет на добу (за замовчуванням $3), ОДИН поріг 100 % — далі відмова всім.
--
-- Облік коштів: ціни передає функція (Haiku 5.5 — $0.10 вхід / $0.50 вихід за млн токенів,
-- перевірено 22.11.2026). Токени пишуться ЛИШЕ в рядок пристрою; рядки з ключем 'ip:…' тримають
-- тільки лічильник calls, тому сума токенів за добу не подвоюється.
--
-- Застосовано Маяком 22.11.2026 після перевірки коду й правки рівня 3.
-- CoLaba Production

-- ---------------------------------------------------------------- таблиці

-- Денні лічильники. Таблиця вже існує (20261122_mentor_usage.sql); тут лише те, чого бракувало.
create table if not exists public.mentor_usage (
  device_id text not null,
  day date not null default (now() at time zone 'utc')::date,
  calls int not null default 0,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (device_id, day)
);
alter table public.mentor_usage enable row level security;

-- Для добового бюджету потрібна сума по всіх рядках за день.
create index if not exists mentor_usage_day_idx on public.mentor_usage (day);

-- Швидкісний ліміт на IP: окрема таблиця з хвилинними відрами.
create table if not exists public.mentor_ip_burst (
  ip_key text not null,
  minute timestamptz not null,
  calls int not null default 0,
  primary key (ip_key, minute)
);
alter table public.mentor_ip_burst enable row level security;
create index if not exists mentor_ip_burst_minute_idx on public.mentor_ip_burst (minute);

-- ---------------------------------------------------------------- бюджет за добу

-- Скільки грошей витрачено сьогодні (для моніторингу й алертів).
create or replace function public.mentor_global_today(p_price_in numeric, p_price_out numeric)
returns table (spent_usd numeric, calls bigint, input_tokens bigint, output_tokens bigint)
language sql security definer set search_path = public as $$
  select
    coalesce(sum(u.input_tokens) * p_price_in + sum(u.output_tokens) * p_price_out, 0) / 1000000.0,
    -- рядки 'ip:…' дублюють ті самі виклики, тому в лічильник їх не беремо
    coalesce(sum(u.calls) filter (where u.device_id not like 'ip:%'), 0),
    coalesce(sum(u.input_tokens), 0),
    coalesce(sum(u.output_tokens), 0)
  from public.mentor_usage u
  where u.day = (now() at time zone 'utc')::date;
$$;

-- ---------------------------------------------------------------- атомарний резерв слота

-- Повертає allowed=false і reason, якщо хоч один рівень не пройдено; інакше слот уже зарезервовано
-- (calls збільшено) — щоб паралельні запити не проскочили повз ліміт.
-- reason: 'budget' | 'device_share' | 'device_limit' | 'ip_limit' | 'ip_burst'
create or replace function public.mentor_reserve(
  p_device        text,
  p_ip            text,      -- ключ 'ip:<16 hex>'; NULL або '' — рівень 2 пропускається
  p_device_limit  int,
  p_ip_limit      int,
  p_ip_burst      int,
  p_budget_usd    numeric,
  p_device_share  numeric,   -- 0.03 — частка ДЕННОГО БЮДЖЕТУ, доступна одному пристрою
  p_device_floor_usd numeric,  -- не використовується з 22.11.2026 (лишено для сумісності виклику)
  p_price_in      numeric,
  p_price_out     numeric
) returns table (
  allowed boolean, reason text, device_calls int, ip_calls int, spent_usd numeric, budget_usd numeric
)
language plpgsql security definer set search_path = public as $$
declare
  v_today        date := (now() at time zone 'utc')::date;
  v_minute       timestamptz := date_trunc('minute', now());
  v_spent        numeric := 0;
  v_dev_spent    numeric := 0;
  v_dev_cap      numeric := 0;
  v_dev_calls    int := 0;
  v_ip_calls     int := 0;
  v_burst        int := 0;
begin
  -- рівень 4: скільки вже витрачено сьогодні
  select coalesce(sum(u.input_tokens) * p_price_in + sum(u.output_tokens) * p_price_out, 0) / 1000000.0
    into v_spent
    from public.mentor_usage u
    where u.day = v_today;

  if v_spent >= p_budget_usd then
    return query select false, 'budget'::text, 0, 0, v_spent, p_budget_usd;
    return;
  end if;

  -- що ми вже знаємо про цей пристрій сьогодні
  select u.calls, (u.input_tokens * p_price_in + u.output_tokens * p_price_out) / 1000000.0
    into v_dev_calls, v_dev_spent
    from public.mentor_usage u
    where u.device_id = p_device and u.day = v_today;
  v_dev_calls := coalesce(v_dev_calls, 0);
  v_dev_spent := coalesce(v_dev_spent, 0);

  -- рівень 3: стеля витрат одного пристрою — частка від ДЕННОГО БЮДЖЕТУ, не від уже витраченого.
  -- Правка Маяка 22.11.2026 після заперечення виконавця: частка від витраченого
  -- вимагала нижньої планки і при поточних цінах не спрацьовувала ніколи
  -- (200 викликів Haiku ≈ $0.07 < 3 % будь-якої бази). Частка від бюджету передбачувана:
  -- $3 × 3 % = $0.09. На Haiku рівень 1 (200 викликів) упреться раніше — це нормально,
  -- рівень 3 тут страховка на випадок дорожчої моделі: на Sonnet один виклик ≈ $0.007,
  -- і 200 викликів з'їли б 47 % бюджету, а ця стеля зупинить пристрій на ~13.
  v_dev_cap := p_device_share * p_budget_usd;
  if v_dev_spent >= v_dev_cap then
    return query select false, 'device_share'::text, v_dev_calls, 0, v_spent, p_budget_usd;
    return;
  end if;

  -- рівень 1: ліміт пристрою (атомарно: умова у WHERE гілки do update)
  insert into public.mentor_usage (device_id, day, calls)
  values (p_device, v_today, 1)
  on conflict (device_id, day) do update
    set calls = mentor_usage.calls + 1,
        updated_at = now()
    where mentor_usage.calls < p_device_limit
  returning calls into v_dev_calls;

  if not found then
    return query select false, 'device_limit'::text, p_device_limit, 0, v_spent, p_budget_usd;
    return;
  end if;

  -- рівень 2: IP (добовий + швидкісний). Функція завжди передає ключ: без заголовка — 'ip:unknown'
  -- з тим самим лімітом (рішення власника 22.11.2026). Порожній p_ip лишається як запобіжник.
  if p_ip is not null and p_ip <> '' then
    insert into public.mentor_usage (device_id, day, calls)
    values (p_ip, v_today, 1)
    on conflict (device_id, day) do update
      set calls = mentor_usage.calls + 1,
          updated_at = now()
      where mentor_usage.calls < p_ip_limit
    returning calls into v_ip_calls;

    if not found then
      update public.mentor_usage set calls = greatest(calls - 1, 0), updated_at = now()
        where device_id = p_device and day = v_today;
      return query select false, 'ip_limit'::text, v_dev_calls, p_ip_limit, v_spent, p_budget_usd;
      return;
    end if;

    insert into public.mentor_ip_burst (ip_key, minute, calls)
    values (p_ip, v_minute, 1)
    on conflict (ip_key, minute) do update
      set calls = mentor_ip_burst.calls + 1
      where mentor_ip_burst.calls < p_ip_burst
    returning calls into v_burst;

    if not found then
      update public.mentor_usage set calls = greatest(calls - 1, 0), updated_at = now()
        where device_id in (p_device, p_ip) and day = v_today;
      return query select false, 'ip_burst'::text, v_dev_calls, v_ip_calls, v_spent, p_budget_usd;
      return;
    end if;

    -- прибирання хвилинних відер (замість cron): рідко й дешево
    if random() < 0.02 then
      delete from public.mentor_ip_burst where minute < now() - interval '15 minutes';
    end if;
  end if;

  return query select true, 'ok'::text, v_dev_calls, v_ip_calls, v_spent, p_budget_usd;
end;
$$;

-- ---------------------------------------------------------------- віддати слот

-- Викликається, коли модель не дала придатної відповіді (порожньо, refusal, помилка, таймаут):
-- учень не має платити лімітом за нашу невдачу. Хвилинне відро НЕ відкочуємо — це захист від
-- шквалу запитів, а шквал відбувся незалежно від того, чи вийшла відповідь.
create or replace function public.mentor_release(p_device text, p_ip text)
returns void language sql security definer set search_path = public as $$
  update public.mentor_usage
     set calls = greatest(calls - 1, 0), updated_at = now()
   where day = (now() at time zone 'utc')::date
     and (device_id = p_device or (p_ip is not null and p_ip <> '' and device_id = p_ip));
$$;

-- ---------------------------------------------------------------- облік токенів

-- Токени пишемо ТІЛЬКИ в рядок пристрою (щоб бюджет не подвоювався), і робимо це завжди,
-- навіть коли слот звільнено: гроші витрачено по факту.
create or replace function public.mentor_tokens(p_device text, p_in bigint, p_out bigint)
returns void language sql security definer set search_path = public as $$
  insert into public.mentor_usage (device_id, day, calls, input_tokens, output_tokens)
  values (p_device, (now() at time zone 'utc')::date, 0, p_in, p_out)
  on conflict (device_id, day) do update
    set input_tokens = mentor_usage.input_tokens + excluded.input_tokens,
        output_tokens = mentor_usage.output_tokens + excluded.output_tokens,
        updated_at = now();
$$;

-- ---------------------------------------------------------------- права

revoke all on function public.mentor_global_today(numeric, numeric) from public, anon, authenticated;
revoke all on function public.mentor_reserve(text, text, int, int, int, numeric, numeric, numeric, numeric, numeric) from public, anon, authenticated;
revoke all on function public.mentor_release(text, text) from public, anon, authenticated;
revoke all on function public.mentor_tokens(text, bigint, bigint) from public, anon, authenticated;

grant execute on function public.mentor_global_today(numeric, numeric) to service_role;
grant execute on function public.mentor_reserve(text, text, int, int, int, numeric, numeric, numeric, numeric, numeric) to service_role;
grant execute on function public.mentor_release(text, text) to service_role;
grant execute on function public.mentor_tokens(text, bigint, bigint) to service_role;

-- Жодної політики RLS для anon/authenticated немає: обидві таблиці доступні лише service_role
-- через функції вище (RLS увімкнено, політик нема = доступу нема).

-- Старий mentor_bump більше не викликається функцією (його замінили reserve+tokens).
-- Не видаляємо одразу: якщо доведеться відкотити деплой Edge Function, він ще знадобиться.
