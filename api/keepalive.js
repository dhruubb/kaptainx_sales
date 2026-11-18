// Optional (Vercel only): pings the database once a day so the free Supabase
// project never pauses from inactivity. Needs SUPABASE_URL and SUPABASE_ANON_KEY
// set in Vercel → Project → Settings → Environment Variables
// (SUPABASE_ANON_KEY = the publishable key, sb_publishable_…, or the legacy anon key).
module.exports = async function handler(req, res) {
  const url = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = process.env.SUPABASE_ANON_KEY || "";
  res.setHeader("Cache-Control", "no-store");
  if (!url || !key) return res.status(200).json({ ok: false, reason: "env not set" });
  try {
    const r = await fetch(`${url}/rest/v1/rpc/ping`, {
      method: "POST",
      headers: key.startsWith("sb_") ? { apikey: key, "Content-Type": "application/json" } : { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: "{}",
    });
    return res.status(200).json({ ok: r.ok });
  } catch {
    return res.status(200).json({ ok: false });
  }
};
