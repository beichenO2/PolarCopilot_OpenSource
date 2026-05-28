#!/usr/bin/env node
/**
 * hub-mcp-server — MCP bridge for PolarCopilot Hub (standalone)
 *
 * Replaces the bash curl+sleep polling loop with native MCP long-poll.
 * Each instance is one "agent slot" identified by HUB_SESSION env var.
 *
 * Environment:
 *   HUB_SESSION     — slot number (1..10), used for session file isolation
 *   HUB_PORT        — override Hub port (auto-discovered if omitted)
 *   PC_PROJECT_DIR  — project root (default: cwd passed by Cursor)
 *   HUB_AGENT_ROLE  — role prefix for new agent_id (default: "hw")
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createHash, randomUUID } from "crypto";
import http from "http";

// ─── Config ────────────────────────────────────────────────────────────────
const HOME = homedir();
const SESSION_KEY = (process.env.HUB_SESSION || "1").trim();
const PROJECT_DIR = (process.env.PC_PROJECT_DIR || process.cwd()).trim();
const ROLE_PREFIX = (process.env.HUB_AGENT_ROLE || "hw").trim();
const POLL_INTERVAL_MS = 2000;
const HUB_DISCOVER_PORTS = [8040, 8765, 3850, 3851, 3852, 9020, 3000, 3001];

const projHash = createHash("md5").update(PROJECT_DIR).digest("hex").slice(0, 4);
const stateDir = join(HOME, ".cursor", "hub-mcp-state", "s", SESSION_KEY);
const stateFile = join(stateDir, "state.json");

// ─── Persistent state ──────────────────────────────────────────────────────
let state = {
  hubPort: process.env.HUB_PORT ? Number(process.env.HUB_PORT) : 0,
  agentId: "",
  promptId: "",
  projHash,
  projectDir: PROJECT_DIR,
};

function loadState() {
  try {
    if (existsSync(stateFile)) {
      const saved = JSON.parse(readFileSync(stateFile, "utf-8"));
      if (saved.projHash === projHash) {
        state = { ...state, ...saved };
      }
    }
  } catch { /* start fresh */ }
}

function saveState() {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf-8");
}

loadState();

// ─── HTTP helpers (zero-dependency) ────────────────────────────────────────
function httpJson(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const port = state.hubPort;
    if (!port) return reject(new Error("Hub port not discovered"));
    const payload = body ? JSON.stringify(body) : undefined;
    const opts = {
      hostname: "127.0.0.1",
      port,
      path,
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Agent-Id": state.agentId || "",
        ...headers,
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
      },
      timeout: 5000,
    };
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data: { raw: data } });
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    if (payload) req.write(payload);
    req.end();
  });
}

function httpGet(path, headers = {}) {
  return httpJson("GET", path, null, headers);
}

// ─── SSE helper for /api/ui/prompts/:id/stream ─────────────────────────────
function sseWaitAnswer(promptId, signal) {
  return new Promise((resolve, reject) => {
    const port = state.hubPort;
    if (!port) return reject(new Error("Hub port not discovered"));

    const opts = {
      hostname: "127.0.0.1",
      port,
      path: `/api/ui/prompts/${promptId}/stream`,
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        "X-Agent-Id": state.agentId || "",
      },
      timeout: 0,
    };

    const req = http.request(opts, (res) => {
      let buffer = "";
      res.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        let eventType = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            const raw = line.slice(6).trim();
            try {
              const parsed = JSON.parse(raw);
              if (eventType === "answered" || eventType === "superseded") {
                req.destroy();
                resolve({ event: eventType, ...parsed });
              } else if (eventType === "error") {
                req.destroy();
                reject(new Error(parsed.error || "SSE error"));
              }
            } catch { /* partial json, wait for more */ }
            eventType = "";
          }
        }
      });
      res.on("end", () => reject(new Error("SSE stream ended without answer")));
      res.on("error", reject);
    });

    req.on("error", reject);

    if (signal) {
      const onAbort = () => { req.destroy(); reject(new Error("aborted")); };
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    req.end();
  });
}

