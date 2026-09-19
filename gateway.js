"use strict";

// OpenCode Zen Gateway
// ---------------------------------------------------------------------------
// A self-contained OpenAI-compatible gateway for OpenCode Zen's free models.
//
// The Zen free tier is gated below the HTTP layer: only the genuine OpenCode
// client (its TLS fingerprint and/or embedded secret) is accepted. So this
// gateway does not talk to Zen directly. Instead it spawns and supervises a
// local `opencode serve` process and proxies every request through it.
//
//     OpenAI client -> gateway -> opencode serve -> opencode.ai/zen/v1
//
// Cross-platform: Windows, macOS and Linux.

const http = require("http");
const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const VERSION = "2.0.0";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const HOST = process.env.HOST || "127.0.0.1";
const PORT = parseInt(process.env.PORT || "8899", 10);
const LOCAL_API_KEY = process.env.LOCAL_API_KEY || "";

const OC_HOST = process.env.OPENCODE_SERVER_HOST || "127.0.0.1";
const OC_PORT = parseInt(process.env.OPENCODE_SERVER_PORT || "4096", 10);
const OC_USER = process.env.OPENCODE_SERVER_USERNAME || "opencode";
const OC_PASS = process.env.OPENCODE_SERVER_PASSWORD || "zen-gateway-local";
const OC_AUTH = "Basic " + Buffer.from(`${OC_USER}:${OC_PASS}`).toString("base64");
const OC_AGENT = process.env.OPENCODE_AGENT || "zen";
const OC_BIN = process.env.OPENCODE_BIN || "";
const MANAGE_BACKEND = process.env.MANAGE_BACKEND !== "false";
const BACKEND_START_TIMEOUT_MS = parseInt(process.env.BACKEND_START_TIMEOUT_MS || "60000", 10);

const ROOT = __dirname;
const WORKSPACE = process.env.OPENCODE_WORKSPACE || path.join(ROOT, "workspace");
const CONFIG_FILE = process.env.OPENCODE_CONFIG || path.join(ROOT, "gateway-config.json");
const LOG_FILE = process.env.GATEWAY_LOG || path.join(ROOT, "gateway.log");
const ALERT_WEBHOOK = process.env.ALERT_WEBHOOK || "";

const MODELS_TTL_MS = parseInt(process.env.FREE_MODELS_TTL_MS || "300000", 10);
const READY_TTL_MS = parseInt(process.env.READY_TTL_MS || "60000", 10);
const READY_MODEL = process.env.READY_MODEL || "";

const VISION_MODELS = new Set(
  (process.env.VISION_MODELS || "mimo-v2.5-free").split(",").map((s) => s.trim()).filter(Boolean),
);

// ---------------------------------------------------------------------------
// Logging and alerts
// ---------------------------------------------------------------------------

function log(level, msg, extra) {
  const line = `${new Date().toISOString()} [${level}] ${msg}${extra ? " " + JSON.stringify(extra) : ""}`;
  process.stdout.write(line + "\n");
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {
    /* logging must never break the gateway */
  }
}

