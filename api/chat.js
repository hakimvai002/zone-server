// ZONE backup server (Vercel). Receives {name,message,history,langHint} and returns {reply}.
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(200).json({ ok: true, info: "ZONE chat endpoint. Use POST." });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const { name = "User", message = "", history = [], langHint = "" } = body;
    if (!message) return res.status(400).json({ error: "no message" });

    const key = process.env.OPENROUTER_API_KEY;
    if (!key) return res.status(500).json({ error: "OPENROUTER_API_KEY missing" });

    const model = process.env.OPENROUTER_MODEL || "openrouter/free";
    const messages = [{ role: "system", content: langHint || "You are ZONE, a friendly assistant. Reply in one short speakable sentence." }];
    for (const h of history) {
      messages.push({ role: h.role === "assistant" ? "assistant" : "user", content: String(h.text || "") });
    }
    messages.push({ role: "user", content: name + ": " + message });

    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, max_tokens: 200 })
    });
    if (!r.ok) return res.status(502).json({ error: "openrouter status " + r.status });
    const d = await r.json();
    const reply = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
    if (!reply) return res.status(502).json({ error: "empty reply" });
    return res.status(200).json({ reply: String(reply).trim() });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message || e) });
  }
}
