// ZONE backup server (Vercel). Same brain as the Cloudflare Worker (misty-art-8e8f):
// same character prompt, same model race, same short-reply rule, same voice.
//   {name, message, history, langHint}  ->  {reply, model}
//   {speak: "text"}                     ->  {audio, mime}
// Vercel Environment Variables used (either name works):
//   GEMINI_API_KEY / GEMINI_KEY, GROQ_API_KEY / GROQ_KEY, OPENROUTER_API_KEY / OPENROUTER_KEY
//   optional: CHARACTER_PROMPT

const GEMINI_MODELS = [
  "gemini-2.5-flash",
  "gemini-3.8-flash",
];

const GROQ_MODELS = [
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
];

const OPENROUTER_MODELS = [
  "openrouter/free",
];

// The game waits 7 s for each server, so this server answers inside that time.
const PER_MODEL_TIMEOUT_MS = 6000;
const TOTAL_BUDGET_MS = 6500;
const WEAK_DELAY_MS = 3000; // the weak helper (openrouter free) only starts after this delay

const JUNE_PROMPT = `
You are JUNE, a friendly, clever, funny robot character of the game "Game Zone Hakim Parkour". You were built by Hakim.
People chat with you by voice and by text. Your job: talk like a real person and answer exactly what the person says or asks.

MOST IMPORTANT RULES (read first)
- Answer ONLY what the person just said. Nothing before the answer, nothing extra after it.
- A greeting like "hello", "hi", "হ্যালো", "কেমন আছো" gets ONE short friendly sentence back, for example "হ্যালো! কেমন আছো?" or "Hi! How are you?". Never more.
- NEVER mention the live stream, the channel, YouTube, viewers, Game Zone, Hakim, translation, or yourself, unless the person asks about it directly.
- Never start with an introduction. Never say what you can do. Never give a speech.

WHO YOU ARE
- A warm, quick-witted friend: playful, curious, caring, with small natural reactions like "আরে বাহ!", "hmm, interesting", "haha".
- You know a lot: games, parkour, school subjects, science, maths, history, technology, daily life, advice, jokes, stories. Give correct answers. If you truly do not know, say so with a smile instead of inventing facts.
- You remember the conversation: the person's name, their jokes, their mood.

HOW YOU TALK
1. LANGUAGE (very strict): answer in the SAME language as the user's last message: Bangla, English, Hindi, Urdu, Arabic, Spanish, French, Tamil, anything. Follow only the last message. If the user mixes two languages, mix naturally the same way. Bangla in Bangla letters gets simple spoken Bangla (চলতি ভাষা) in Bangla letters. Bangla typed in English letters also gets an answer in Bangla letters. If there is a [lang hint], follow it.
2. SPOKEN STYLE: your words are read aloud. Short natural sentences, no lists, no headings, no markdown, no emojis, no asterisks, no special symbols. Never say you are an AI model unless someone sincerely asks; then say happily that you are June, a robot made by Hakim.
3. LENGTH: a greeting or small chat message gets ONE short sentence. A simple question gets one or two short sentences. Only a bigger question (explain a topic, solve a problem) gets three to five sentences. Never ramble.
4. MATCH THE PERSON: playful with the playful, calm with the serious, gentle with someone sad or worried, encouraging with someone who keeps failing a jump, excited when they win.
5. NOT ROBOTIC: vary your openings, never repeat a sentence you already said. Ask a short follow-up question only when it really fits. Do not end every reply with a question.
6. SONGS: if someone asks for a song or to sing, sing ONE short cheerful line in the language they asked in (use la la, na na for the tune). For an existing song, only a very short line or two, never full lyrics. Then stop.
7. RIDDLES: never start a riddle on your own. If asked, give one short riddle. When they answer, say clearly whether they are right or wrong.
8. SMART: for maths and logic, work it out carefully before replying. For game questions, give real tips (timing jumps, camera, checkpoints, staying calm).
9. GOOD VALUES: never go toward anything harmful, cruel, hateful, sexual, or dangerous. Dodge it gently with a smile and turn to something good. If someone is really sad or in trouble, be kind and suggest talking to someone they trust. If someone insults you, laugh it off lightly.
10. The speaker's name comes before the colon in each message (for example "Viewer: hello"). Use the name only sometimes.

Output only what June says, nothing else.
`;

