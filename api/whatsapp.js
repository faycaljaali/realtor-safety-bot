import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

const TIMERS_SET = "timers:agents"; // phone numbers with active timers

export default async function handler(req, res) {
  // webhook verification
  if (req.method === "GET") {
    const verify = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (verify === process.env.WHATSAPP_VERIFY_TOKEN) return res.status(200).send(challenge);
    return res.status(403).send("Forbidden");
  }

  // inbound message
  if (req.method === "POST") {
    try {
      const entry = req.body?.entry?.[0]?.changes?.[0]?.value;
      const msg = entry?.messages?.[0];
      if (!msg) return res.status(200).end();

      const from = msg.from; // E164
      const text = (msg.text?.body || "").trim().toLowerCase();

      if (text.startsWith("start showing")) {
        const parts = text.split(/\s+/);
        const minutes = parseInt(parts[2] || "15", 10);
        if (isNaN(minutes) || minutes < 1 || minutes > 240) {
          await sendText(from, "Please send Start showing 15 for a 15 minute timer. Range 1 to 240.");
          return res.status(200).end();
        }
        await startTimer(from, minutes);
        // schedule a one time callback using QStash
        await scheduleExpiry(req.headers.host, minutes);
        await sendText(from, `Timer started for ${minutes} minutes. Reply I am safe to cancel. Send Help to alert your contact now.`);
      } else if (text === "i am safe") {
        const ok = await resolveTimer(from, "safe");
        await sendText(from, ok ? "Glad you are safe. Timer cleared." : "No active timer found.");
      } else if (text === "help") {
        await alertContact(from, "manual");
        await resolveTimer(from, "alert");
        await sendText(from, "Alert sent to your contact.");
      } else {
        await sendText(from, "Commands: Start showing 15   I am safe   Help");
      }

      return res.status(200).end();
    } catch (e) {
      console.error(e);
      return res.status(200).end();
    }
  }

  res.status(405).end();
}

async function sendText(to, message) {
  const url = "https://graph.facebook.com/v20.0/" + process.env.WHATSAPP_PHONE_ID + "/messages";
  await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + process.env.WHATSAPP_TOKEN,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      text: { body: message }
    })
  });
}

async function startTimer(agentPhone, minutes) {
  const expiresAt = Date.now() + minutes * 60 * 1000;
  await redis.hset(key(agentPhone), { status: "active", expiresAt, minutes });
  await redis.sadd(TIMERS_SET, agentPhone);
}

async function resolveTimer(agentPhone, resolution) {
  const k = key(agentPhone);
  const t = await redis.hgetall(k);
  if (!t || t.status !== "active") return false;
  await redis.hset(k, { status: "resolved", resolution, resolvedAt: Date.now() });
  await redis.srem(TIMERS_SET, agentPhone);
  return true;
}

export async function alertContact(agentPhone, reason) {
  const contact = process.env.TEST_CONTACT_PHONE; // fixed contact for this test
  const link = "https://maps.google.com"; // placeholder
  await sendText(contact, `Alert from your agent. Reason: ${reason}. Last known location: ${link}`);
}

export async function expireTimersNow() {
  const now = Date.now();
  const agents = await redis.smembers(TIMERS_SET);
  for (const a of agents) {
    const t = await redis.hgetall(key(a));
    if (t && t.status === "active" && Number(t.expiresAt) <= now) {
      await alertContact(a, "missed check in");
      await resolveTimer(a, "alert");
    }
  }
}

function key(agentPhone) {
  return `timer:${agentPhone}`;
}

// schedule a one time call to our /api/cron using Upstash QStash
async function scheduleExpiry(host, minutes) {
  const base = host?.startsWith("http") ? host : `https://${host}`;
  const destination = `${base}/api/cron`;
  const url = `${process.env.QSTASH_URL.replace(/\/$/, "")}/v2/publish/${destination}`;
  await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + process.env.QSTASH_TOKEN,
      "Upstash-Delay": `${minutes * 60}s`
    }
  });
}
