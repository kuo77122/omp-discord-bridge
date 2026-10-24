# OMP Discord Bridge

A production-ready Discord gateway for [OMP / Oh My Pi](https://omp.sh/). Mention your bot in an allowed Discord channel and the bridge creates a dedicated thread backed by a persistent OMP agent session. Follow-up messages, slash commands, stop/status controls, and attachments all stay scoped to that thread.

The project is intentionally small: a Node.js daemon, a SQLite queue/store, Discord slash-command sync, and an ACP-only OMP session adapter.

## Highlights

- **Thread-per-session workflow** — one Discord thread maps to one persistent OMP session.
- **Mention-triggered session creation** — restrict startup to approved guilds, parent channels, and users.
- **Durable SQLite state** — sessions and queued turns survive daemon restarts.
- **Serialized per-thread queue** — multiple users can enqueue turns safely while global concurrency stays bounded.
- **Live OMP controls** — use `status`, `stop`, `new`, and `compact` inside managed threads, or slash-command equivalents.
- **Discord slash commands** — syncs `/omp`, `/omp-status`, `/omp-stop`, `/omp-new`, `/omp-compact`, and OMP ACP tools.
- **All ACP commands are invokable** — safe core ACP commands register directly (`/todo`, `/model`, `/tools`); namespaced commands use autocomplete runners (`/skill`, `/codex`, `/posthog`, etc.).
- **Configurable follow-ups** — either steer the currently running OMP turn or enqueue messages behind it.
- **Attachment context** — includes Discord attachment URLs in prompts up to a configurable byte limit.
- **Message chunking** — responses are split under Discord message limits.
- **OMP extension entrypoint** — package metadata exposes `dist/src/extension.js` for OMP to load.

Approval forwarding is intentionally out of scope: the ACP adapter currently auto-selects an allow option for headless operation.

## How it works

1. A user mentions the Discord bot in an allowed parent channel.
2. The daemon creates a thread named from the prompt.
3. The thread/session mapping is stored in SQLite.
4. Prompts from that thread are serialized through a per-thread queue.
5. The OMP ACP adapter runs the prompt and streams the final response back to Discord.
6. Later thread messages continue the same OMP session until `new`, `stop`, or daemon cleanup.

## Slash-command model

Discord limits top-level application commands and disallows `:` in command names, while OMP ACP can expose many namespaced commands such as `skill:test-driven-development`. The bridge therefore uses a hybrid command model:

| OMP command shape | Discord command |
| --- | --- |
| `todo` | `/todo input:<args>` |
| `model` | `/model input:<args>` |
| `skill:test-driven-development` | `/skill command:test-driven-development input:<args>` |
| `codex:review` | `/codex command:review input:<args>` |

The daemon discovers OMP ACP commands at startup when `discord.slashCommands.acpCommands: auto` is enabled, then syncs the Discord command set for each configured guild.

Bridge/session commands remain prefixed to avoid collisions:

- `/omp prompt:<text>`
- `/omp-status`
- `/omp-stop`
- `/omp-new`
- `/omp-compact`

## Requirements

- Node.js **24+** (`node:sqlite` is used directly).
- OMP npm installation available as `omp` on `PATH` (or set `OMP_CLI_PATH` to its executable), plus Bun on the daemon's `PATH`. Native MCP integration is validated with OMP **18.8.0** and requires its published `src/` modules; standalone OMP binaries and arbitrary wrapper scripts are not supported.
- A Discord bot token.
- Discord bot settings:
  - Message Content Intent enabled.
  - OAuth scopes: `bot` and `applications.commands`.
  - Permissions to read/send messages, create threads, send messages in threads, and use slash commands.
- OMP configured locally in the same environment where the daemon runs.

## Installation

```bash
git clone https://github.com/CarterMcAlister/omp-discord-bridge.git
cd omp-discord-bridge
npm install
npm run build
```

Create a config file:

```bash
mkdir -p ~/.omp/agent
cp examples/discord-bridge.yml ~/.omp/agent/discord-bridge.yml
```

Edit the guild/channel IDs in `~/.omp/agent/discord-bridge.yml`, then provide the Discord token via the configured environment variable:

```bash
export DISCORD_BOT_TOKEN="..."
node dist/src/daemon.js --config ~/.omp/agent/discord-bridge.yml
```

After linking or package installation, you can use the binary:

```bash
npm link
omp-discord-bridge --config ~/.omp/agent/discord-bridge.yml
```

## Configuration

See [`examples/discord-bridge.yml`](examples/discord-bridge.yml) for a complete example.

```yaml
discord:
  tokenEnv: DISCORD_BOT_TOKEN
  slashCommands:
    enabled: true
    syncOnStart: true
    commandPrefix: omp
    acpCommands: auto
  guilds:
    - id: "123456789012345678"
      allowedChannels: ["234567890123456789"]
      allowedUsers: []
      requireMention: true
      threadAutoArchiveMinutes: 1440
omp:
  cwd: "~/Developer"
  sessionRoot: "~/.omp/agent/discord-sessions"
  model: null
  thinkingLevel: medium
runtime:
  databasePath: "~/.omp/agent/discord-bridge.sqlite"
  maxConcurrency: 2
  maxAttachmentBytes: 25000000
  responseMode: edit-preview-then-final
  followupMode: steer # steer | queue
  discordMessageLimit: 1900
```

### Important settings

| Setting | Description |
| --- | --- |
| `discord.tokenEnv` | Environment variable containing the Discord bot token. |
| `discord.guilds[].allowedChannels` | Parent channels where mention-triggered sessions may start. Empty means any channel in the guild. |
| `discord.guilds[].allowedUsers` | User allowlist. Empty means any user in an allowed channel. |
| `discord.guilds[].requireMention` | Require a bot mention to start a new thread. |
| `discord.slashCommands.syncOnStart` | Replace guild slash commands with the generated command set on daemon startup. |
| `discord.slashCommands.acpCommands` | `auto`, `core`, or an explicit array of ACP command metadata. |
| `omp.cwd` | Working directory used for OMP sessions. |
| `omp.sessionRoot` | Per-thread association directories containing `acp-session.json`; journals live in OMP's standard session storage. |
| `runtime.followupMode` | `steer` sends follow-ups into the running turn when possible; `queue` always queues. |
| `runtime.maxConcurrency` | Maximum number of threads with active OMP turns at once. |
| `runtime.discordMessageLimit` | Chunk size cap for outbound Discord messages. |

### Explicit ACP command list

If you do not want automatic discovery, provide explicit commands:

```yaml
discord:
  slashCommands:
    acpCommands:
      - name: todo
        description: Manage OMP todos
        inputHint: todo arguments
      - name: skill:test-driven-development
        description: Run the TDD skill
        inputHint: task description
```

## MCP configuration, OAuth, and session recovery

The bridge discovers enabled **user-level** MCP servers using the selected OMP installation's native configuration loader. This includes `~/.omp/agent/mcp.json` (or the active agent/profile directory), native disable lists, and other user-level sources supported by OMP. Project-level MCP configuration is deliberately excluded: changing a repository must not silently grant Discord access to more tools. With no configured servers, ordinary non-MCP sessions remain available.

Each server is exposed to ACP through a local stdio adapter. The adapter uses OMP's native MCP manager and credential storage, preserving transport configuration, environment/header resolution, OAuth token lookup, and HTTP token refresh. Tokens are not placed in ACP server definitions or process arguments. Adapter failures return generic errors rather than upstream messages that might contain credentials. Initial OAuth login or reauthorization must be completed in a trusted local OMP session, not through Discord.

The first turn waits for the initial MCP connections and tool lists; the bridge sets `OMP_MCP_STARTUP_TIMEOUT_MS=0` rather than allowing OMP's short background-startup window to hide tools from the first prompt. An enabled server that cannot connect fails session initialization instead of silently disappearing. OMP's normal request timeouts still apply. Disable unavailable servers in trusted user configuration before retrying.

Run OMP and the daemon as the same OS user, with the same agent/profile and credential-broker environment. Verify Plane authorization locally by actually calling `workspace.retrieve`; an unauthenticated HTTP 401 does not establish whether the stored OAuth grant works. Restrict Discord guild/channel/user allowlists to trusted users: enabled user MCP servers grant their capabilities to those sessions.

New sessions use OMP's standard journal directory, with an atomic `acp-session.json` reference under each Discord thread directory. Restarting the daemon loads the recorded ACP session ID and reapplies the MCP servers. `new` creates a distinct session and updates that reference without deleting previous history.

On first recovery of an older thread, the newest journal in its legacy thread directory is moved, together with its artifacts, using OMP's native session API into standard storage. The reference is written before migration and updated afterward so an interrupted move can be recovered. Back up the bridge database, thread directories, and OMP session storage before upgrading. Journals become visible in OMP's ordinary session listing; do not delete the per-thread association directories.

For deployment, inspect the service manager's actual `ExecStart`, checkout, OS user, and environment before building. Build the reviewed checkout with `npm ci && npm run check`, then point the service at that checkout's `dist/src/daemon.js` and restart it. Do not assume a similarly named checkout is the deployed one. After restart, verify both a new Discord thread and a previously used thread can call Plane `workspace.retrieve` and return the expected workspace; verify the old thread still remembers prior conversation. No history reset is required.

## Discord setup checklist

1. Create a Discord application and bot in the Developer Portal.
2. Enable Message Content Intent for the bot.
3. Invite the bot with `bot` and `applications.commands` scopes.
4. Grant channel/thread permissions in the target guild.
5. Put guild and parent-channel IDs in the YAML config.
6. Start the daemon and confirm it logs in.
7. Mention the bot in an allowed parent channel to create a managed thread.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm run check
```

`npm run check` runs typechecking, the Vitest suite, and a production build.

The optional native integration suite exercises the actual ACP initialization boundary, MCP tool visibility in new/restored sessions, legacy migration, no-MCP recovery, and user/project access scope. It uses isolated temporary agent directories and a loopback MCP server, with no model calls or personal credentials:

```bash
OMP_NATIVE_TEST_CLI="$(command -v omp)" npm test -- tests/omp-mcp.integration.test.ts
```

The test suite covers:

- config normalization and validation;
- Discord message/thread orchestration;
- slash-command generation and ACP namespace routing;
- SQLite session and queue persistence;
- queue serialization, stop/new-session controls, and response rendering;
- OMP ACP launch helpers and fake session behavior.

## Repository layout

```text
src/config.ts          YAML loading, defaults, validation
src/daemon.ts          daemon startup, Discord login, slash sync
src/discord.ts         Discord event handlers and permission checks
src/omp-session.ts     OMP ACP and fake session adapters
src/queue.ts           per-thread queue runner and controls
src/render.ts          message chunking/thread-name rendering
src/slash-commands.ts  slash command generation/autocomplete/routing
src/store.ts           SQLite persistence
tests/                 Vitest coverage for the daemon pieces
examples/              sample YAML config
docs/                  design notes and investigations
```

## Operational notes

- Run the daemon under your preferred service manager for production use.
- Keep the bot token in an environment variable or secret manager; never store it in YAML.
- `syncOnStart: true` replaces the configured guild command set with the generated commands for this bot.
- If Discord command changes do not appear immediately, wait a few seconds and reload the Discord client.
- `node_modules/`, `dist/`, local databases, and env files are intentionally git-ignored.

## License

MIT — see [`LICENSE`](LICENSE).