// ─── Hub discovery ─────────────────────────────────────────────────────────
function probePort(port) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        timeout: 3000,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          const lower = body.toLowerCase();
          resolve(lower.includes("hub") || lower.includes("polarcop"));
        });
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "hub-mcp", version: "1.0" } },
        id: 0,
      }),
    );
    req.end();
  });
}

async function discoverHub() {
  if (state.hubPort && (await probePort(state.hubPort))) return state.hubPort;

  // Try port-sdk registry
  try {
    const res = await httpJson("GET", "/api/ports", null, {});
    // httpJson uses state.hubPort which might be 0, so use raw http
  } catch { /* ignore */ }

  // Try reading session file from pc-os-solo-web
  try {
    const sessionFile = `/tmp/pc-os-solo-web-${projHash}.env`;
    if (existsSync(sessionFile)) {
      const content = readFileSync(sessionFile, "utf-8");
      // Session file doesn't store port, but we can try hub log
      const logFile = `/tmp/pc-hub-${projHash}.log`;
      if (existsSync(logFile)) {
        const log = readFileSync(logFile, "utf-8").slice(-2000);
        const match = log.match(/listening.*?(\d{4,5})/i);
        if (match) {
          const p = Number(match[1]);
          if (await probePort(p)) { state.hubPort = p; return p; }
        }
      }
    }
  } catch { /* ignore */ }

  // Try lsof
  try {
    const lsofOut = execSync("lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null | grep node", { encoding: "utf-8", timeout: 3000 });
    const portMatches = [...lsofOut.matchAll(/:(\d{4,5})\s/g)].map((m) => Number(m[1]));
    for (const p of [...new Set(portMatches)]) {
      if (await probePort(p)) { state.hubPort = p; return p; }
    }
  } catch { /* ignore */ }

  // Fixed candidates
  for (const p of HUB_DISCOVER_PORTS) {
    if (await probePort(p)) { state.hubPort = p; return p; }
  }

  return 0;
}

// ─── Agent ID helpers ──────────────────────────────────────────────────────
function newAgentId() {
  const short = randomUUID().replace(/-/g, "").slice(0, 8);
  return `${ROLE_PREFIX}-${short}`;
}

// ─── Sleep with abort ──────────────────────────────────────────────────────
function sleepWithAbort(signal, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(true), ms);
    const onAbort = () => { clearTimeout(timer); resolve(false); };
    if (signal?.aborted) { onAbort(); return; }
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

// ─── System suffix (behavioral guardrails for the LLM) ─────────────────────
function buildSystemSuffix() {
  let suffix = "\n\n---\n[MANDATORY INSTRUCTION]\n";
  suffix += `工作区：${PROJECT_DIR}\n`;
  suffix += `【Hub MCP 通道】hub-agent-${SESSION_KEY}：本进程桥接 Hub Web UI。\n\n`;
  suffix += [
    `以上是用户通过 Hub Web 回答的内容。`,
    ``,
    `【必须先做】直接根据用户选择/回答执行对应任务，不要解释 MCP/Hub 机制。`,
    `【禁止】用\u201C工具已验证\u201D\u201C通道正常\u201D等套话代替实质工作。`,
    ``,
    `完成当前任务后，用 send_prompt 向 Hub 提交结果报告（必须带 options），`,
    `然后立刻调用 check_hub() 等待用户下一条指令。永不主动终止对话。`,
    `[END]`,
  ].join("\n");
  return suffix;
}

// ═══════════════════════════════════════════════════════════════════════════
//  MCP Server
// ═══════════════════════════════════════════════════════════════════════════
const serverName = `hub-agent-${SESSION_KEY}`;
const server = new McpServer({ name: serverName, version: "1.0.0" });

