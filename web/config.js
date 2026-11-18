// ─────────────────────────────────────────────────────────────
//  KaptainX Sales HQ: public settings.
//  Supabase → Project Settings → API Keys. The PUBLISHABLE key (sb_publishable_…,
//  or the legacy "anon" key) is MEANT to be public. Your data is protected by the
//  database rules, not by hiding this key. NEVER put the secret / service_role key here.
//  Leave SUPABASE_URL empty to preview with sample data on localhost.
// ─────────────────────────────────────────────────────────────
window.KX_CONFIG = {
  SUPABASE_URL: "https://npvbvbraarwyoodmtsag.supabase.co",           // e.g. "https://abcd1234.supabase.co"
  SUPABASE_ANON_KEY: "sb_publishable_3idKt4SetpZtMihq_8wH8g_d9k1TB4t",      // the publishable key: sb_publishable_… (or legacy anon key)
  LOGIN_DOMAIN: "team.kaptainx.com", // must match the team function and admin script (leave as is)
};
