import dotenv from "dotenv";
dotenv.config({ path: "/root/cs2-collector/.env" });
import 'dotenv/config';
import express from "express";
import fetch from "node-fetch";
import RconCjs from "rcon"; // commonjs default

let rcon;
async function connectRcon() {
  if (rcon && rcon.hasAuthed) return rcon;

  rcon = new RconCjs(process.env.RCON_HOST, Number(process.env.RCON_PORT || 27015), process.env.RCON_PASSWORD);
  await new Promise((resolve, reject) => {
    rcon.on("auth", resolve);
    rcon.on("error", reject);
    rcon.connect();
  });
  return rcon;
}

async function rconCmd(cmd) {
  const c = await connectRcon();
  try { c.send(cmd); return true; } catch { return false; }
}


const rxConnect32 = /"[^"]+<(\d+)><STEAM_1:\d:(\d+)><[^>]*>".*connected/i;
const rxConnectU1  = /"[^"]+<(\d+)><\[U:1:(\d+)\]><[^>]*>".*connected/i;
const rxTeam32     = /"[^"]+<(\d+)><STEAM_1:\d:(\d+)><[^>]*>" joined team "([^"]+)"/i;
const rxTeamU1     = /"[^"]+<(\d+)><\[U:1:(\d+)\]><[^>]*>" joined team "([^"]+)"/i;


const app = express();
app.use(express.text({ type: "*/*", limit: "2mb" }));
app.use(express.urlencoded({ extended: false }));
app.use(express.json()); // <-- add this

const XP_PER_KILL = 10;

function steam32to64(s32) {
  return (BigInt(s32) * 2n) + 76561197960265728n;
}

// simple cache: steam64 -> { allow:boolean, ts:number }
const gateCache = new Map();
// map steam64 -> last seen userid for kickid
const userIdMap = new Map();

async function isVerified(steam64) {
  const now = Date.now();
  const cached = gateCache.get(steam64);
  if (cached && (now - cached.ts) < 5 * 60 * 1000) return cached.allow; // 5 min cache

  const url = `${process.env.SUPABASE_URL}/rest/v1/users?select=verified_at,staff_override&steam64=eq.${steam64}`;
  const r = await fetch(url, {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`
    }
  });
  const rows = await r.json().catch(() => []);
  const allow = Array.isArray(rows) && rows.length > 0 &&
                (rows[0]?.verified_at !== null || rows[0]?.staff_override === true);
  gateCache.set(steam64, { allow, ts: now });
  return allow;
}

async function recordAccess(steam64, outcome, reason) {
  const body = JSON.stringify({
    steam64, server_token: process.env.SERVER_TOKEN || "unknown", outcome, reason
  });
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/access_events`, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json"
    },
    body
  }).catch(()=>{});
}

function to64_from32(s32) { return ((BigInt(s32) * 2n) + 76561197960265728n).toString(); }
function to64_fromU1(u1digits) { // Steam3 “[U:1:123456]”
  return ((BigInt(u1digits) + 76561197960265728n)).toString();
}

async function guardJoin(steam64, userid) {
  if (!steam64) return;
  if (userid) userIdMap.set(steam64, userid);
  const allow = await isVerified(steam64).catch(()=>false);
  if (allow) { await recordAccess(steam64, "allow", "verified"); return; }

  // not verified -> kick
  const id = userid || userIdMap.get(steam64);
  const reason = `Verify at ${process.env.VERIFY_URL}`;
  const ok = id ? await rconCmd(`kickid ${id} "${reason}"`) : await rconCmd(`kick "${reason}"`);
  await recordAccess(steam64, ok ? "deny" : "error", ok ? "not_verified" : "kick_failed");
}


async function awardXP(env, steam64, reason, amount, matchId = 0) {
  const body = JSON.stringify({
    p_steam64: steam64.toString(),
    p_match_id: matchId,
    p_reason: reason,
    p_amount: amount
  });

  await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/award_xp`, {
    method: "POST",
    headers: {
      "apikey": env.SUPABASE_SERVICE_KEY,
      "Authorization": `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json"
    },
    body
  }).catch(() => {});
}

 async function recordKill(env, { serverToken, matchId=0, killer64, victim64, assist64=null, weapon=null }) {
  const body = JSON.stringify({
    p_server_token: serverToken,
    p_match_id: matchId,
    p_killer64: killer64.toString(),
    p_victim64: victim64.toString(),
    p_assist64: assist64 ? assist64.toString() : null,
    p_weapon: weapon
  });
  await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/record_kill`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json"
    },
    body
  }).catch(()=>{});
}

const textParser = express.text({ type: "*/*", limit: "2mb" });

app.all("/logs", async (req, res) => {
  const token = req.query.token;
  if (process.env.SHARED_TOKEN && token !== process.env.SHARED_TOKEN)
    return res.status(403).end("forbidden");

  const raw = typeof req.body === "string" ? req.body : (req.body?.log ?? "");
  if (!raw) return res.status(200).end("ok");

  const lines = raw.split("\n");

  const kill32 = /STEAM_1:\d:(\d+).+?killed.+?STEAM_1:\d:(\d+)/;
  const kill64 = /<(\d{17})>.*killed.*<(\d{17})>/;

  for (const line of lines) {
    // CONNECT events
    let m;
    if ((m = line.match(rxConnect32))) {
      const userid = m[1]; const s64 = to64_from32(m[2]);
      await guardJoin(s64, userid);
      continue;
    }
    if ((m = line.match(rxConnectU1))) {
      const userid = m[1]; const s64 = to64_fromU1(m[2]);
      await guardJoin(s64, userid);
      continue;
    }

    // TEAM JOIN events (occasionally first line we can trust)
    if ((m = line.match(rxTeam32))) {
      const userid = m[1]; const s64 = to64_from32(m[2]);
      await guardJoin(s64, userid);
      continue;
    }
    if ((m = line.match(rxTeamU1))) {
      const userid = m[1]; const s64 = to64_fromU1(m[2]);
      await guardJoin(s64, userid);
      continue;
    }

}

  return res.status(200).end("ok");
});

app.post("/register", async (req, res) => {
  const { name, ip, port, token, region = "EU", mode = "retake" } = req.body || {};
  if (!name || !ip || !port || !token) return res.status(400).json({ error: "missing field" });
  if (req.headers["x-auth"] !== process.env.SHARED_TOKEN) return res.status(403).end("forbidden");

  const ip_port = `${ip}:${port}`;

  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/servers`, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates"
    },
    body: JSON.stringify({ name, ip, port, token, ip_port, region, mode, active: true })
  });
  const data = await r.json().catch(() => ({}));
  return res.status(r.ok ? 200 : 500).json(data);
});



const port = process.env.PORT || 8787;
app.listen(port, () => console.log(`collector listening on ${port}`));
export default app;
