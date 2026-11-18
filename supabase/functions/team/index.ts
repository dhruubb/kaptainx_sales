// KaptainX Sales HQ: team management (founders only).
// Actions: create, reset_password, set_role, set_active.
// Deploy:  npx supabase functions deploy team
// Uses the project's built-in SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY.
// Optional secrets: LOGIN_DOMAIN (default team.kaptainx.com), ALLOWED_ORIGIN (your site URL).
import { createClient } from "npm:@supabase/supabase-js@2";

const LOGIN_DOMAIN = Deno.env.get("LOGIN_DOMAIN") ?? "team.kaptainx.com";
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";
const COLORS = ["#2a78d6", "#eb6834", "#6250d6", "#1baf7a", "#d55181", "#eda100", "#3987e5", "#199e70"];

const cors = (origin: string | null) => ({
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN === "*" ? "*" : (origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN),
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
});

function tempPassword() {
  const A = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint32Array(16));
  const chars = [...bytes].map((b) => A[b % A.length]);
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join("")).join("-");
}

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");
  const headers = { ...cors(origin), "Content-Type": "application/json", "Cache-Control": "no-store" };
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });
  if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // 1. Who is calling?
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!jwt) return reply({ error: "Not signed in" }, 401);
    const userClient = createClient(url, anon, { auth: { persistSession: false } });
    const { data: who, error: whoErr } = await userClient.auth.getUser(jwt);
    if (whoErr || !who?.user) return reply({ error: "Not signed in" }, 401);

    const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: me } = await admin.from("profiles").select("id, role, active").eq("id", who.user.id).maybeSingle();
    if (!me || !me.active || me.role !== "founder") return reply({ error: "Only founders can manage the team" }, 403);

    // 2. What do they want?
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "");
    const log = (label: string, changes: Record<string, unknown>, entityId?: string) =>
      admin.from("activity").insert({ actor: me.id, scope: "team", entity: "team", entity_id: entityId ?? null, action, label, changes });

    const founderCount = async () =>
      (await admin.from("profiles").select("id", { count: "exact", head: true }).eq("role", "founder").eq("active", true)).count ?? 0;

    if (action === "create") {
      const username = String(body.username ?? "").trim().toLowerCase();
      const name = String(body.name ?? "").trim().slice(0, 60);
      const role = body.role === "founder" ? "founder" : "caller";
      if (!/^[a-z0-9._-]{3,30}$/.test(username)) return reply({ error: "Username: 3–30 letters, numbers, dot, dash or underscore" }, 400);
      if (!name) return reply({ error: "Name is required" }, 400);
      const { data: taken } = await admin.from("profiles").select("id").ilike("username", username).maybeSingle();
      if (taken) return reply({ error: "That username is taken" }, 409);

      const password = tempPassword();
      const { data: created, error } = await admin.auth.admin.createUser({
        email: `${username}@${LOGIN_DOMAIN}`, password, email_confirm: true, user_metadata: { username, name },
      });
      if (error || !created?.user) return reply({ error: error?.message ?? "Could not create user" }, 400);
      const { count } = await admin.from("profiles").select("id", { count: "exact", head: true });
      const { error: pErr } = await admin.from("profiles").insert({
        id: created.user.id, username, name, role, color: COLORS[(count ?? 0) % COLORS.length],
        must_change_password: true, active: true,
      });
      if (pErr) { await admin.auth.admin.deleteUser(created.user.id); return reply({ error: pErr.message }, 400); }
      await log(name, { username, role }, created.user.id);
      return reply({ ok: true, id: created.user.id, username, password });
    }

    const targetId = String(body.user_id ?? "");
    const { data: target } = await admin.from("profiles").select("id, name, username, role, active").eq("id", targetId).maybeSingle();
    if (!target) return reply({ error: "Member not found" }, 404);

    if (action === "reset_password") {
      const password = tempPassword();
      const { error } = await admin.auth.admin.updateUserById(target.id, { password });
      if (error) return reply({ error: error.message }, 400);
      await admin.from("profiles").update({ must_change_password: true }).eq("id", target.id);
      await log(target.name, {}, target.id);
      return reply({ ok: true, username: target.username, password });
    }

    if (action === "set_role") {
      const role = body.role === "founder" ? "founder" : "caller";
      if (target.role === "founder" && role === "caller" && (await founderCount()) <= 1) return reply({ error: "Keep at least one founder" }, 400);
      await admin.from("profiles").update({ role }).eq("id", target.id);
      await log(target.name, { role: [target.role, role] }, target.id);
      return reply({ ok: true });
    }

    if (action === "set_active") {
      const active = Boolean(body.active);
      if (target.id === me.id && !active) return reply({ error: "You can't deactivate yourself" }, 400);
      if (!active && target.role === "founder" && (await founderCount()) <= 1) return reply({ error: "Keep at least one founder" }, 400);
      const { error } = await admin.auth.admin.updateUserById(target.id, { ban_duration: active ? "none" : "876000h" });
      if (error) return reply({ error: error.message }, 400);
      await admin.from("profiles").update({ active }).eq("id", target.id);
      await log(target.name, { active }, target.id);
      return reply({ ok: true });
    }

    return reply({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error(e);
    return reply({ error: "Something went wrong" }, 500);
  }
});
