// ZONE chat server for Vercel. Tries Groq, then Gemini, then OpenRouter. First one that answers wins.
// Keys live in Vercel Environment Variables, never in this file:
//   GROQ_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY
const SYSTEM = "You are ZONE, a friendly game character. Reply in the same language the user speaks (Bangla, English, Hindi or a mix). One short, natural, speakable reply. No emojis, no markdown. Never call yourself June.";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function timeout(ms) {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

function buildMessages(name, message, history, langHint) {
  const msgs = [{ role: "system", content: SYSTEM + (langHint ? " " + langHint : "") }];
  (Array.isArray(history) ? history : []).slice(-12).forEach(h => {
    if (h && h.text) msgs.push({ role: h.role === "assistant" ? "assistant" : "user", content: String(h.text) });
  });
  msgs.push({ role: "user", content: (name ? name + ": " : "") + message });
  return msgs;
}

async function askOpenAIStyle(url, key, model, msgs) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
    body: JSON.stringify({ model, messages: msgs, max_tokens: 200, temperature: 0.8 }),
    signal: timeout(9000),
  });
  if (!r.ok) throw new Error("status " + r.status);
  const d = await r.json();
  const t = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
  if (!t) throw new Error("empty");
  return String(t).trim();
}

async function askGroq(msgs) {
  return askOpenAIStyle("https://api.groq.com/openai/v1/chat/completions", process.env.GROQ_API_KEY, "llama-3.3-70b-versatile", msgs);
}

async function askOpenRouter(msgs) {
  return askOpenAIStyle("https://openrouter.ai/api/v1/chat/completions", process.env.OPENROUTER_API_KEY, "meta-llama/llama-3.3-70b-instruct:free", msgs);
}

async function askGemini(msgs) {
  const sys = msgs[0].content;
  const contents = msgs.slice(1).map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
  const r = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" + process.env.GEMINI_API_KEY,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: sys }] },
        contents,
        generationConfig: { maxOutputTokens: 200, temperature: 0.8 },
      }),
      signal: timeout(9000),
    }
  );
  if (!r.ok) throw new Error("status " + r.status);
  const d = await r.json();
  const t = d && d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts && d.candidates[0].content.parts[0] && d.candidates[0].content.parts[0].text;
  if (!t) throw new Error("empty");
  return String(t).trim();
}

// A provider that just failed is skipped for 60 seconds, so the next question does not wait for it again.
const cooldown = {};
const PROVIDERS = [
  { id: "groq", env: "GROQ_API_KEY", fn: askGroq },
  { id: "gemini", env: "GEMINI_API_KEY", fn: askGemini },
  { id: "openrouter", env: "OPENROUTER_API_KEY", fn: askOpenRouter },
];

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(200).json({ ok: true, name: "ZONE server" }); return; }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  const message = String(body.message || "").slice(0, 500);
  if (!message) { res.status(400).json({ error: "no message" }); return; }

  const msgs = buildMessages(body.name, message, body.history, body.langHint);
  const now = Date.now();
  const order = PROVIDERS.filter(p => process.env[p.env]);
  // providers not in cooldown first, then the ones in cooldown as a last resort
  const ready = order.filter(p => !(cooldown[p.id] > now)).concat(order.filter(p => cooldown[p.id] > now));

  for (const p of ready) {
    try {
      const reply = await p.fn(msgs);
      res.status(200).json({ reply, by: p.id });
      return;
    } catch (e) {
      cooldown[p.id] = Date.now() + 60000;
    }
  }
  res.status(502).json({ error: "all providers failed" });
};