// ── Tool 1: setup ──────────────────────────────────────────────────────────
server.registerTool(
  "setup",
  {
    title: "Hub 初始化",
    description:
      "发现 Hub、注册 Agent、创建首条 prompt。首次使用或 Hub 重启后调用一次即可。" +
      "返回 agent_id / prompt_id / hub_port，后续工具自动复用。",
    inputSchema: z.object({
      display_name: z
        .string()
        .optional()
        .describe("Agent display name (default: pending-rename)"),
      prompt: z
        .string()
        .optional()
        .describe("First prompt text (default: ready for instructions)"),
      options: z
        .array(z.string())
        .optional()
        .describe("First prompt options (default: 3 options)"),
      force_new_id: z
        .boolean()
        .optional()
        .describe("Force a brand-new agent_id, skip reuse"),
    }),
  },
  async ({ display_name, prompt, options, force_new_id }) => {
    const displayName = display_name || "pending-rename";
    const promptText = prompt || "已就绪，等待指令";
    const opts = options || ["继续上次的工作", "查看项目进度", "执行新任务"];

    // 1) Discover Hub
    const port = await discoverHub();
    if (!port) {
      return { content: [{ type: "text", text: "ERROR: 无法发现运行中的 Hub。请先启动 Hub 进程。" }], isError: true };
    }
    state.hubPort = port;

    // 2) Agent ID — reuse or create
    if (force_new_id || !state.agentId) {
      state.agentId = newAgentId();
    }

    // 3) Register + first prompt
    try {
      const res = await httpJson("POST", "/api/ui/agents/register", {
        agent_id: state.agentId,
        display_name: displayName,
        prompt: promptText,
        options: opts,
      });

      if (res.status === 409) {
        // agent_id collision — retry with new id
        state.agentId = newAgentId();
        const retry = await httpJson("POST", "/api/ui/agents/register", {
          agent_id: state.agentId,
          display_name: displayName,
          prompt: promptText,
          options: opts,
        });
        if (retry.status >= 400) {
          return { content: [{ type: "text", text: `ERROR: 注册失败 (retry): ${JSON.stringify(retry.data)}` }], isError: true };
        }
        state.promptId = retry.data.prompt_id;
      } else if (res.status >= 400) {
        return { content: [{ type: "text", text: `ERROR: 注册失败: ${JSON.stringify(res.data)}` }], isError: true };
      } else {
        state.promptId = res.data.prompt_id;
      }
    } catch (err) {
      return { content: [{ type: "text", text: `ERROR: 注册异常: ${err.message}` }], isError: true };
    }

    saveState();

    const projectName = PROJECT_DIR.split("/").pop();
    const readyLine = `HUB_MCP_READY project=${projectName} hash=${projHash} hub_port=${state.hubPort} agent_id=${state.agentId} prompt_id=${state.promptId}`;

    return {
      content: [{ type: "text", text: readyLine }],
    };
  },
);

