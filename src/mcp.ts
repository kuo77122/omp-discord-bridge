import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { McpServer } from "@agentclientprotocol/sdk";
import type { AcpLaunch } from "./omp-session.js";

const execFileAsync = promisify(execFile);

export async function prepareAcpSession(launch: AcpLaunch, threadDir: string, resume: boolean): Promise<{
  mcpServers: McpServer[]; sessionDir: string; stored?: { id: string; file: string };
}> {
  const executable = path.isAbsolute(launch.command) ? launch.command : (launch.env.PATH ?? "").split(path.delimiter)
    .map((dir) => path.resolve(launch.cwd, dir, launch.command)).find((candidate) => {
      try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; }
    });
  if (!executable) throw new Error("Cannot locate selected OMP executable for MCP discovery");
  const root = path.dirname(path.dirname(fs.realpathSync(executable)));
  if (!fs.existsSync(path.join(root, "src/mcp/manager.ts"))) {
    throw new Error("MCP requires an OMP npm installation with native MCP modules (validated with 18.8.0)");
  }
  let adapter = fileURLToPath(new URL("./mcp-adapter.js", import.meta.url));
  if (!fs.existsSync(adapter)) adapter = fileURLToPath(new URL("./mcp-adapter.ts", import.meta.url));
  const bun = (launch.env.PATH ?? "").split(path.delimiter).map((dir) => path.resolve(launch.cwd, dir, "bun"))
    .find((candidate) => { try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; } });
  if (!bun) throw new Error("Bun is required for OMP native MCP configuration and OAuth");
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(bun, [adapter, root, "list", threadDir, resume ? "resume" : "new"], { cwd: launch.cwd, env: launch.env, timeout: 30_000, maxBuffer: 1024 * 1024 }));
  } catch {
    throw new Error("OMP MCP discovery failed; verify the selected OMP installation in a trusted session");
  }
  const result = z.object({
    names: z.array(z.string()), sessionDir: z.string(),
    stored: z.object({ id: z.string(), file: z.string() }).optional(),
  }).parse(JSON.parse(stdout));
  return {
    mcpServers: result.names.map((name) => ({ name, command: bun, args: [adapter, root, "serve", name], env: [] })),
    sessionDir: result.sessionDir,
    ...(result.stored ? { stored: result.stored } : {}),
  };
}
