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
      const killer64 = (BigInt(m[1]) * 2n) + 76561197960265728n;
      await awardXP(process.env, killer64, "kill", 10);
      continue;
    }
    m = line.match(kill64);
    if (m) {
      await awardXP(process.env, BigInt(m[1]), "kill", 10);
      continue;
    }
  }
  return res.status(200).end("ok");
});
