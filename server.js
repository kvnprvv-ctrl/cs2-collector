import express from "express";
import fetch from "node-fetch";
const app = express();

// accept text and form bodies (some servers send x-www-form-urlencoded: log=<line>)
app.use(express.text({ type: "*/*", limit: "2mb" }));
app.use(express.urlencoded({ extended: false }));

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
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json"
    },
    body
  }).catch(() => {});
}

app.all("/logs", async (req, res) => {
  // token gate
  const token = req.query.token;
  if (process.env.SHARED_TOKEN && token !== process.env.SHARED_TOKEN) {
    //return res.status(403).end("forbidden");
  }

  // try to read a line from either raw text body or form param
  const raw = typeof req.body === "string" ? req.body : (req.body?.log ?? "");
  // LOG EVERYTHING for debugging
  console.log("REQ", req.method, req.headers["content-type"], raw.slice(0, 200));

  let line = raw;

  // Try pattern 1: STEAM_1:?:<steam32> ... killed ... STEAM_1:?:<steam32>
  let m = line.match(/STEAM_1:\d:(\d+).+?killed.+?STEAM_1:\d:(\d+)/);
  if (m) {
    const killer64 = steam32to64(m[1]);
    await awardXP(process.env, killer64, "kill", XP_PER_KILL);
    return res.status(200).end("ok");
  }

  // Try pattern 2: <76561198........> killed <76561198........>
  m = line.match(/<(\d{17})>.*killed.*<(\d{17})>/);
  if (m) {
    await awardXP(process.env, BigInt(m[1]), "kill", XP_PER_KILL);
    return res.status(200).end("ok");
  }

  // If payload contains multiple lines, split and scan quickly
  if (line.includes("\n")) {
    const lines = line.split("\n");
    for (const l of lines) {
      let m1 = l.match(/STEAM_1:\d:(\d+).+?killed.+?STEAM_1:\d:(\d+)/);
      if (m1) {
        const killer64 = steam32to64(m1[1]);
        await awardXP(process.env, killer64, "kill", XP_PER_KILL);
      }
      let m2 = l.match(/<(\d{17})>.*killed.*<(\d{17})>/);
      if (m2) await awardXP(process.env, BigInt(m2[1]), "kill", XP_PER_KILL);
    }
    return res.status(200).end("ok");
  }

  return res.status(200).end("ignored");
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("collector listening", port));
export default app;