function alert(event, detail) {
  log("ALERT", event, detail);
  if (!ALERT_WEBHOOK) return;
  try {
    const url = new URL(ALERT_WEBHOOK);
    const payload = JSON.stringify({ event, detail, time: new Date().toISOString(), host: os.hostname() });
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      { hostname: url.hostname, port: url.port || (url.protocol === "https:" ? 443 : 80), path: url.pathname + url.search, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
      (res) => res.resume(),
    );
    req.on("error", () => {});
    req.setTimeout(5000, () => req.destroy());
    req.end(payload);
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "access-control-allow-origin": "*",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function isFreeId(id) {
  return typeof id === "string" && (id.endsWith("-free") || id === "big-pickle");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// opencode backend lifecycle
// ---------------------------------------------------------------------------

const backend = {
  proc: null,
  external: false,
  starting: false,
  restarts: 0,
  startedAt: 0,
  lastExit: null,
  lastError: null,
};

function resolveOpenCodeBin() {
  if (OC_BIN) return OC_BIN;
  const isWin = process.platform === "win32";
  const home = os.homedir();
  const candidates = [];
  if (isWin) {
    if (process.env.APPDATA) {
      candidates.push(path.join(process.env.APPDATA, "npm", "node_modules", "opencode-ai", "bin", "opencode.exe"));
    }
    if (process.env.LOCALAPPDATA) {
      candidates.push(path.join(process.env.LOCALAPPDATA, "Programs", "opencode", "opencode.exe"));
    }
    if (process.env.ProgramFiles) {
      candidates.push(path.join(process.env.ProgramFiles, "opencode", "opencode.exe"));
    }
  } else {
    candidates.push(
      "/usr/local/bin/opencode",
      "/usr/bin/opencode",
      path.join(home, ".local", "bin", "opencode"),
      path.join(home, ".opencode", "bin", "opencode"),
      path.join(home, ".bun", "bin", "opencode"),
    );
  }
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  // Fall back to PATH resolution.
  return isWin ? "opencode.cmd" : "opencode";
}

function spawnBackend() {
  if (backend.proc || backend.starting) return;
  backend.starting = true;

  const bin = resolveOpenCodeBin();
  const env = { ...process.env, OPENCODE_SERVER_USERNAME: OC_USER, OPENCODE_SERVER_PASSWORD: OC_PASS };
  if (fs.existsSync(CONFIG_FILE)) env.OPENCODE_CONFIG = CONFIG_FILE;
  try {
    fs.mkdirSync(WORKSPACE, { recursive: true });
  } catch {
    /* ignore */
  }

  const args = ["serve", "--port", String(OC_PORT), "--hostname", OC_HOST];
  log("INFO", "spawning opencode backend", { bin, args });

  let child;
  try {
    child = spawn(bin, args, {
      cwd: WORKSPACE,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (e) {
    backend.starting = false;
    backend.lastError = String(e.message || e);
    alert("backend_spawn_failed", { error: backend.lastError, bin });
    return;
  }

  backend.proc = child;
  backend.startedAt = Date.now();
  backend.lastError = null;

  const onData = (buf) => {
    const text = buf.toString().trim();
    if (text) log("BACKEND", text);
  };
  if (child.stdout) child.stdout.on("data", onData);
  if (child.stderr) child.stderr.on("data", onData);

  child.on("error", (err) => {
    backend.lastError = String(err.message || err);
    log("ERROR", "backend process error", { error: backend.lastError });
  });

  child.on("exit", (code, signal) => {
    const uptime = Date.now() - backend.startedAt;
    backend.proc = null;
    backend.starting = false;
    backend.lastExit = { code, signal, at: Date.now() };
    log("WARN", "backend exited", { code, signal, uptime_ms: uptime });
    if (!shuttingDown) {
      backend.restarts += 1;
      const delay = Math.min(30000, 2000 * backend.restarts);
      if (backend.restarts === 1 || backend.restarts % 5 === 0) {
        alert("backend_restarted", { count: backend.restarts, code, signal });
      }
      setTimeout(() => {
        if (!shuttingDown) spawnBackend();
      }, delay);
    }
  });
}

function stopBackend() {
  if (!backend.proc) return;
  const child = backend.proc;
  backend.proc = null;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else {
      child.kill("SIGTERM");
      setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
      }, 5000);
    }
  } catch {
    /* ignore */
  }
}

async function backendReachable(timeoutMs = 3000) {
  try {
    const r = await ocRequest("GET", "/config", null, timeoutMs);
    return r.status === 200;
  } catch {
    return false;
  }
}

async function waitForBackend(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await backendReachable()) return true;
    if (!backend.proc && !backend.starting && !MANAGE_BACKEND) return false;
    await sleep(1000);
  }
  return false;
}

async function ensureBackend() {
  if (await backendReachable()) {
    if (!backend.proc) backend.external = true;
    return true;
  }
  if (!MANAGE_BACKEND) return false;
  backend.external = false;
  if (!backend.proc && !backend.starting) {
    backend.restarts = 0;
    spawnBackend();
  }
  return waitForBackend(BACKEND_START_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// HTTP client for the backend
// ---------------------------------------------------------------------------

function ocRequest(method, urlPath, bodyObj, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const payload = bodyObj ? Buffer.from(JSON.stringify(bodyObj)) : null;
    const headers = { authorization: OC_AUTH, accept: "application/json" };
    if (payload) {
      headers["content-type"] = "application/json";
      headers["content-length"] = payload.length;
    }
    const req = http.request(
      { host: OC_HOST, port: OC_PORT, path: urlPath, method, headers },
      (up) => {
        const chunks = [];
        up.on("data", (c) => chunks.push(c));
        up.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
          resolve({ status: up.statusCode, json, text });
        });
        up.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("backend request timeout")));
    if (payload) req.write(payload);
    req.end();
  });
}

