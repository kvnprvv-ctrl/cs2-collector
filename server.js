import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.text({ type: "*/*", limit: "1mb" }));

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
  });
}

app.all("/logs", async (req, res) => {
  try {
    const token = req.query.token;
    if (process.env.SHARED_TOKEN && token !== process.env.SHARED_TOKEN) {
      return res.status(403).end("forbidden");
    }

    const line = req.body || "";

    // Pattern 1: classic STEAM_1:X:<steam32>
    let m = line.match(/STEAM_1:\d:(\d+).+?killed.+?STEAM_1:\d:(\d+)/);
    if (m) {
      const killer64 = steam32to64(m[1]);
      await awardXP(process.env, killer64, "kill", XP_PER_KILL);
      return res.status(200).end("ok");
    }

    // Pattern 2: direct steam64 in angle brackets
    m = line.match(/<(\d{17})>.*killed.*<(\d{17})>/);
    if (m) {
      await awardXP(process.env, BigInt(m[1]), "kill", XP_PER_KILL);
      return res.status(200).end("ok");
    }

    return res.status(200).end("ignored");
  } catch {
    return res.status(200).end("ok"); // never 5xx the game server
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("collector listening on", port));
