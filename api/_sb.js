// Shared Supabase helpers for the serverless functions (files starting with "_" are not routes).
// SUPABASE_URL        project URL, e.g. https://xxxx.supabase.co (a trailing /rest/v1/ is tolerated)
// SUPABASE_SECRET_KEY secret key (sb_secret_...) or legacy service_role key — server only

export const SB_URL = (process.env.SUPABASE_URL || "").trim().replace(/\/rest\/v1\/?$/, "").replace(/\/+$/, "");
export const SB_KEY = (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
export const authEnabled = !!(SB_URL && SB_KEY);
export const DAILY_LIMIT = Math.max(1, parseInt(process.env.DAILY_LIMIT, 10) || 15);

// Secret keys (sb_secret_) go in `apikey` only; legacy JWT service_role keys also need Authorization.
export function adminHeaders(extra = {}) {
  const h = { apikey: SB_KEY, "content-type": "application/json", ...extra };
  if (SB_KEY.startsWith("eyJ")) h.Authorization = "Bearer " + SB_KEY;
  return h;
}

export function bearer(req) {
  return String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
}

// Returns {id, email} for a valid user access token, otherwise null.
export async function getUser(req) {
  const token = bearer(req);
  if (!token || !authEnabled) return null;
  try {
    const r = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: SB_KEY, Authorization: "Bearer " + token } });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? { id: u.id, email: u.email || "" } : null;
  } catch { return null; }
}

export async function rpc(fn, args) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers: adminHeaders(), body: JSON.stringify(args) });
  const text = await r.text();
  if (!r.ok) { const e = new Error(`rpc ${fn} ${r.status}: ${text.slice(0, 300)}`); e.status = r.status; throw e; }
  return text ? JSON.parse(text) : null;
}

export const kyivDay = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });

export async function usedToday(userId) {
  const r = await fetch(`${SB_URL}/rest/v1/tarot_usage?select=count&user_id=eq.${encodeURIComponent(userId)}&day=eq.${kyivDay()}`, { headers: adminHeaders() });
  if (!r.ok) return 0;
  const rows = await r.json();
  return rows?.[0]?.count || 0;
}

// Which kind of key is in SUPABASE_SECRET_KEY — used to explain configuration errors (never returns the key).
export function keyProblem() {
  if (!SB_KEY) return "SUPABASE_SECRET_KEY is empty";
  if (SB_KEY.startsWith("sb_publishable_")) return "SUPABASE_SECRET_KEY holds the publishable key — use the secret key (sb_secret_…)";
  if (SB_KEY.startsWith("sb_secret_")) return null;
  if (SB_KEY.startsWith("eyJ")) {
    try {
      const role = JSON.parse(Buffer.from(SB_KEY.split(".")[1], "base64url").toString()).role;
      if (role !== "service_role") return `SUPABASE_SECRET_KEY holds the legacy "${role}" key — use the secret key (sb_secret_…) or the legacy service_role key`;
      return null;
    } catch { return "SUPABASE_SECRET_KEY is not a valid key"; }
  }
  return "SUPABASE_SECRET_KEY is not a Supabase key";
}
