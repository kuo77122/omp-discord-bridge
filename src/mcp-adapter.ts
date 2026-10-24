// Runs under Bun, alongside the selected OMP installation. Never serialize credentials.
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { z } from "zod";
import fs from "node:fs";

const referenceSchema = z.object({ id: z.string(), file: z.string() });

const requestSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

const [root, mode, serverName] = process.argv.slice(2);
// OMP is selected by the CLI path at runtime, not a bridge build dependency.
const native = (file: string) => import(pathToFileURL(path.join(root!, "src", file)).href);

async function main() {
  const { loadAllMCPConfigs } = await native("mcp/config.ts");
  // Discord authorization is user-level; repository files must not add tools.
  const { configs, sources } = await loadAllMCPConfigs(process.cwd(), { enableProjectConfig: false, filterExa: false });
  if (mode === "list") {
    const threadDir = serverName!;
    const resume = process.argv[5] === "resume";
    const { SessionManager } = await native("session/session-manager.ts");
    const sessionDir: string = SessionManager.getDefaultSessionDir(process.cwd());
    fs.mkdirSync(threadDir, { recursive: true });
    const referenceFile = path.join(threadDir, "acp-session.json");
    let stored: z.infer<typeof referenceSchema> | undefined;
    if (resume && fs.existsSync(referenceFile)) {
      stored = referenceSchema.parse(JSON.parse(fs.readFileSync(referenceFile, "utf8")));
    } else if (resume) {
      const legacy = await SessionManager.list(process.cwd(), threadDir);
      legacy.sort((a: { modified: Date }, b: { modified: Date }) => b.modified.getTime() - a.modified.getTime());
      if (legacy[0]) stored = { id: legacy[0].id, file: legacy[0].path };
    }
    if (stored) {
      const destination = path.join(sessionDir, path.basename(stored.file));
      // Record the source before moving so interrupted migrations remain recoverable.
      fs.writeFileSync(`${referenceFile}.tmp`, JSON.stringify(stored), { mode: 0o600 });
      fs.renameSync(`${referenceFile}.tmp`, referenceFile);
      if (path.dirname(stored.file) !== sessionDir) {
        if (fs.existsSync(stored.file)) {
          const session = await SessionManager.open(stored.file);
          try { await session.moveTo(process.cwd(), sessionDir); }
          finally { await session.close(); }
        } else if (!fs.existsSync(destination)) {
          throw new Error("Stored Discord session is missing");
        }
        stored = { id: stored.id, file: destination };
        fs.writeFileSync(`${referenceFile}.tmp`, JSON.stringify(stored), { mode: 0o600 });
        fs.renameSync(`${referenceFile}.tmp`, referenceFile);
      }
    }
    process.stdout.write(JSON.stringify({ names: Object.keys(configs), sessionDir, stored }));
    return;
  }
  if (!serverName || !configs[serverName]) throw new Error("MCP server is not enabled");
  const { MCPManager } = await native("mcp/manager.ts");
  const { discoverAuthStorage } = await native("session/auth-broker-config.ts");
  const auth = await discoverAuthStorage();
  const manager = new MCPManager(process.cwd());
  manager.setAuthStorage(auth);
  const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  manager.addNotificationListener((name: string, method: string, params: unknown) => {
    if (name === serverName) send({ jsonrpc: "2.0", method, params });
  });
  const close = async () => {
    await manager.disconnectAll();
    await auth.close();
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { void close().finally(() => process.exit()); });
  try {
    const result = await manager.connectServers({ [serverName]: configs[serverName] }, { [serverName]: sources[serverName] });
    await manager.waitForPendingConnections();
    if (result.errors.size || !manager.getConnection(serverName)) throw new Error("MCP connection failed");
    const input = createInterface({ input: process.stdin });
    const pending = new Map<string | number, AbortController>();
    const handle = async (message: z.infer<typeof requestSchema>) => {
      if (message.method === "notifications/cancelled") {
        const requestId = message.params?.requestId;
        if (typeof requestId === "string" || typeof requestId === "number") pending.get(requestId)?.abort();
        return;
      }
      if (message.id == null) return;
      const controller = new AbortController();
      pending.set(message.id, controller);
      try {
        const connection = await manager.waitForConnection(serverName);
        const value = message.method === "initialize"
          ? { protocolVersion: message.params?.protocolVersion, capabilities: connection.capabilities, serverInfo: connection.serverInfo, ...(configs[serverName].instructions !== false && connection.instructions ? { instructions: connection.instructions } : {}) }
          : await connection.transport.request(message.method, message.params, { signal: controller.signal });
        send({ jsonrpc: "2.0", id: message.id, result: value });
      } catch {
        // Upstream errors can contain Authorization headers or credential-bearing URLs.
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "MCP request failed; check authorization in a trusted OMP session" } });
      } finally {
        pending.delete(message.id);
      }
    };
    input.on("line", (line) => {
      try { void handle(requestSchema.parse(JSON.parse(line))); }
      catch { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } }); }
    });
    await new Promise<void>((resolve) => input.once("close", resolve));
    for (const controller of pending.values()) controller.abort();
  } finally {
    await close();
  }
}

main().catch(() => {
  process.stderr.write("OMP MCP adapter failed; verify the selected OMP installation and MCP authorization in a trusted session.\n");
  process.exitCode = 1;
});
