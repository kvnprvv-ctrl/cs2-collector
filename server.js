import express from "express";
import fetch from "node-fetch";
import 'dotenv/config';

const app = express();
app.use(express.text({ type: "*/*", limit: "2mb" }));
app.use(express.urlencoded({ extended: false }));
app.use(express.json()); // <-- add this

const XP_PER_KILL = 10;

function steam32to64(s32) {
  return (BigInt(s32) * 2n) + 76561197960265728n;
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
    let m = line.match(kill32);
    if (m) {
      const killer64 = steam32to64(m[1]);
      await awardXP(process.env, killer64, "kill", XP_PER_KILL);
      continue;
    }
    m = line.match(kill64);
    if (m) {
      await awardXP(process.env, BigInt(m[1]), "kill", XP_PER_KILL);
      continue;
    }
  }

  return res.status(200).end("ok");
});

app.post("/register", async (req, res) => {
  const { name, ip, port, token } = req.body || {};
  if (!name || !ip || !port || !token) return res.status(400).json({ error: "missing field" });
  if (req.headers["x-auth"] !== process.env.SHARED_TOKEN) return res.status(403).end("forbidden");
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/servers`, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates"
    },
    body: JSON.stringify({ name, ip, port, token })
  });
  const data = await r.json().catch(() => ({}));
  return res.status(r.ok ? 200 : 500).json(data);
});


const port = process.env.PORT || 8787;
app.listen(port, () => console.log(`collector listening on ${port}`));
export default app;
