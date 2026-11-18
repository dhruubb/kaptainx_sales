#!/usr/bin/env node
// KaptainX Sales HQ: admin script (runs on YOUR computer, never deployed).
//
//   node scripts/admin.mjs setup              create/refresh the users in private/initial-users.json
//   node scripts/admin.mjs reset <username>   give someone a new temporary password
//   node scripts/admin.mjs list               show the team
//
// Needs private/.env with SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (see private/.env.example).
// The service-role key is a master key: keep it only in private/.env. Never put it in the website.
import { readFileSync, existsSync } from "node:fs";
import { randomInt } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = join(root, "private", ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const URL_ = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const LOGIN_DOMAIN = process.env.LOGIN_DOMAIN || "team.kaptainx.com";
const die = (m) => { console.error("✖ " + m); process.exit(1); };
if (!/^https:\/\/.+/.test(URL_) || KEY.length < 20) die("Fill SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in private/.env first.");

const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
async function api(method, path, body, extra = {}) {
  const r = await fetch(URL_ + path, { method, headers: { ...H, ...extra }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) die(`${method} ${path} → ${r.status}: ${typeof data === "string" ? data : data?.msg || data?.message || data?.error_description || JSON.stringify(data)}`);
  return data;
}
const A = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
const tempPassword = () => [0, 1, 2, 3].map(() => Array.from({ length: 4 }, () => A[randomInt(A.length)]).join("")).join("-");

async function allAuthUsers() {
  const out = [];
  for (let page = 1; page < 50; page++) {
    const d = await api("GET", `/auth/v1/admin/users?page=${page}&per_page=200`);
    const users = d?.users ?? [];
    out.push(...users);
    if (users.length < 200) break;
  }
  return out;
}
async function upsertProfile(p) {
  await api("POST", "/rest/v1/profiles?on_conflict=id", p, { Prefer: "resolution=merge-duplicates,return=minimal" });
}

const [cmd, arg] = process.argv.slice(2);

if (cmd === "setup") {
  const file = join(root, "private", "initial-users.json");
  if (!existsSync(file)) die("private/initial-users.json not found");
  const people = JSON.parse(readFileSync(file, "utf8"));
  const existing = await allAuthUsers();
  for (const p of people) {
    if (!/^[a-z0-9._-]{3,30}$/.test(p.username)) die(`Bad username: ${p.username}`);
    if (!p.password || p.password.length < 10) die(`Password for ${p.username} must be 10+ characters`);
    const email = `${p.username}@${LOGIN_DOMAIN}`;
    let user = existing.find((u) => (u.email || "").toLowerCase() === email);
    if (user) {
      await api("PUT", `/auth/v1/admin/users/${user.id}`, { password: p.password, ban_duration: "none" });
      console.log(`↻ ${p.username}: already existed, password set again`);
    } else {
      user = await api("POST", "/auth/v1/admin/users", { email, password: p.password, email_confirm: true, user_metadata: { username: p.username, name: p.name } });
      user = user.user ?? user;
      console.log(`✔ ${p.username}: created`);
    }
    await upsertProfile({ id: user.id, username: p.username, name: p.name, role: p.role, color: p.color, active: true, must_change_password: true });
  }
  console.log("\nDone. Each person signs in with their username + password, then picks a new password.");
} else if (cmd === "reset") {
  if (!arg) die("Usage: node scripts/admin.mjs reset <username>");
  const rows = await api("GET", `/rest/v1/profiles?select=id,username&username=eq.${encodeURIComponent(arg.toLowerCase())}`);
  if (!rows?.length) die(`No member called ${arg}`);
  const password = tempPassword();
  await api("PUT", `/auth/v1/admin/users/${rows[0].id}`, { password, ban_duration: "none" });
  await api("PATCH", `/rest/v1/profiles?id=eq.${rows[0].id}`, { must_change_password: true, active: true }, { Prefer: "return=minimal" });
  console.log(`✔ New temporary password for ${arg}:  ${password}\n  They'll be asked to choose their own after signing in.`);
} else if (cmd === "list") {
  const rows = await api("GET", "/rest/v1/profiles?select=username,name,role,active,daily_goal&order=created_at");
  console.table(rows);
} else {
  console.log("Usage: node scripts/admin.mjs setup | reset <username> | list");
}
