// ─────────────────────────────────────────────────────────────
//  KaptainX Sales HQ: public settings.
//  Supabase → Project Settings → API. The anon/publishable key is MEANT to be
//  public. Your data is protected by the database rules, not by hiding this key.
//  NEVER put the service_role key here.
//  Leave SUPABASE_URL empty to preview with sample data on localhost.
// ─────────────────────────────────────────────────────────────
window.KX_CONFIG = {
  SUPABASE_URL: "",           // e.g. "https://abcd1234.supabase.co"
  SUPABASE_ANON_KEY: "",      // the "anon" / "publishable" key
  LOGIN_DOMAIN: "team.kaptainx.com", // must match the team function and admin script (leave as is)
};
