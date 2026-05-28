#!/usr/bin/env node
/**
 * End-to-end connectivity test for hub-mcp-server inter-MCP communication.
 * Spawns multiple instances and tests broadcast/listen/list_peers.
 */
import { spawn } from "child_process";
import { join } from "path";
import { homedir } from "os";
import { rmSync, existsSync } from "fs";

const SERVER_PATH = join(import.meta.dirname, "index.mjs");
const BUS_DIR = join(homedir(), ".cursor", "hub-mcp-state", "bus");

let allPassed = true;
let testCount = 0;
let passCount = 0;

function log(tag, msg) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${tag}] ${msg}`);
}

function assert(name, condition, detail = "") {
  testCount++;
  if (condition) {
    passCount++;
    log("PASS", `${name}${detail ? " — " + detail : ""}`);
  } else {
    allPassed = false;
    log("FAIL", `${name}${detail ? " — " + detail : ""}`);
  }
}

class McpInstance {
  constructor(sessionKey) {
    this.sessionKey = sessionKey;
    this.proc = null;
    this.buffer = "";
    this.responses = new Map();
    this.nextId = 1;
    this.pendingResolvers = new Map();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.proc = spawn("node", [SERVER_PATH], {
        env: { ...process.env, HUB_SESSION: String(this.sessionKey), PC_PROJECT_DIR: "/tmp/test-hub-mcp" },
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.proc.stdout.on("data", (chunk) => {
        this.buffer += chunk.toString();
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && this.pendingResolvers.has(msg.id)) {
              this.pendingResolvers.get(msg.id)(msg);
              this.pendingResolvers.delete(msg.id);
            }
          } catch { /* ignore non-JSON lines */ }
        }
      });

      this.proc.stderr.on("data", (chunk) => {
        const text = chunk.toString().trim();
        if (text) log(`agent-${this.sessionKey}:err`, text);
      });

      this.proc.on("error", reject);

      setTimeout(resolve, 300);
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const msg = JSON.stringify({ jsonrpc: "2.0", method, params, id });
      this.pendingResolvers.set(id, resolve);
      this.proc.stdin.write(msg + "\n");
      setTimeout(() => {
        if (this.pendingResolvers.has(id)) {
          this.pendingResolvers.delete(id);
          reject(new Error(`Timeout waiting for response to ${method} (id=${id})`));
        }
      }, 10000);
    });
  }

  async initialize() {
    return this.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
  }

  async callTool(name, args = {}) {
    return this.send("tools/call", { name, arguments: args });
  }

  async listTools() {
    return this.send("tools/list");
  }

  stop() {
    if (this.proc) {
      this.proc.stdin.end();
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
  }
}

async function main() {
  // Clean up bus dir for clean test
  if (existsSync(BUS_DIR)) {
    rmSync(BUS_DIR, { recursive: true, force: true });
  }

  log("TEST", "=== Hub MCP Server Connectivity Test ===\n");

  // ── Test 1: Single instance startup + tool listing ──
  log("TEST", "--- Test 1: Single instance startup ---");
  const agent1 = new McpInstance(91);
  await agent1.start();
  const initRes = await agent1.initialize();
  assert("Init response OK", initRes?.result?.serverInfo?.name === "hub-agent-91",
    `serverName=${initRes?.result?.serverInfo?.name}`);

  const toolsRes = await agent1.listTools();
  const toolNames = toolsRes?.result?.tools?.map(t => t.name) || [];
  assert("8 tools registered", toolNames.length === 8, `got ${toolNames.length}: ${toolNames.join(", ")}`);
  assert("Has setup tool", toolNames.includes("setup"));
  assert("Has check_hub tool", toolNames.includes("check_hub"));
  assert("Has broadcast tool", toolNames.includes("broadcast"));
  assert("Has listen tool", toolNames.includes("listen"));
  assert("Has list_peers tool", toolNames.includes("list_peers"));

  // ── Test 2: Start second instance + peer discovery ──
  log("TEST", "\n--- Test 2: Two instances + list_peers ---");
  const agent2 = new McpInstance(92);
  await agent2.start();
  await agent2.initialize();

  // Wait for heartbeats to write
  await new Promise(r => setTimeout(r, 1500));

  const peersRes1 = await agent1.callTool("list_peers");
  const peersText1 = peersRes1?.result?.content?.[0]?.text || "";
  log("agent-91", `list_peers → ${peersText1}`);
  assert("Agent-91 sees agent-92", peersText1.includes("hub-agent-92"), peersText1);
  assert("Agent-91 sees self", peersText1.includes("(self)"));

  const peersRes2 = await agent2.callTool("list_peers");
  const peersText2 = peersRes2?.result?.content?.[0]?.text || "";
  log("agent-92", `list_peers → ${peersText2}`);
  assert("Agent-92 sees agent-91", peersText2.includes("hub-agent-91"), peersText2);

  // ── Test 3: Point-to-point messaging ──
  log("TEST", "\n--- Test 3: Point-to-point broadcast → listen ---");

  // Agent-91 sends to agent-92
  const sendRes = await agent1.callTool("broadcast", {
    target: "92",
    channel: "test",
    message: "hello from 91",
  });
  const sendText = sendRes?.result?.content?.[0]?.text || "";
  log("agent-91", `broadcast → ${sendText}`);
  assert("Broadcast ack", sendText.includes("MSG_SENT"), sendText);

  // Agent-92 listens (with short timeout)
  const listenRes = await agent2.callTool("listen", { channel: "test", timeout_ms: 5000 });
  const listenText = listenRes?.result?.content?.[0]?.text || "";
  log("agent-92", `listen → ${listenText}`);
  assert("Listen received message", listenText.includes("PEER_MSG"), listenText);
  assert("Message from correct sender", listenText.includes("from=hub-agent-91"), listenText);
  assert("Message content correct", listenText.includes("hello from 91"), listenText);

  // ── Test 4: Broadcast to all ──
  log("TEST", "\n--- Test 4: Broadcast to all peers ---");
  const agent3 = new McpInstance(93);
  await agent3.start();
  await agent3.initialize();
  await new Promise(r => setTimeout(r, 1000));

  // Agent-91 broadcasts to all
  const bcastRes = await agent1.callTool("broadcast", {
    target: "all",
    channel: "announce",
    message: "system-wide alert",
  });
  const bcastText = bcastRes?.result?.content?.[0]?.text || "";
  log("agent-91", `broadcast all → ${bcastText}`);
  const peerCountMatch = bcastText.match(/to=(\d+)/);
  const peerCount = peerCountMatch ? Number(peerCountMatch[1]) : 0;
  assert("Broadcast sent to >= 2 peers", peerCount >= 2, bcastText);

  // Agent-92 picks up
  const listen2 = await agent2.callTool("listen", { channel: "announce", timeout_ms: 3000 });
  const listen2Text = listen2?.result?.content?.[0]?.text || "";
  assert("Agent-92 got broadcast", listen2Text.includes("system-wide alert"), listen2Text);

  // Agent-93 picks up
  const listen3 = await agent3.callTool("listen", { channel: "announce", timeout_ms: 3000 });
  const listen3Text = listen3?.result?.content?.[0]?.text || "";
  assert("Agent-93 got broadcast", listen3Text.includes("system-wide alert"), listen3Text);

  // ── Test 5: Listen timeout (no message) ──
  log("TEST", "\n--- Test 5: Listen timeout ---");
  const timeoutRes = await agent1.callTool("listen", { timeout_ms: 1500 });
  const timeoutText = timeoutRes?.result?.content?.[0]?.text || "";
  assert("Listen timeout fires", timeoutText.includes("LISTEN_TIMEOUT"), timeoutText);

  // ── Test 6: hub_status ──
  log("TEST", "\n--- Test 6: hub_status ---");
  const statusRes = await agent1.callTool("hub_status");
  const statusText = statusRes?.result?.content?.[0]?.text || "";
  log("agent-91", `hub_status → ${statusText}`);
  assert("Status shows session", statusText.includes("session: 91"), statusText);

  // ── Cleanup ──
  agent1.stop();
  agent2.stop();
  agent3.stop();

  // Clean up test bus data
  if (existsSync(BUS_DIR)) {
    rmSync(BUS_DIR, { recursive: true, force: true });
  }

  // ── Summary ──
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  Results: ${passCount}/${testCount} passed${allPassed ? " ✓" : " ✗ SOME FAILED"}`);
  console.log(`${"=".repeat(50)}`);
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(2);
});