// ── Tool 2: check_hub ──────────────────────────────────────────────────────
server.registerTool(
  "check_hub",
  {
    title: "等待 Hub 回答（长轮询）",
    description:
      "阻塞等待用户在 Hub Web 上回答当前 prompt。收到回答后返回 answer + freeform_text。" +
      "处理完后必须再次调用 check_hub 保持循环。" +
      "如果 Hub 未初始化，会自动调用 setup 流程。",
    inputSchema: z.object({
      prompt_id: z
        .string()
        .optional()
        .describe("prompt_id to wait for (defaults to latest)"),
    }),
  },
  async ({ prompt_id }, extra) => {
    const pid = prompt_id || state.promptId;
    if (!pid) {
      return { content: [{ type: "text", text: "ERROR: 没有 prompt_id。请先调用 setup 或 send_prompt。" }], isError: true };
    }

    if (!state.hubPort) {
      const port = await discoverHub();
      if (!port) {
        return { content: [{ type: "text", text: "ERROR: Hub 不可达。请先调用 setup。" }], isError: true };
      }
    }

    // Try SSE first (zero-poll, efficient)
    try {
      const result = await sseWaitAnswer(pid, extra.signal);
      const suffix = buildSystemSuffix();

      if (result.event === "superseded") {
        return {
          content: [{ type: "text", text: `[superseded] 此 prompt 已被新 prompt 取代。请用最新 prompt_id 调用 check_hub。${suffix}` }],
        };
      }

      const answer = result.answer || "";
      const freeform = result.freeform_text || "";
      let text = `ANSWER_RECEIVED: ${answer}`;
      if (freeform) text += `\nFREEFORM: ${freeform}`;
      text += suffix;

      return { content: [{ type: "text", text }] };
    } catch (sseErr) {
      if (sseErr.message === "aborted") {
        return { content: [{ type: "text", text: "[system] check_hub 等待被取消。" }], isError: true };
      }
      // SSE failed — fallback to polling
    }

    // Fallback: HTTP polling
    while (!extra.signal.aborted) {
      try {
        const res = await httpGet(`/api/ui/prompts/${pid}`);
        if (res.data?.answered || res.data?.answeredAt) {
          const answer = res.data.answer || "";
          const freeform = res.data.freeform_text || "";
          const suffix = buildSystemSuffix();
          let text = `ANSWER_RECEIVED: ${answer}`;
          if (freeform) text += `\nFREEFORM: ${freeform}`;
          text += suffix;
          return { content: [{ type: "text", text }] };
        }
      } catch { /* Hub temporarily unreachable, retry */ }

      if (!(await sleepWithAbort(extra.signal, POLL_INTERVAL_MS))) {
        return { content: [{ type: "text", text: "[system] check_hub 等待被取消。" }], isError: true };
      }
    }

    return { content: [{ type: "text", text: "[system] check_hub 等待被取消。" }], isError: true };
  },
);

