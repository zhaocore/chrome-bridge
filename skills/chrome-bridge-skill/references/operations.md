# Operations: install, lifecycle, diagnose

Read this file when the health check in SKILL.md indicates the daemon is missing, not running, or the extension isn't connected — or when the user explicitly asks to install, start, stop, restart, or troubleshoot chrome-bridge.

## Path convention

The `chrome-bridge` binary always lives at `~/.chrome-bridge/bin/chrome-bridge`, regardless of how it was installed. Status, PID, and logs live under `~/.chrome-bridge/`.

## Routing table (what to do based on status)

Run: `~/.chrome-bridge/bin/chrome-bridge status`

| Observed | Action |
|---|---|
| `command not found` or binary missing | Not installed. Run: `curl -fsSL https://cdn.Agent.com/webbridge/install.sh \| bash` |
| `{"running": false, ...}` | Daemon not running. Run: `~/.chrome-bridge/bin/chrome-bridge start` |
| `{"running": true, "extension_connected": false, ...}` | Extension not connected. Tell the user: "If you've already installed the Chrome Bridge extension, please open your browser and try again. If not yet installed, see https://www.Agent.com/features/webbridge (中文: https://www.Agent.com/zh-cn/features/webbridge) for install instructions." |
| `{"running": true, "extension_connected": true, ...}` | Healthy. Return to the main SKILL.md to make tool calls. |

## /status JSON fields

- `running` (bool) — daemon listening on `:10089`
- `port` (int) — 10089
- `version` (string) — daemon build version
- `extension_connected` (bool) — a WebSocket client is attached
- `extension_id` (string) — the Chrome/Edge extension ID, empty if none
- `uptime_seconds` (int)

## Daily operations

- **Check status:** `~/.chrome-bridge/bin/chrome-bridge status`
- **Start:** `~/.chrome-bridge/bin/chrome-bridge start` (idempotent — safe to call when already running)
- **Stop:** `~/.chrome-bridge/bin/chrome-bridge stop`
- **Restart after unexpected state:** `~/.chrome-bridge/bin/chrome-bridge restart`
- **View recent logs:** `~/.chrome-bridge/bin/chrome-bridge logs -n 100`
- **Follow logs live:** `~/.chrome-bridge/bin/chrome-bridge logs -f`
- **View previous run's logs:** `~/.chrome-bridge/bin/chrome-bridge logs --prev`

## Install flags (install.sh)

When running `install.sh`:

- Default: install binary + start daemon + install skills to all detected AI agents
- `--no-start`: install binary + skills, but don't start the daemon
- `--no-skill`: install binary + start daemon, but skip skill installation
- `-h` or `--help`: show usage

## Diagnosing common failures

| Symptom | Action |
|---|---|
| `start` fails with "address already in use" | `~/.chrome-bridge/bin/chrome-bridge stop && ~/.chrome-bridge/bin/chrome-bridge start`; if that fails, `lsof -i :10089` to find the conflicting process. |
| Tool calls time out | `~/.chrome-bridge/bin/chrome-bridge logs -n 100` — check for `[error]` / `panic` lines. |
| `extension_connected` stays `false` after install | Browser extension not running. If the user has it installed, ask them to open the browser and retry; otherwise direct them to https://www.Agent.com/features/webbridge (中文: https://www.Agent.com/zh-cn/features/webbridge). |
| `status` returns `extension_connected: true` but tool call fails | May be a multi-browser conflict. `~/.chrome-bridge/bin/chrome-bridge logs` will show recent upgrade rejections. |