function deleteSession(sessionId) {
  if (!sessionId) return;
  ocRequest("DELETE", `/session/${sessionId}`, null, 10000).catch(() => {});
}

// ---------------------------------------------------------------------------
// Model discovery
// ---------------------------------------------------------------------------

let modelsCache = { at: 0, data: [] };

async function getFreeModels() {
  if (Date.now() - modelsCache.at < MODELS_TTL_MS && modelsCache.data.length) {
    return modelsCache.data;
  }
  const { json } = await ocRequest("GET", "/provider", null, 15000);
  const all = (json && json.all) || [];
  const oc = all.find((p) => p.id === "opencode");
  const list = [];
  if (oc && oc.models) {
    for (const [id, m] of Object.entries(oc.models)) {
      if (!isFreeId(id)) continue;
      const vision = VISION_MODELS.has(id);
      list.push({
        id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "opencode",
        context_length: (m.limit && m.limit.context) || null,
        max_output_tokens: (m.limit && m.limit.output) || null,
        architecture: {
          input_modalities: vision ? ["text", "image"] : ["text"],
          output_modalities: ["text"],
          modality: vision ? "text+image->text" : "text->text",
        },
        capabilities: { vision },
        source: "zen",
      });
    }
  }
  modelsCache = { at: Date.now(), data: list };
  return list;
}

// ---------------------------------------------------------------------------
// Event stream (drives completion + streaming)
// ---------------------------------------------------------------------------

const sessionHandlers = new Map();
let eventStreamReq = null;
let eventBuffer = "";
let reconnectTimer = null;
let eventStreamConnected = false;

function handleEvent(evt) {
  const type = evt.type;
  const props = evt.properties || {};
  const sessionID =
    props.sessionID || (props.part && props.part.sessionID) || (props.info && props.info.sessionID);
  if (!sessionID) return;
  const h = sessionHandlers.get(sessionID);
  if (!h) return;

  const roleOf = (messageID) => h.messageRoles.get(messageID) || null;

  if (type === "message.part.delta") {
    if (props.field === "text" && typeof props.delta === "string") {
      if (roleOf(props.messageID) !== "assistant") return;
      const kind = h.partTypes.get(props.partID) || "content";
      h.partHadDelta.add(props.partID);
      h.onDelta(props.delta, kind);
    }
    return;
  }

  if (type === "message.part.updated") {
    const part = props.part || {};
    if (!part.id || !part.type) return;
    const kind = part.type === "reasoning" ? "reasoning" : part.type === "text" ? "content" : null;
    if (!kind) return;
    h.partTypes.set(part.id, kind);
    if (roleOf(part.messageID) !== "assistant") return;
    if (typeof part.text === "string" && part.text && !h.partHadDelta.has(part.id)) {
      h.onDelta(part.text, kind);
    }
    return;
  }

  if (type === "message.updated") {
    const info = props.info || {};
    if (!info.id || !info.role) return;
    h.messageRoles.set(info.id, info.role);
    if (info.role === "assistant") {
      h.assistantMessageID = info.id;
      if (info.error) h.onError(info.error);
    }
    return;
  }

  if (type === "session.status") {
    const status = props.status || {};
    if (status.type === "idle") h.onDone(null);
    return;
  }
}