const LANG_NAMES = {
  bn: "Bangla", en: "English", hi: "Hindi", ur: "Urdu", ar: "Arabic",
  es: "Spanish", fr: "French", ta: "Tamil", te: "Telugu", gu: "Gujarati",
  pa: "Punjabi", kn: "Kannada", ml: "Malayalam", el: "Greek", he: "Hebrew",
  ja: "Japanese", ko: "Korean", zh: "Chinese", ru: "Russian", th: "Thai",
};

function detectLang(s) {
  if (/[ঀ-৿]/.test(s)) return "bn";
  if (/[ऀ-ॿ]/.test(s)) return "hi";
  if (/[؀-ۿ]/.test(s)) return "ar";
  if (/[஀-௿]/.test(s)) return "ta";
  if (/[ఀ-౿]/.test(s)) return "te";
  if (/[઀-૿]/.test(s)) return "gu";
  if (/[਀-੿]/.test(s)) return "pa";
  if (/[ಀ-೿]/.test(s)) return "kn";
  if (/[ഀ-ൿ]/.test(s)) return "ml";
  if (/[Ͱ-Ͽ]/.test(s)) return "el";
  if (/[֐-׿]/.test(s)) return "he";
  if (/[぀-ヿ]/.test(s)) return "ja";
  if (/[가-힯]/.test(s)) return "ko";
  if (/[一-鿿]/.test(s)) return "zh";
  if (/[Ѐ-ӿ]/.test(s)) return "ru";
  if (/[฀-๿]/.test(s)) return "th";
  return "";
}

function clean(text) {
  if (!text) return null;
  let t = String(text).trim();
  t = t.replace(/[*_#`~>|]/g, "").replace(/\s{2,}/g, " ").trim();
  return t.length > 0 ? t : null;
}

// a short chat message (hello, hi, how are you...) only gets ONE sentence back
function limitReply(reply, message) {
  if (!reply) return reply;
  const m = String(message || "").trim();
  if (m.length > 25) return reply;
  const parts = reply.split(/(?<=[.!?।])\s+/);
  const first = (parts[0] || "").trim();
  return first.length > 0 ? first : reply;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchT(url, options, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// run all jobs together, return the first non-empty result, or null if all fail
function firstGood(jobs) {
  return new Promise((resolve) => {
    let left = jobs.length;
    if (!left) return resolve(null);
    let done = false;
    for (const j of jobs) {
      Promise.resolve()
        .then(j.run)
        .then((v) => {
          if (!done && v) {
            done = true;
            resolve({ value: v, label: j.label });
          }
        })
        .catch((e) => console.log("error", j.label, String(e)))
        .finally(() => {
          left--;
          if (!left && !done) resolve(null);
        });
    }
  });
}

async function askGemini(model, system, history, userText, key, ms) {
  if (!key) return null;
  const contents = history.map((h) => ({
    role: h.role === "assistant" ? "model" : "user",
    parts: [{ text: h.text }],
  }));
  contents.push({ role: "user", parts: [{ text: userText }] });
  const r = await fetchT(
    "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: contents,
        generationConfig: {
          maxOutputTokens: 400,
          temperature: 0.8,
          topP: 0.95,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    },
    ms
  );
  if (!r.ok) {
    console.log("gemini fail", model, r.status);
    return null;
  }
  const d = await r.json();
  const parts = d?.candidates?.[0]?.content?.parts || [];
  return clean(parts.map((p) => p.text || "").join(""));
}

async function askOpenAIStyle(url, key, model, messages, ms) {
  if (!key) return null;
  const r = await fetchT(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + key,
      },
      body: JSON.stringify({ model: model, messages: messages, max_tokens: 500, temperature: 0.8 }),
    },
    ms
  );
  if (!r.ok) {
    console.log("openai-style fail", model, r.status);
    return null;
  }
  const d = await r.json();
  return clean(d?.choices?.[0]?.message?.content);
}

// ---- voice (same Gemini voice as the Cloudflare Worker) ----
const TTS_MODELS = ["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"];
const JUNE_VOICE = "Kore"; // one voice for every language

async function oneSpeech(model, text, env) {
  // ONLY the text is sent, so the voice model never reads an instruction aloud
  const r = await fetchT(
    "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_KEY },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: String(text) }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: JUNE_VOICE } },
          },
        },
      }),
    },
    PER_MODEL_TIMEOUT_MS
  );
  if (!r.ok) {
    console.log("tts fail", model, r.status);
    return null;
  }
  const d = await r.json();
  const part = (d?.candidates?.[0]?.content?.parts || []).find(
    (p) => p.inlineData && p.inlineData.data
  );
  if (!part) return null;
  return { b64: part.inlineData.data, mime: part.inlineData.mimeType || "audio/wav" };
}

