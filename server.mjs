import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { classify as mockClassify } from "./mock-ai.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));

const TOPICS = new Set(["delivery", "pricing", "other"]);
const MODEL_TIMEOUT_MS = 300;
const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };

class ModelTimeoutError extends Error {}

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

// Пустая строка, строка из пробелов, не строка и битый JSON — всё это null.
async function readText(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  try {
    const { text } = JSON.parse(Buffer.concat(chunks).toString("utf8")) ?? {};
    return typeof text === "string" && text.trim() !== "" ? text : null;
  } catch {
    return null;
  }
}

// Таймаут держит Promise.race, а не только signal: модель, которая signal
// не слушает, всё равно не задержит ответ дольше timeoutMs.
async function callModel(classify, text, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ModelTimeoutError());
    }, timeoutMs);
  });
  try {
    return await Promise.race([classify(text, { signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// HTTP 200 от модели ещё не результат: нужен JSON, тема из списка и непустой черновик.
// Ответ собираем только из проверенных полей, лишние поля модели клиенту не уходят.
function parseModelOutput(raw) {
  let output;
  try {
    output = JSON.parse(raw);
  } catch {
    return null;
  }
  const { topic, draft } = output ?? {};
  if (!TOPICS.has(topic)) return null;
  if (typeof draft !== "string" || draft.trim() === "") return null;
  return { topic, draft };
}

async function handleTriage(request, response, { classify, timeoutMs, log }) {
  const text = await readText(request);
  if (text === null) return json(response, 400, { status: "invalid_input" });

  const manualReview = (reason) => {
    log(`[triage] manual_review reason=${reason}`);
    return json(response, 200, MANUAL_REVIEW);
  };

  let raw;
  try {
    raw = await callModel(classify, text, timeoutMs);
  } catch (error) {
    return manualReview(error instanceof ModelTimeoutError ? "timeout" : "model_error");
  }
  const result = parseModelOutput(raw);
  if (result === null) return manualReview("bad_output");
  return json(response, 200, { status: "ready", ...result });
}

export function createApp({ classify = mockClassify, timeoutMs = MODEL_TIMEOUT_MS, log = console.warn } = {}) {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }
    try {
      await handleTriage(request, response, { classify, timeoutMs, log });
    } catch {
      json(response, 500, { status: "server_error" });
    }
  });
}

// Порт слушаем только при запуске `node server.mjs`; тест импортирует createApp.
if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  createApp().listen(Number(process.env.PORT || 3000), "127.0.0.1");
}