function ensureEventStream() {
  if (eventStreamReq) return;
  const req = http.request(
    {
      host: OC_HOST,
      port: OC_PORT,
      path: "/event",
      method: "GET",
      headers: { authorization: OC_AUTH, accept: "text/event-stream" },
    },
    (up) => {
      eventStreamConnected = true;
      up.setEncoding("utf8");
      up.on("data", (chunk) => {
        eventBuffer += chunk;
        let idx;
        while ((idx = eventBuffer.indexOf("\n\n")) !== -1) {
          const raw = eventBuffer.slice(0, idx);
          eventBuffer = eventBuffer.slice(idx + 2);
          for (const line of raw.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data) continue;
            try { handleEvent(JSON.parse(data)); } catch { /* ignore */ }
          }
        }
      });
      const drop = () => {
        eventStreamConnected = false;
        eventStreamReq = null;
        scheduleReconnect();
      };
      up.on("end", drop);
      up.on("error", drop);
    },
  );
  req.on("error", () => {
    eventStreamConnected = false;
    eventStreamReq = null;
    scheduleReconnect();
  });
  req.end();
  eventStreamReq = req;
}

function scheduleReconnect() {
  if (reconnectTimer || shuttingDown) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    ensureEventStream();
  }, 2000);
}

// ---------------------------------------------------------------------------
// Completion (shared by the non-streaming route and the readiness probe)
// ---------------------------------------------------------------------------

function newHandler(overrides) {
  return {
    assistantMessageID: null,
    messageRoles: new Map(),
    partTypes: new Map(),
    partHadDelta: new Set(),
    onDelta: () => {},
    onError: () => {},
    onDone: () => {},
    ...overrides,
  };
}

async function runCompletion({ model, parts, system, timeoutMs = 300000 }) {
  const created = await ocRequest("POST", "/session", {}, 15000);
  const sessionId = created.json && created.json.id;
  if (!sessionId) throw new Error("failed to create session");

  return new Promise((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      sessionHandlers.delete(sessionId);
      deleteSession(sessionId);
      reject(new Error("backend timeout"));
    }, timeoutMs);

    const finish = (fn) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      sessionHandlers.delete(sessionId);
      fn();
    };

    sessionHandlers.set(
      sessionId,
      newHandler({
        onError: (err) =>
          finish(() => {
            deleteSession(sessionId);
            reject(new Error((err.data && err.data.message) || err.name || "model error"));
          }),
        onDone: async () => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          sessionHandlers.delete(sessionId);
          try {
            let last = null;
            for (let attempt = 0; attempt < 3; attempt += 1) {
              const all = await ocRequest("GET", `/session/${sessionId}/message`, null, 15000);
              const arr = Array.isArray(all.json) ? all.json : [];
              const assistants = arr.filter((m) => m.info && m.info.role === "assistant");
              last = assistants[assistants.length - 1];
              if (last && ((last.parts || []).some((p) => p.type === "text" && p.text) || last.info.error)) break;
              await sleep(200);
            }
            deleteSession(sessionId);
            if (!last) return reject(new Error("no assistant message produced"));
            if (last.info.error) {
              return reject(new Error((last.info.error.data && last.info.error.data.message) || last.info.error.name || "model error"));
            }
            const msgParts = last.parts || [];
            resolve({
              content: msgParts.filter((p) => p.type === "text").map((p) => p.text).join(""),
              reasoning: msgParts.filter((p) => p.type === "reasoning").map((p) => p.text).join(""),
              usage: last.info.tokens || {},
              modelID: last.info.modelID,
            });
          } catch (e) {
            reject(e);
          }
        },
      }),
    );

    ocRequest("POST", `/session/${sessionId}/prompt_async`, {
      model: { providerID: "opencode", modelID: model },
      agent: OC_AGENT,
      parts,
      ...(system ? { system } : {}),
    }, 30000).catch((e) =>
      finish(() => {
        deleteSession(sessionId);
        reject(e);
      }),
    );
  });
}

// ---------------------------------------------------------------------------
// Readiness probe (end-to-end, cached)
// ---------------------------------------------------------------------------

let readyCache = { at: 0, ok: false, model: null, latency_ms: null, error: null };

async function probeUpstream() {
  const models = await getFreeModels().catch(() => []);
  const model = READY_MODEL || (models.find((m) => m.id === "mimo-v2.5-free") || models[0] || {}).id;
  if (!model) return { ok: false, model: null, latency_ms: null, error: "no free models available" };
  const started = Date.now();
  try {
    const out = await runCompletion({
      model,
      parts: [{ type: "text", text: "ping" }],
      timeoutMs: 60000,
    });
    return { ok: true, model, latency_ms: Date.now() - started, error: null, sample: (out.content || "").slice(0, 40) };
  } catch (e) {
    return { ok: false, model, latency_ms: Date.now() - started, error: String(e.message || e) };
  }
}