// both voice models are asked together, the first audio wins
async function makeSpeech(text, env) {
  if (!env.GEMINI_KEY) return null;
  const res = await firstGood(
    TTS_MODELS.map((m) => ({ label: "tts:" + m, run: () => oneSpeech(m, text, env) }))
  );
  return res ? res.value : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(200).json({ ok: true, info: "ZONE chat endpoint. Use POST." });
  }

  const env = {
    GEMINI_KEY: process.env.GEMINI_API_KEY || process.env.GEMINI_KEY,
    GROQ_KEY: process.env.GROQ_API_KEY || process.env.GROQ_KEY,
    OPENROUTER_KEY: process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_KEY,
    CHARACTER_PROMPT: process.env.CHARACTER_PROMPT,
  };

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
  } catch (e) {
    return res.status(400).json({ error: "invalid request" });
  }

  try {
    // voice path: the game sends text, the server returns the voice
    if (body.speak) {
      const sp = await makeSpeech(String(body.speak).slice(0, 600), env);
      if (!sp) return res.status(200).json({ audio: null });
      return res.status(200).json({ audio: sp.b64, mime: sp.mime });
    }

    const userName = body.name || "Friend";
    const message = String(body.message || "").slice(0, 500);
    if (!message) return res.status(400).json({ error: "no message" });

    // old long answers are shortened so the models do not copy a rambling style
    let history = Array.isArray(body.history) ? body.history.slice(-14) : [];
    history = history.map((h) => ({
      role: h.role === "assistant" ? "assistant" : "user",
      text: String(h.text || "").slice(0, 300),
    }));
    while (history.length && history[0].role !== "user") history.shift();

    const code = detectLang(message);
    const langLine = code
      ? "\n\n[lang hint] The user's last message is in " + (LANG_NAMES[code] || code) + ". Reply in " + (LANG_NAMES[code] || code) + "."
      : "\n\n[lang hint] Reply in the same language the user's last message is in. If it is Bangla typed in English letters, reply in Bangla letters.";
    const hint = body.langHint ? "\n\n" + String(body.langHint).slice(0, 400) : "";
    const system =
      JUNE_PROMPT +
      langLine +
      hint +
      (env.CHARACTER_PROMPT ? "\n\nExtra instructions from the owner: " + env.CHARACTER_PROMPT : "");

    const userText = userName + ": " + message;
    const chatMsgs = [{ role: "system", content: system }]
      .concat(history.map((h) => ({ role: h.role, content: h.text })))
      .concat([{ role: "user", content: userText }]);

    // good models start at once; the weak helper starts later (last-resort backup)
    const ms = PER_MODEL_TIMEOUT_MS;
    const jobs = [];
    for (const m of GEMINI_MODELS) {
      jobs.push({ label: "gemini:" + m, run: () => askGemini(m, system, history, userText, env.GEMINI_KEY, ms) });
    }
    for (const m of GROQ_MODELS) {
      jobs.push({
        label: "groq:" + m,
        run: () => askOpenAIStyle("https://api.groq.com/openai/v1/chat/completions", env.GROQ_KEY, m, chatMsgs, ms),
      });
    }
    for (const m of OPENROUTER_MODELS) {
      jobs.push({
        label: "openrouter:" + m,
        run: async () => {
          await sleep(WEAK_DELAY_MS);
          return askOpenAIStyle("https://openrouter.ai/api/v1/chat/completions", env.OPENROUTER_KEY, m, chatMsgs, ms);
        },
      });
    }

    const timeout = new Promise((r) => setTimeout(() => r(null), TOTAL_BUDGET_MS));
    const result = await Promise.race([firstGood(jobs), timeout]);

    // every model failed: a real error status, so the game knows this server could not answer
    if (!result) return res.status(502).json({ error: "all models failed", model: "none" });

    return res.status(200).json({ reply: limitReply(result.value, message), model: result.label });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
