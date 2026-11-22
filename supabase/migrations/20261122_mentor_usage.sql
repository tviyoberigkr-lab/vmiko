-- Відтворення міграцій, застосованих через MCP 22.11.2026 (mentor_usage + mentor_bump_grant_service_role). CoLaba Production
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
create or replace function public.mentor_bump(p_device text, p_in bigint, p_out bigint)
returns int language sql security definer set search_path = public as $$
  insert into public.mentor_usage (device_id, day, calls, input_tokens, output_tokens)
  values (p_device, (now() at time zone 'utc')::date, 1, p_in, p_out)
  on conflict (device_id, day) do update
    set calls = mentor_usage.calls + 1,
        input_tokens = mentor_usage.input_tokens + excluded.input_tokens,
        output_tokens = mentor_usage.output_tokens + excluded.output_tokens,
        updated_at = now()
  returning calls;
$$;
revoke all on function public.mentor_bump(text, bigint, bigint) from public, anon, authenticated;
grant execute on function public.mentor_bump(text, bigint, bigint) to service_role;