async function handleReady(res, force) {
  const now = Date.now();
  if (!force && readyCache.at && now - readyCache.at < READY_TTL_MS) {
    return sendJSON(res, readyCache.ok ? 200 : 503, { ...readyCache, cached: true });
  }
  const result = await probeUpstream();
  readyCache = { at: Date.now(), ...result };
  if (!result.ok) alert("ready_failed", { model: result.model, error: result.error });
  sendJSON(res, result.ok ? 200 : 503, { ...readyCache, cached: false });
}

// ---------------------------------------------------------------------------
// Request conversion
// ---------------------------------------------------------------------------

function mimeFromDataUrl(url) {
  const m = /^data:([^;,]+)/i.exec(url || "");
  return m ? m[1] : "application/octet-stream";
}

function messagesToPrompt(messages) {
  const parts = [];
  let system = "";
  for (const m of messages) {
    const role = m.role || "user";
    const blocks =
      typeof m.content === "string"
        ? [{ type: "text", text: m.content }]
        : Array.isArray(m.content)
          ? m.content
          : [];

    if (role === "system" || role === "developer") {
      const text = blocks.filter((c) => c && c.type === "text").map((c) => c.text).join("\n");
      if (text) system += (system ? "\n\n" : "") + text;
      continue;
    }

    const label = role === "assistant" ? "[assistant]\n" : "";
    for (const c of blocks) {
      if (!c) continue;
      if (c.type === "text" && typeof c.text === "string" && c.text) {
        parts.push({ type: "text", text: label + c.text });
      } else if (c.type === "image_url") {
        const url = typeof c.image_url === "string" ? c.image_url : c.image_url && c.image_url.url;
        if (url) parts.push({ type: "file", mime: mimeFromDataUrl(url), url });
      }
    }
  }
  return { parts, system };
}

function newCompletionId() {
  return "chatcmpl-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function handleModels(res) {
  try {
    const models = await getFreeModels();
    sendJSON(res, 200, { object: "list", data: models });
  } catch (e) {
    sendJSON(res, 502, { error: { message: String(e.message || e), type: "upstream_error" } });
  }
}

async function handleHealth(res) {
  const reachable = await backendReachable(3000);
  const body = {
    status: reachable ? "ok" : "degraded",
    version: VERSION,
    uptime_s: Math.floor((Date.now() - startedAt) / 1000),
    backend: {
      url: `http://${OC_HOST}:${OC_PORT}`,
      managed: !!backend.proc,
      external: backend.external,
      reachable,
      restarts: backend.restarts,
      pid: backend.proc ? backend.proc.pid : null,
      last_error: backend.lastError,
    },
    event_stream: eventStreamConnected,
    models_cached: modelsCache.data.length,
    ready: { ok: readyCache.ok, at: readyCache.at || null, model: readyCache.model || null },
  };
  sendJSON(res, reachable ? 200 : 503, body);
}

