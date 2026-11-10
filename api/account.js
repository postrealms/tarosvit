// DELETE /api/account — deletes the signed-in user and (by cascade) all their rows.
import { SB_URL, authEnabled, adminHeaders, getUser } from "./_sb.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "DELETE") return res.status(405).json({ code: "generic", error: "Method not allowed" });
  if (!authEnabled) return res.status(500).json({ code: "server_config", error: "Supabase is not configured" });
  const user = await getUser(req);
  if (!user) return res.status(401).json({ code: "signin", error: "Sign-in required" });

  // Readings and usage go with the user (on delete cascade); thumbnails live inside the readings rows.
  const r = await fetch(`${SB_URL}/auth/v1/admin/users/${user.id}`, { method: "DELETE", headers: adminHeaders() });
  if (!r.ok) {
    console.error("delete user failed", r.status, (await r.text()).slice(0, 300));
    return res.status(500).json({ code: "generic", error: "Could not delete the account" });
  }
  return res.status(200).json({ ok: true });
}
