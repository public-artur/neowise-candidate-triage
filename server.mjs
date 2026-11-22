import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { classify } from "./mock-ai.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));
const utf8 = new TextDecoder("utf-8", { fatal: true });
const topics = new Set(["delivery", "pricing", "other"]);
const manualReview = { status: "manual_review", topic: null, draft: null };

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readText(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  try {
    return JSON.parse(utf8.decode(Buffer.concat(chunks)))?.text;
  } catch {
    return undefined;
  }
}

async function triage(text, classifier) {
  const controller = new AbortController();
  let timer;
  try {
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(controller.signal.reason);
      }, 300);
    });
    const raw = await Promise.race([classifier(text, { signal: controller.signal }), deadline]);
    if (typeof raw !== "string") return manualReview;
    const result = JSON.parse(raw);
    if (result === null || typeof result !== "object" || Array.isArray(result)) return manualReview;
    const { topic, draft } = result;
    if (!topics.has(topic) || typeof draft !== "string" || !draft.trim()) {
      return manualReview;
    }
    return { status: "ready", topic, draft };
  } catch {
    return manualReview;
  } finally {
    clearTimeout(timer);
  }
}

export function createTriageServer(classifier = classify) {
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
      const text = await readText(request);
      if (typeof text !== "string" || !text.trim()) {
        return json(response, 400, { status: "invalid_input" });
      }
      json(response, 200, await triage(text, classifier));
    } catch {
      json(response, 500, { status: "server_error" });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createTriageServer().listen(Number(process.env.PORT || 3000), "127.0.0.1");
}
