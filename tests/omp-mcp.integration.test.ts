import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { AcpOmpSessionFactory, buildAcpLaunch } from "../src/omp-session.js";
import { prepareAcpSession } from "../src/mcp.js";
import type { DiscordSessionRecord } from "../src/types.js";
import { z } from "zod";

// Opt-in native integration: no model calls, external network, or personal credentials.
const cli = process.env.OMP_NATIVE_TEST_CLI;
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

describe.skipIf(!cli)("native OMP MCP session boundary", () => {
  function fixture() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-test-"));
    cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
    const agent = path.join(home, ".omp/agent");
    fs.mkdirSync(agent, { recursive: true });
    const env = { HOME: home, PI_CODING_AGENT_DIR: agent, PI_PROFILE: "" };
    const record: DiscordSessionRecord = {
      threadId: "thread", guildId: "guild", parentChannelId: "channel", triggerMessageId: "message",
      sessionFile: null, sessionDir: path.join(home, "sessions"), cwd: home,
      model: null, thinkingLevel: null, createdByUserId: "user", status: "active",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    const factory = new AcpOmpSessionFactory({ cliPath: cli!, env });
    cleanups.push(() => factory.close());
    return { home, agent, env, record, factory };
  }

  for (const restore of [false, true]) {
    it(`exposes configured MCP tools to the real agent (${restore ? "legacy restore" : "new"})`, async () => {
      const { home, agent, env, record, factory } = fixture();
      const server = http.createServer(async (request, response) => {
        if (request.method !== "POST") { response.writeHead(405).end(); return; }
        let body = "";
        for await (const chunk of request) body += chunk;
        const message = z.object({ id: z.number().optional(), method: z.string() }).parse(JSON.parse(body));
        if (message.id == null) { response.writeHead(202).end(); return; }
        const result = message.method === "initialize"
          ? { protocolVersion: "2025-11-25", serverInfo: { name: "fixture", version: "1" }, capabilities: { tools: {} } }
          : { tools: [{ name: "sum", description: "Add integers", inputSchema: { type: "object", properties: {} } }] };
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      cleanups.push(() => { server.closeAllConnections(); server.close(); });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test server address");
      fs.writeFileSync(path.join(agent, "mcp.json"), JSON.stringify({ mcpServers: {
        fixture: { type: "http", url: `http://127.0.0.1:${address.port}/mcp` },
      } }));
      const observed = path.join(home, "agent-tools.json");
      fs.mkdirSync(path.join(agent, "extensions"));
      fs.writeFileSync(path.join(agent, "extensions/check.ts"), `import fs from "node:fs";
export default function(api) { api.registerCommand("check-mcp", { description: "Inspect model-visible tools", handler: async () => {
fs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify(api.getAllTools().map(tool => tool.name)));
} }); }`);
      let legacy: { id: string; file: string } | undefined;
      if (restore) {
        const root = path.dirname(path.dirname(fs.realpathSync(cli!)));
        const module = pathToFileURL(path.join(root, "src/session/session-manager.ts")).href;
        // The OMP module comes from the runtime-selected installation.
        const output = execFileSync("bun", ["-e", `const {SessionManager}=await import(${JSON.stringify(module)}); const session=SessionManager.create(${JSON.stringify(home)},${JSON.stringify(record.sessionDir)}); session.appendMessage({role:"user",content:"legacy-history-marker",timestamp:Date.now()}); await session.ensureOnDisk(); console.log(JSON.stringify({id:session.getSessionId(),file:session.getSessionFile()})); await session.close();`], { env: { ...process.env, ...env }, encoding: "utf8" });
        legacy = z.object({ id: z.string(), file: z.string() }).parse(JSON.parse(output));
        fs.mkdirSync(legacy.file.slice(0, -6), { recursive: true });
        fs.writeFileSync(path.join(legacy.file.slice(0, -6), "artifact.txt"), "owned fixture artifact");
      }
      const handle = await factory.open(record);
      await handle.prompt("/check-mcp");
      expect(JSON.parse(fs.readFileSync(observed, "utf8"))).toContain("mcp__fixture_sum");
      const reference = z.object({ id: z.string(), file: z.string() }).parse(JSON.parse(fs.readFileSync(path.join(record.sessionDir, "acp-session.json"), "utf8")));
      expect(fs.existsSync(reference.file)).toBe(true);
      expect(path.dirname(reference.file)).not.toBe(record.sessionDir);
      if (legacy) {
        expect(reference.id).toBe(legacy.id);
        const messages = fs.readFileSync(reference.file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
        expect(messages).toContainEqual(expect.objectContaining({ message: expect.objectContaining({ role: "user", content: "legacy-history-marker" }) }));
        expect(fs.readFileSync(path.join(reference.file.slice(0, -6), "artifact.txt"), "utf8")).toBe("owned fixture artifact");
        expect(fs.existsSync(legacy.file)).toBe(false);
      }
    }, 60_000);
  }

  it("fails session initialization when an enabled MCP cannot connect", async () => {
    const { home, agent, record, factory } = fixture();
    fs.writeFileSync(path.join(agent, "mcp.json"), JSON.stringify({ mcpServers: {
      broken: { command: path.join(home, "missing-mcp-executable") },
    } }));
    const handle = await factory.open(record);
    await expect(handle.availableCommands!()).rejects.toMatchObject({ code: -32603 });
  }, 60_000);

  it("restores the same session without MCP and creates a distinct session for new", async () => {
    const { record, factory } = fixture();
    const first = await factory.open(record);
    await first.availableCommands!();
    expect(first.sessionFile && fs.existsSync(first.sessionFile)).toBe(true);
    factory.close();
    const restored = await factory.open(record);
    await restored.availableCommands!();
    expect(restored.sessionFile).toBe(first.sessionFile);
    const fresh = await factory.newSession(record);
    expect(fresh.sessionFile && fs.existsSync(fresh.sessionFile)).toBe(true);
    expect(fresh.sessionFile).not.toBe(first.sessionFile);
  }, 60_000);

  it("excludes repository MCP and disabled user servers without shadowing enabled user servers", async () => {
    const { home, agent, env, record } = fixture();
    fs.writeFileSync(path.join(agent, "mcp.json"), JSON.stringify({ mcpServers: {
      allowed: { command: "user-command" }, disabled: { command: "disabled-command", enabled: false },
    } }));
    fs.writeFileSync(path.join(home, ".mcp.json"), JSON.stringify({ mcpServers: {
      projectOnly: { command: "project-command" }, allowed: { command: "project-shadow", enabled: false },
    } }));
    const { mcpServers } = await prepareAcpSession(buildAcpLaunch({ ...record, cliPath: cli!, env }), record.sessionDir, false);
    expect(mcpServers.map((server) => server.name)).toEqual(["allowed"]);
  });
});
