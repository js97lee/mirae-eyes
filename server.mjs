import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.join(__dirname, ".env");

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8");
  raw.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) return;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) process.env[key] = value;
  });
}

loadDotEnv(envPath);

const PORT = Number(process.env.PORT || 8080);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const indexPath = path.join(__dirname, "index.html");

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(JSON.stringify(payload));
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk.toString("utf8");
      if (body.length > 1_000_000) {
        reject(new Error("Body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function classifyEmotionWithGpt(text, history = []) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  const ids = ["joy", "sad", "angry", "fear", "disgust", "surprise", "trust", "hope"];
  const systemPrompt = [
    "너는 한국어 대화 맥락 기반 감정 분류기다.",
    `반드시 다음 감정 id 중 하나만 선택: ${ids.join(", ")}.`,
    "화자가 여러 명이어도 전체 최근 맥락의 지배적 정서를 고른다.",
    "부정 표현(안, 못, 별로), 반전 접속사(근데, 하지만), 강조(진짜, 너무)를 반영한다.",
    '반드시 JSON만 출력: {"emotion":"joy|sad|angry|fear|disgust|surprise|trust|hope","confidence":0~1,"reason":"짧은 한국어 근거"}'
  ].join(" ");

  const userPrompt = JSON.stringify({
    text,
    history: history.slice(-6)
  });

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI error ${response.status}: ${errText.slice(0, 300)}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content || "{}";

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = {};
  }

  const emotion = ids.includes(parsed.emotion) ? parsed.emotion : "trust";
  const confidence = Number.isFinite(Number(parsed.confidence))
    ? Math.max(0, Math.min(1, Number(parsed.confidence)))
    : 0.45;
  const reason = typeof parsed.reason === "string" ? parsed.reason : "맥락 기반 기본 분류";

  return { emotion, confidence, reason };
}

const server = http.createServer(async (req, res) => {
  try {
    const { method = "GET", url = "/" } = req;

    if (method === "OPTIONS") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === "POST" && url === "/api/emotion") {
      const rawBody = await readRequestBody(req);
      const body = rawBody ? JSON.parse(rawBody) : {};
      const text = String(body.text || "").trim();
      const history = Array.isArray(body.history) ? body.history.map(v => String(v)) : [];

      if (!text) {
        sendJson(res, 400, { ok: false, error: "text is required" });
        return;
      }

      const result = await classifyEmotionWithGpt(text, history);
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    if (method === "GET" && (url === "/" || url === "/index.html")) {
      const html = fs.readFileSync(indexPath, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    sendJson(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown server error"
    });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Server running at http://127.0.0.1:${PORT}`);
  console.log("Use .env or env var for OPENAI_API_KEY.");
});
