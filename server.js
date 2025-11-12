import dotenv from "dotenv";
dotenv.config({ path: "/root/cs2-collector/.env" });
import express from "express";
import fetch from "node-fetch";

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

function b64(s) {
  return Buffer.from(s, "utf8").toString("base64");
}

function b64(s) { return Buffer.from(s, "utf8").toString("base64"); }

async function sendConsole(line) {
  const url = `https://dathost.net/api/0.1/game-servers/${process.env.DATHOST_SERVER_ID}/console`;
  const headers = {
    Authorization: `Basic ${b64(`${process.env.DATHOST_EMAIL}:${process.env.DATHOST_PASSWORD}`)}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  // If you’re acting on an invited account, uncomment next line:
  // headers["Account-Email"] = process.env.DATHOST_ACCOUNT_EMAIL;

  const r = await fetch(url, { method: "POST", headers, body: JSON.stringify({ line }) });
  if (!r.ok) {
    console.error("DatHost console error", r.status, await r.text().catch(()=>"" ));
    return false;
  }
  return true;
}



// simple cache: steam64 -> { allow:boolean, ts:number }
const gateCache = new Map();
// map steam64 -> last seen userid for kickid
const userIdMap = new Map();

async function isVerified(steam64) {
  try {
    const url = `${process.env.SUPABASE_URL}/rest/v1/users?select=verified_at,staff_override&steam64=eq.${steam64}&limit=1`;
    const r = await fetch(url, {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        Accept: "application/json"
      }
    });
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) return false;
    const u = rows[0];
    return !!(u?.staff_override === true || u?.verified_at); // verified if timestamp exists or staff override
  } catch (e) {
    console.error("verify lookup failed:", e);
    // fail-open if configured
    return process.env.FAIL_OPEN === "true";
  }
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
  const allow = await isVerified(steam64); // already handles errors and FAIL_OPEN
  if (allow) {
    await recordAccess(steam64, "allow", "verified");
    return;
  }
  const reason = `Verify at ${process.env.VERIFY_URL}`;
  const cmd = userid ? `kickid ${userid} "${reason}"` : `say "Player ${steam64} not verified"`;
  const ok = await sendConsole(cmd);
  await recordAccess(steam64, ok ? "deny" : "error", ok ? "not_verified" : "console_failed");
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
