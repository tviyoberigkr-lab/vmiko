/*
 * Vmiko — проксі до ШІ-наставника (Supabase Edge Function).
 * Ключ Anthropic живе лише тут (секрет ANTHROPIC_API_KEY), у браузер не потрапляє.
 * Захист: ліміт звернень на пристрій на день, обрізання вхідних полів, лише дозволені види запитів.
 * Наставник НЕ дає готового запиту — лише вказує на місце помилки й напрям.
 * CoLaba Production
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const MODEL = "claude-haiku-5-5";
const DAILY_LIMIT = 60;          // звернень на пристрій на добу
const MAX_SQL = 4000;            // символів коду учня
const MAX_FIELD = 1500;          // символів на інше текстове поле
const MAX_OUTPUT_TOKENS = 350;

const ALLOWED_ORIGINS = [
  "https://tviyoberigkr-lab.github.io",
  "http://localhost:8080", "http://127.0.0.1:8080",
  "http://localhost:5173", "http://127.0.0.1:5173",
];

function cors(origin: string | null) {
  const ok = origin && (ALLOWED_ORIGINS.includes(origin) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
  return {
    "Access-Control-Allow-Origin": ok ? origin! : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
  };
}

const cut = (s: unknown, n: number) => (typeof s === "string" ? s.slice(0, n) : "");

const SYSTEM = `Ти — наставник з SQL у навчальному застосунку Vmiko. Учень — дорослий українець, вчиться дата-аналітики на датасеті інтернет-магазину «Кошик» (PostgreSQL).
Твоє завдання: подивитися на запит учня та результат перевірки і допомогти ЗРОЗУМІТИ, де помилка і чому — не розв'язати за нього.
Жорсткі правила:
- НІКОЛИ не пиши готовий правильний запит і не називай точну відповідь (числа, назви рядків з еталона).
- Можна: вказати на конкретне місце в його коді (назвати ключове слово, колонку, умову), пояснити механізм (що робить COUNT(*) проти COUNT(колонки), чому WHERE не бачить агрегат), поставити 1 навідне запитання, навести приклад на ІНШІЙ таблиці.
- Якщо запит правильний по суті, а відхилено через формат (порядок колонок, назва псевдоніма, ORDER BY) — скажи саме це.
- Якщо помилка в синтаксисі Postgres — розшифруй повідомлення бази людською мовою.
- Тон: спокійний, на «ти», без моралізаторства, без емодзі. Обсяг: 3–6 речень українською. Жодної води.`;

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const headers = cors(origin);
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers });

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return new Response(JSON.stringify({ error: "наставник не налаштований" }), { status: 503, headers });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return new Response(JSON.stringify({ error: "bad json" }), { status: 400, headers }); }

  const deviceId = cut(body.device_id, 64).replace(/[^A-Za-z0-9_-]/g, "");
  if (deviceId.length < 8) return new Response(JSON.stringify({ error: "device_id" }), { status: 400, headers });

  const kind = body.kind === "hint" ? "hint" : null;
  if (!kind) return new Response(JSON.stringify({ error: "kind" }), { status: 400, headers });

  const ex = (body.exercise ?? {}) as Record<string, unknown>;
  const title = cut(ex.title, 200);
  const prompt = cut(ex.prompt, MAX_FIELD);
  const schema = cut(ex.schema, MAX_FIELD);
  const code = cut(body.code, MAX_SQL);
  const lastError = cut(body.lastError, MAX_FIELD);
  const checkMsg = cut(body.lastCheckMessage, MAX_FIELD);
  const attempts = Math.max(0, Math.min(99, Number(body.attempts) || 0));
  if (!code.trim()) return new Response(JSON.stringify({ error: "порожній запит" }), { status: 400, headers });

  // --- ліміт на добу (service role, таблиця закрита RLS для всіх інших) ---
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const today = new Date().toISOString().slice(0, 10);
  const { data: used } = await sb.from("mentor_usage").select("calls").eq("device_id", deviceId).eq("day", today).maybeSingle();
  if ((used?.calls ?? 0) >= DAILY_LIMIT) {
    return new Response(JSON.stringify({ error: "limit", text: "Ліміт підказок від наставника на сьогодні вичерпано (60). Завтра він знову з тобою — а поки перечитай підказки 1–2." }), { status: 429, headers });
  }

  const user = `ЗАДАЧА: ${title}
${prompt}

СХЕМА (коротко): ${schema || "orders, order_items, products, customers, delivery, returns — див. завдання"}

ЗАПИТ УЧНЯ (спроба №${attempts}):
\`\`\`sql
${code}
\`\`\`

${lastError ? `ПОМИЛКА БАЗИ: ${lastError}` : `РЕЗУЛЬТАТ ПЕРЕВІРКИ: ${checkMsg || "не зараховано"}`}

Допоможи зрозуміти, де проблема. Готового запиту не давай.`;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: MAX_OUTPUT_TOKENS, temperature: 0.3, system: SYSTEM, messages: [{ role: "user", content: user }] }),
  });
  if (!r.ok) {
    const t = await r.text();
    console.error("anthropic", r.status, t.slice(0, 300));
    return new Response(JSON.stringify({ error: "upstream", text: "Наставник зараз недоступний. Спробуй за хвилину або перечитай підказки 1–2." }), { status: 502, headers });
  }
  const data = await r.json();
  const text = (data.content ?? []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("\n").trim();
  const inTok = Number(data.usage?.input_tokens) || 0, outTok = Number(data.usage?.output_tokens) || 0;
  const { data: calls } = await sb.rpc("mentor_bump", { p_device: deviceId, p_in: inTok, p_out: outTok });

  return new Response(JSON.stringify({ text, model: MODEL, usage: { input_tokens: inTok, output_tokens: outTok }, calls_today: calls, limit: DAILY_LIMIT }), { headers });
});