// ── Tool 3: send_prompt ────────────────────────────────────────────────────
server.registerTool(
  "send_prompt",
  {
    title: "向 Hub 发送 prompt",
    description:
      "创建新的选择型 prompt（Agent → 用户）。返回新 prompt_id，自动更新内部状态。" +
      "之后调用 check_hub 等待回答。",
    inputSchema: z.object({
      prompt: z.string().describe("Prompt content (Markdown supported)"),
      options: z.array(z.string()).min(1).describe("Options for the user to choose from"),
      display_name: z
        .string()
        .optional()
        .describe("显示在网页卡片上的名称（多 Agent 时建议每次发问前设置，如「前端:修登录」）"),
    }),
  },
  async ({ prompt: promptText, options, display_name }) => {
    if (!state.hubPort || !state.agentId) {
      return { content: [{ type: "text", text: "ERROR: Hub 未初始化。请先调用 setup。" }], isError: true };
    }

    try {
      if (display_name?.trim()) {
        const patch = await httpJson("PATCH", `/api/ui/agents/${state.agentId}`, {
          display_name: display_name.trim(),
        });
        if (patch.status >= 400) {
          return { content: [{ type: "text", text: `ERROR: 更新 display_name 失败: ${JSON.stringify(patch.data)}` }], isError: true };
        }
      }

      const res = await httpJson("POST", "/api/ui/prompts", {
        agent_id: state.agentId,
        prompt: promptText,
        options,
      });

      if (res.status === 409 && res.data?.error === "pending_choice_exists") {
        return {
          content: [{
            type: "text",
            text: `BLOCKED: 上一个 prompt 尚未回答（pending_choice_exists）。请先用 check_hub 等待回答，不要创建新 prompt。当前 prompt_id=${state.promptId}`,
          }],
        };
      }

      if (res.status >= 400) {
        return { content: [{ type: "text", text: `ERROR: 创建 prompt 失败: ${JSON.stringify(res.data)}` }], isError: true };
      }

      state.promptId = res.data.id || res.data.prompt_id;
      saveState();

      return {
        content: [{ type: "text", text: `PROMPT_SENT prompt_id=${state.promptId}` }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
    }
  },
);

// ── Tool 4: patch_agent ────────────────────────────────────────────────────
server.registerTool(
  "patch_agent",
  {
    title: "更新 Agent 属性",
    description: "更新 Agent 在 Hub Web 上的显示名或其他属性。每轮任务切换时应自命名。",
    inputSchema: z.object({
      display_name: z.string().describe("New display name, format: role:action"),
    }),
  },
  async ({ display_name }) => {
    if (!state.hubPort || !state.agentId) {
      return { content: [{ type: "text", text: "ERROR: Hub 未初始化。请先调用 setup。" }], isError: true };
    }
    try {
      const res = await httpJson("PATCH", `/api/ui/agents/${state.agentId}`, { display_name });
      if (res.status >= 400) {
        return { content: [{ type: "text", text: `ERROR: PATCH 失败: ${JSON.stringify(res.data)}` }], isError: true };
      }
      return { content: [{ type: "text", text: `OK: display_name → "${display_name}"` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
    }
  },
);

// ── Tool 5: hub_status ─────────────────────────────────────────────────────
server.registerTool(
  "hub_status",
  {
    title: "Hub 连接状态",
    description: "查看当前 Hub 连接、Agent 注册、最新 prompt 等状态信息。",
    inputSchema: z.object({}),
  },
  async () => {
    const lines = [
      `hub_port: ${state.hubPort || "(未发现)"}`,
      `agent_id: ${state.agentId || "(未注册)"}`,
      `prompt_id: ${state.promptId || "(无)"}`,
      `project_dir: ${PROJECT_DIR}`,
      `proj_hash: ${projHash}`,
      `session: ${SESSION_KEY}`,
    ];

    if (state.hubPort) {
      try {
        const res = await httpGet("/api/ui/agents");
        const agents = Array.isArray(res.data) ? res.data : [];
        lines.push(`hub_agents: ${agents.length}`);
        const mine = agents.find((a) => a.agent_id === state.agentId);
        if (mine) {
          lines.push(`my_status: ${mine.agentStatus || mine.agent_status || "unknown"}`);
          lines.push(`my_display_name: ${mine.displayName || mine.display_name || "unknown"}`);
        }
      } catch { lines.push("hub_agents: (查询失败)"); }
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

// ═══════════════════════════════════════════════════════════════════════════
//  Inter-MCP Communication (peer-to-peer message bus)
// ═══════════════════════════════════════════════════════════════════════════
const BUS_DIR = join(HOME, ".cursor", "hub-mcp-state", "bus");
const INBOX_DIR = join(BUS_DIR, "inbox");
const PRESENCE_DIR = join(BUS_DIR, "presence");
const BUS_POLL_MS = 1000;

function ensureBusDirs() {
  for (const d of [BUS_DIR, INBOX_DIR, PRESENCE_DIR]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}

function myInboxDir() {
  const dir = join(INBOX_DIR, SESSION_KEY);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function writePresence() {
  ensureBusDirs();
  const file = join(PRESENCE_DIR, `${SESSION_KEY}.json`);
  writeFileSync(file, JSON.stringify({
    session: SESSION_KEY,
    agentId: state.agentId,
    hubPort: state.hubPort,
    projectDir: PROJECT_DIR,
    serverName,
    pid: process.pid,
    ts: Date.now(),
  }, null, 2), "utf-8");
}

const PRESENCE_INTERVAL = setInterval(() => {
  try { writePresence(); } catch { /* ignore */ }
}, 5000);
process.on("exit", () => {
  clearInterval(PRESENCE_INTERVAL);
  try {
    const f = join(PRESENCE_DIR, `${SESSION_KEY}.json`);
    if (existsSync(f)) unlinkSync(f);
  } catch { /* best effort */ }
});
writePresence();

function readInbox() {
  const dir = myInboxDir();
  try {
    const files = readdirSync(dir).filter(f => f.endsWith(".json")).sort();
    return files;
  } catch { return []; }
}

// Peek at the first message without deleting it.
// deferredSet: filenames to skip (files we've already deferred this listen session).
// Returns { msg, filePath, filename } or null if inbox is empty.
function peekFirstMsg(deferredSet) {
  const dir = myInboxDir();
  const files = readdirSync(dir)
    .filter(f => f.endsWith(".json") && !deferredSet.has(f))
    .sort();
  if (files.length === 0) return null;
  const filePath = join(dir, files[0]);
  try {
    const msg = JSON.parse(readFileSync(filePath, "utf-8"));
    return { msg, filePath, filename: files[0] };
  } catch {
    // Corrupt file — remove and continue
    try { unlinkSync(filePath); } catch { /* ignore */ }
    return null;
  }
}

// Delete a consumed message file.
function consumeMsg(filePath) {
  try { unlinkSync(filePath); } catch { /* ignore */ }
}

// ── Tool 6: broadcast ──────────────────────────────────────────────────────
server.registerTool(
  "broadcast",
  {
    title: "Send message to peer MCP",
    description:
      "Send a message to one or all peer hub-agent instances. " +
      "Use target='all' to broadcast, or target='3' to send to hub-agent-3. " +
      "Peers pick up messages via the 'listen' tool.",
    inputSchema: z.object({
      target: z.string().describe("Target session key: a number (e.g. '3') or 'all'"),
      channel: z.string().optional().describe("Optional channel/topic name for filtering"),
      message: z.string().describe("Message content (plain text or JSON string)"),
    }),
  },
  async ({ target, channel, message }) => {
    ensureBusDirs();
    const ts = Date.now();
    const msgObj = {
      from: SESSION_KEY,
      fromAgent: state.agentId,
      channel: channel || "default",
      message,
      ts,
    };
    const filename = `${ts}-${SESSION_KEY}.json`;
    const payload = JSON.stringify(msgObj, null, 2);

    if (target === "all") {
      const presenceFiles = readdirSync(PRESENCE_DIR).filter(f => f.endsWith(".json"));
      let sent = 0;
      for (const pf of presenceFiles) {
        const peerKey = pf.replace(".json", "");
        if (peerKey === SESSION_KEY) continue;
        const inboxDir = join(INBOX_DIR, peerKey);
        if (!existsSync(inboxDir)) mkdirSync(inboxDir, { recursive: true });
        writeFileSync(join(inboxDir, filename), payload, "utf-8");
        sent++;
      }
      return { content: [{ type: "text", text: `BROADCAST_SENT to=${sent} peers channel=${channel || "default"}` }] };
    } else {
      const inboxDir = join(INBOX_DIR, target);
      if (!existsSync(inboxDir)) mkdirSync(inboxDir, { recursive: true });
      writeFileSync(join(inboxDir, filename), payload, "utf-8");
      return { content: [{ type: "text", text: `MSG_SENT to=hub-agent-${target} channel=${channel || "default"}` }] };
    }
  },
);

// ── Tool 7: listen ─────────────────────────────────────────────────────────
server.registerTool(
  "listen",
  {
    title: "Listen for peer messages (long-poll)",
    description:
      "Block until a message arrives from another hub-agent. " +
      "Optionally filter by channel. Returns the first matching message.",
    inputSchema: z.object({
      channel: z.string().optional().describe("Only return messages on this channel (default: any)"),
      timeout_ms: z.number().optional().describe("Max wait time in ms (default: 300000 = 5 min)"),
    }),
  },
  async ({ channel, timeout_ms }, extra) => {
    const maxWait = timeout_ms || 300000;
    const start = Date.now();
    // How many poll iterations a non-matching file can survive before being dropped.
    // A new message arriving on the target channel will be found immediately.
    const MAX_DEFERRALS = 5;
    // deferredSet tracks filenames we've already seen/skipped this listen call
    const deferredSet = new Set();

    while (!extra.signal.aborted) {
      const peek = peekFirstMsg(deferredSet);
      if (peek) {
        const { msg, filePath, filename } = peek;
        if (!channel || msg.channel === channel) {
          // Matched — delete and return
          consumeMsg(filePath);
          deferredSet.delete(filename);
          return {
            content: [{
              type: "text",
              text: [
                `PEER_MSG from=hub-agent-${msg.from} agent_id=${msg.fromAgent || "?"}`,
                `channel=${msg.channel} ts=${msg.ts}`,
                `message=${msg.message}`,
              ].join("\n"),
            }],
          };
        } else {
          // Non-matching message — defer it (skip this poll iteration)
          deferredSet.add(filename);
          // If we've now deferred as many files as there are in the inbox,
          // every known message has been checked and none matched → sleep and retry
          const remaining = readInbox().filter(f => f.endsWith(".json") && !deferredSet.has(f));
          if (remaining.length === 0) {
            // All known messages deferred — sleep then poll again (new messages may have arrived)
            if (Date.now() - start > maxWait) {
              return { content: [{ type: "text", text: `LISTEN_TIMEOUT after ${maxWait}ms — no messages received.` }] };
            }
            if (!(await sleepWithAbort(extra.signal, BUS_POLL_MS))) {
              return { content: [{ type: "text", text: "[system] listen cancelled." }], isError: true };
            }
            // After sleeping, reset deferredSet so we re-examine all files in the next poll
            // (a new matching message may have arrived, or we should re-check others)
            deferredSet.clear();
          }
          // Otherwise there are still un-deferred messages to check — continue the loop
          continue;
        }
      }

      if (Date.now() - start > maxWait) {
        return { content: [{ type: "text", text: `LISTEN_TIMEOUT after ${maxWait}ms — no messages received.` }] };
      }

      if (!(await sleepWithAbort(extra.signal, BUS_POLL_MS))) {
        return { content: [{ type: "text", text: "[system] listen cancelled." }], isError: true };
      }
    }
    return { content: [{ type: "text", text: "[system] listen cancelled." }], isError: true };
  },
);

// ── Tool 8: list_peers ─────────────────────────────────────────────────────
server.registerTool(
  "list_peers",
  {
    title: "List active hub-agent peers",
    description:
      "Show all hub-agent instances that are currently alive (based on heartbeat). " +
      "Returns session key, agent_id, pid, and last heartbeat for each peer.",
    inputSchema: z.object({}),
  },
  async () => {
    ensureBusDirs();
    const now = Date.now();
    const presenceFiles = readdirSync(PRESENCE_DIR).filter(f => f.endsWith(".json"));
    const peers = [];
    for (const pf of presenceFiles) {
      try {
        const data = JSON.parse(readFileSync(join(PRESENCE_DIR, pf), "utf-8"));
        const ageMs = now - (data.ts || 0);
        const alive = ageMs < 15000;
        peers.push({
          session: data.session,
          agentId: data.agentId || "",
          serverName: data.serverName || "",
          pid: data.pid || 0,
          alive,
          ageSec: Math.round(ageMs / 1000),
          isSelf: data.session === SESSION_KEY,
        });
      } catch { /* skip corrupt files */ }
    }

    if (peers.length === 0) {
      return { content: [{ type: "text", text: "No peers found." }] };
    }

    const lines = peers.map(p => {
      const tag = p.isSelf ? " (self)" : "";
      const status = p.alive ? "ALIVE" : "STALE";
      return `hub-agent-${p.session}: ${status} agent_id=${p.agentId} pid=${p.pid} age=${p.ageSec}s${tag}`;
    });
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

// ═══════════════════════════════════════════════════════════════════════════
//  Start
// ═══════════════════════════════════════════════════════════════════════════
const transport = new StdioServerTransport();
await server.connect(transport);
