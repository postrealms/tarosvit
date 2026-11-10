// Vercel serverless function: /api/analyze
// Environment variables (Vercel → Project → Settings → Environment Variables):
//   ANTHROPIC_API_KEY  required — key from console.anthropic.com
//   ACCESS_CODE        optional — if set, the app asks testers for this code
//   CLAUDE_MODEL       optional — defaults to claude-sonnet-5-5
//   SUPABASE_URL, SUPABASE_SECRET_KEY  — when both are set, a reading needs a signed-in user
//   DAILY_LIMIT        optional — readings per user per day, defaults to 15

import { authEnabled, DAILY_LIMIT, getUser, rpc, usedToday, keyProblem } from "./_sb.js";

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5-5";
const MAX_IMAGE_B64 = 4_000_000;          // ~3 MB image; the client sends ~0.2–0.6 MB
const RATE = { windowMs: 60_000, max: 12 }; // per IP per instance — a light brake, not a wall
const hits = new Map();

const PROMPT = question => `Ти досвідчений тлумач карт таро. На фото одна карта таро, знята смартфоном. Верх кадру відповідає верху, як його бачить людина.
Визнач карту і її положення (пряме чи перевернуте) та дай тлумачення українською.
${question
  ? "Питання людини: «" + question + "». Тлумач саме в контексті цього питання."
  : "Питання не задано, дай загальне тлумачення на сьогодні."}
Тлумачення складається з 3 коротких абзаців: що символізує карта; що вона означає в цьому положенні${question ? " для заданого питання" : ""}; на що звернути увагу або який зробити крок.
Пиши тепло і конкретно, без залякування й без категоричних пророцтв. Не давай медичних, юридичних чи фінансових порад.
Поверни ТІЛЬКИ JSON такої форми, без тексту до чи після:
{"card":"назва карти українською","card_en":"традиційна англійська назва","position":"upright|reversed","paragraphs":["","",""]}
Якщо на фото немає карти таро або її неможливо розпізнати — поверни {"error":"коротко, що на фото і як перезняти (світло, відблиски, карта повністю в рамці)"}.`;

function codeOk(req) {
  const need = process.env.ACCESS_CODE;
  return !need || (req.headers["x-access-code"] || "") === need;
}

function rateLimited(req) {
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "anon";
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < RATE.windowMs);
  list.push(now);
  hits.set(ip, list);
  return list.length > RATE.max;
}

function extractJson(text) {
  try { return JSON.parse(text); } catch {}
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1]); } catch {} }
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch {} }
  return null;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  // Health / access check used by the app on start; with a token it also reports today's usage
  if (req.method === "GET") {
    const out = { ok: true, codeRequired: !!process.env.ACCESS_CODE, codeOk: codeOk(req), authRequired: authEnabled };
    if (authEnabled) {
      const user = await getUser(req);
      out.signedIn = !!user;
      if (user) out.usage = { used: await usedToday(user.id).catch(() => 0), limit: DAILY_LIMIT };
    }
    return res.status(200).json(out);
  }
  if (req.method !== "POST") return res.status(405).json({ code: "generic", error: "Method not allowed" });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ code: "server_config", error: "ANTHROPIC_API_KEY is not set" });
  if (!codeOk(req)) return res.status(401).json({ code: "code", error: "Access code required" });

  let user = null;
  if (authEnabled) {
    user = await getUser(req);
    if (!user) return res.status(401).json({ code: "signin", error: "Sign-in required" });
  }
  if (rateLimited(req)) return res.status(429).json({ code: "rate", error: "Too many requests" });

  let body;
  try { body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {}); }
  catch { return res.status(400).json({ code: "generic", error: "Bad request" }); }
  const image = typeof body.image === "string" ? body.image : "";
  const mediaType = ["image/jpeg", "image/png", "image/webp"].includes(body.mediaType) ? body.mediaType : "image/jpeg";
  const question = String(body.question || "").replace(/\s+/g, " ").trim().slice(0, 200);

  if (!image) return res.status(400).json({ code: "no_image", error: "No image" });
  if (image.length > MAX_IMAGE_B64) return res.status(413).json({ code: "too_big", error: "Image too large" });

  // Daily limit: take one reading now, give it back if Claude fails
  let used = null;
  if (user) {
    try { used = await rpc("use_reading", { p_user: user.id, p_limit: DAILY_LIMIT }); }
    catch (e) {
      console.error("usage rpc failed", e.message);
      const pg = (e.message.match(/"message":"([^"]{1,160})/) || [])[1] || e.message.slice(0, 160);
      return res.status(500).json({ code: "server_config", error: keyProblem() || `Usage tracking failed: ${pg}` });
    }
    if (used === null) return res.status(429).json({ code: "daily_limit", error: "Daily limit reached", usage: { used: DAILY_LIMIT, limit: DAILY_LIMIT } });
  }
  const refund = () => user ? rpc("refund_reading", { p_user: user.id }).catch(() => {}) : null;
  const fail = async (status, payload) => { await refund(); return res.status(status).json(payload); };

  let r;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
            { type: "text", text: PROMPT(question) },
          ],
        }],
      }),
    });
  } catch {
    return fail(502, { code: "network", error: "Could not reach Claude" });
  }

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error("Claude API error", r.status, JSON.stringify(data).slice(0, 500));
    if (r.status === 429) return fail(429, { code: "rate", error: "Claude rate limit" });
    if (r.status === 529 || r.status >= 500) return fail(503, { code: "overloaded", error: "Claude overloaded" });
    if (r.status === 401) return fail(500, { code: "server_config", error: "Invalid API key" });
    if (r.status === 400 && /credit|balance/i.test(data?.error?.message || "")) return fail(402, { code: "no_credit", error: "Out of API credit" });
    return fail(502, { code: "bad_image", error: "Claude could not process the image" });
  }

  const text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("\n");
  const json = extractJson(text);
  if (!json) return fail(502, { code: "parse", error: "Could not parse the response" });

  // A photo without a tarot card does not use up a reading
  if (json.error) { await refund(); used = used && used - 1; }
  else {
    json.position = json.position === "reversed" ? "reversed" : "upright";
    json.paragraphs = (Array.isArray(json.paragraphs) ? json.paragraphs : []).map(p => String(p).trim()).filter(Boolean).slice(0, 6);
    if (!json.card || !json.paragraphs.length) return fail(502, { code: "parse", error: "Could not parse the response" });
  }

  if (user) json._usage = { used, limit: DAILY_LIMIT };
  return res.status(200).json(json);
}