async function handleChatCompletions(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
  } catch {
    return sendJSON(res, 400, { error: { message: "Invalid JSON body", type: "invalid_request_error" } });
  }

  const model = body.model;
  if (!model) {
    return sendJSON(res, 400, { error: { message: "Missing model", type: "invalid_request_error" } });
  }
  const stream = !!body.stream;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const { parts, system } = messagesToPrompt(messages);

  if (!parts.length) {
    return sendJSON(res, 400, { error: { message: "No content in messages", type: "invalid_request_error" } });
  }

  if (!(await ensureBackend())) {
    return sendJSON(res, 503, { error: { message: "opencode backend unavailable", type: "upstream_error" } });
  }

  const id = newCompletionId();
  const created = Math.floor(Date.now() / 1000);

  if (!stream) {
    try {
      const out = await runCompletion({ model, parts, system });
      const usage = out.usage || {};
      return sendJSON(res, 200, {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: out.content || "",
              ...(out.reasoning ? { reasoning_content: out.reasoning } : {}),
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: usage.input || 0,
          completion_tokens: usage.output || 0,
          total_tokens: (usage.input || 0) + (usage.output || 0),
        },
      });
    } catch (e) {
      return sendJSON(res, 502, { error: { message: String(e.message || e), type: "upstream_error" } });
    }
  }

  // Streaming
  let sessionId;
  try {
    const createdSession = await ocRequest("POST", "/session", {}, 15000);
    sessionId = createdSession.json && createdSession.json.id;
    if (!sessionId) throw new Error("failed to create session");
  } catch (e) {
    return sendJSON(res, 502, { error: { message: `backend session error: ${e.message}`, type: "upstream_error" } });
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "access-control-allow-origin": "*",
  });

  let finished = false;
  let sentRole = false;

  const sendChunk = (delta, finishReason) => {
    res.write(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason || null }],
      })}\n\n`,
    );
  };

  const timer = setTimeout(() => {
    if (finished) return;
    finished = true;
    sessionHandlers.delete(sessionId);
    deleteSession(sessionId);
    res.write("data: [DONE]\n\n");
    res.end();
  }, 300000);

  const finish = () => {
    finished = true;
    clearTimeout(timer);
    sessionHandlers.delete(sessionId);
    deleteSession(sessionId);
  };

  sessionHandlers.set(
    sessionId,
    newHandler({
      onDelta: (text, kind) => {
        if (finished || !text) return;
        const delta = {};
        if (!sentRole) {
          delta.role = "assistant";
          sentRole = true;
        }
        if (kind === "reasoning") delta.reasoning_content = text;
        else delta.content = text;
        sendChunk(delta);
      },
      onError: (err) => {
        if (finished) return;
        const message = String((err.data && err.data.message) || err.name || "model error");
        finish();
        res.write(`data: ${JSON.stringify({ error: { message, type: "upstream_error" } })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      },
      onDone: () => {
        if (finished) return;
        finish();
        sendChunk({}, "stop");
        res.write("data: [DONE]\n\n");
        res.end();
      },
    }),
  );

  try {
    await ocRequest(
      "POST",
      `/session/${sessionId}/prompt_async`,
      {
        model: { providerID: "opencode", modelID: model },
        agent: OC_AGENT,
        parts,
        ...(system ? { system } : {}),
      },
      30000,
    );
  } catch (e) {
    if (!finished) {
      finish();
      res.write(`data: ${JSON.stringify({ error: { message: `prompt error: ${e.message}`, type: "upstream_error" } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }
  }
}

function checkAuth(req) {
  if (!LOCAL_API_KEY) return true;
  return (req.headers.authorization || "") === `Bearer ${LOCAL_API_KEY}`;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const startedAt = Date.now();
let shuttingDown = false;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "*",
    });
    return res.end();
  }

  if (url.pathname === "/health" || url.pathname === "/healthz") {
    return void handleHealth(res);
  }

  if (url.pathname === "/ready" || url.pathname === "/readyz") {
    return void handleReady(res, url.searchParams.get("force") === "1");
  }

  if (!checkAuth(req)) {
    return sendJSON(res, 401, { error: { message: "Unauthorized", type: "invalid_request_error" } });
  }

  if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
    return void handleModels(res);
  }

  if (req.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")) {
    return void handleChatCompletions(req, res);
  }

  sendJSON(res, 404, { error: { message: "Not found", type: "invalid_request_error" } });
});

async function main() {
  log("INFO", `gateway v${VERSION} starting`, { host: HOST, port: PORT, manage_backend: MANAGE_BACKEND });
  const ok = await ensureBackend();
  if (!ok) {
    alert("backend_unavailable_at_start", { manage_backend: MANAGE_BACKEND, bin: resolveOpenCodeBin() });
  } else {
    log("INFO", "backend ready", { external: backend.external });
  }
  ensureEventStream();
  server.listen(PORT, HOST, () => {
    log("INFO", `listening on http://${HOST}:${PORT}`);
    log("INFO", `backend   http://${OC_HOST}:${OC_PORT}`);
  });
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("INFO", `shutting down (${signal})`);
  try { if (eventStreamReq) eventStreamReq.destroy(); } catch { /* ignore */ }
  stopBackend();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (err) => log("ERROR", "uncaught exception", { error: String(err && err.message || err) }));
process.on("unhandledRejection", (err) => log("ERROR", "unhandled rejection", { error: String(err && err.message || err) }));

main();
