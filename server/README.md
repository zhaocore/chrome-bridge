# Chrome Bridge API

[中文说明 / Chinese Version](./README.zh-CN.md)

`chrome-bridge-api` is the local daemon for Chrome Bridge. It accepts browser automation requests from an AI agent, forwards them to a connected Chrome extension, and returns the execution result through a local HTTP API.

The daemon exists to provide a stable, scriptable, and observable service layer between agents and a real browser, instead of embedding all control logic directly inside an extension or ad-hoc scripts.

## Where It Fits

This repository currently has two main parts:

- `chrome-bridge-api`: a local Go daemon that exposes HTTP and WebSocket services
- `chrome-bridge-plugin`: a Chrome extension that performs the actual in-browser work

The high-level flow is:

1. An agent calls `chrome-bridge-api`
2. The API forwards the command over WebSocket to the Chrome extension
3. The extension performs the action in a real browser tab
4. The extension sends the result back to the API
5. The API normalizes the result and returns it to the caller

## Core Capabilities

The daemon currently provides:

- Daemon lifecycle management: `start`, `stop`, `restart`, `status`
- A local HTTP API for agents and scripts
- A WebSocket endpoint for the Chrome extension
- Tool argument validation before requests reach the browser side
- Basic session state to support multi-step browser workflows
- Normalization of binary outputs such as screenshots and PDFs
- Runtime logging for debugging connection, timeout, and validation issues

## Supported Browser Actions

The currently registered tools are:

- `navigate`
- `find_tab`
- `snapshot`
- `click`
- `fill`
- `evaluate`
- `network`
- `upload`
- `screenshot`
- `save_as_pdf`
- `list_tabs`
- `close_tab`
- `close_session`
- `mouse_click`
- `cdp`
- `key_type`
- `send_keys`

You can retrieve the machine-readable tool list and argument requirements from `GET /tools`.

## Requirements

- Go `1.21+`
- A built and loaded `chrome-bridge-plugin`
- A Chrome extension instance that can connect to the local daemon

If the API is running but no extension is connected, the HTTP service still starts successfully, but most browser actions will fail with an extension-not-connected error.

## Project Structure

```text
chrome-bridge-api/
├── cmd/chrome-bridge/        # CLI entrypoint
├── internal/bridge/          # WebSocket bridge and request/response dispatch
├── internal/server/          # HTTP API and tool validation
├── internal/session/         # Session state management
├── internal/files/           # File result normalization
├── internal/runtime/         # PID, logs, process lifecycle helpers
└── docs/technical-plan.md    # Lower-level protocol and implementation notes
```

## Build

The default port is compiled into the binary. The default value is `10089`.

```bash
make build
```

To override the default port at build time:

```bash
make build PORT=10090
```

## Run and Manage

Start the daemon:

```bash
./bin/chrome-bridge start
```

Check status:

```bash
./bin/chrome-bridge status
```

Stop or restart:

```bash
./bin/chrome-bridge stop
./bin/chrome-bridge restart
```

Run in the foreground:

```bash
./bin/chrome-bridge serve
```

Read logs:

```bash
./bin/chrome-bridge logs -n 100
./bin/chrome-bridge logs -f
./bin/chrome-bridge logs --prev
```

Install the bundled Codex skill from this repository:

```bash
./bin/chrome-bridge install-skill
```

## HTTP API

Default listen address: `127.0.0.1:10089`

### `GET /status`

Returns daemon health and connection state, including whether an extension is connected.

Example:

```bash
curl -s http://127.0.0.1:10089/status
```

### `GET /tools`

Returns the list of supported tools and each tool's `required` / `optional` arguments.

Example:

```bash
curl -s http://127.0.0.1:10089/tools
```

### `POST /api/connections`

Returns the WebSocket URL and port the extension should connect to.

Example:

```bash
curl -s -X POST http://127.0.0.1:10089/api/connections
```

### `POST /command`

Executes a browser command through the connected extension.

Request body:

```json
{
  "action": "navigate",
  "args": {
    "url": "https://example.com",
    "newTab": true
  },
  "session": "demo",
  "timeout_ms": 30000
}
```

Fields:

- `action`: tool name to invoke
- `args`: tool arguments
- `session`: optional session name for multi-step workflows
- `timeout_ms`: optional per-call timeout, default `30000`

Example:

```bash
curl -s -X POST http://127.0.0.1:10089/command \
  -H 'Content-Type: application/json' \
  -d '{
    "action": "navigate",
    "args": {
      "url": "https://example.com",
      "newTab": true
    },
    "session": "demo"
  }'
```

### `GET /ws`

This is the WebSocket bridge endpoint used by the Chrome extension. It is not intended to be a general-purpose business API for direct client calls.

## Typical Debug Flow

A common local debugging flow looks like this:

1. Start the daemon
2. Verify extension connectivity via `/status`
3. Inspect the available tools via `/tools`
4. Send a command via `/command`
5. Check the response and logs

Example:

```bash
./bin/chrome-bridge start
curl -s http://127.0.0.1:10089/status
curl -s http://127.0.0.1:10089/tools
```

## Error Behavior

Important server-side behaviors:

- **Unknown tool**: rejected before reaching the bridge layer
- **Missing required arguments**: returns `400`
- **Extension not connected**: typically returns `503`
- **Command timeout**: typically returns `504`
- **Extension execution error**: typically returns `502`
- **Second extension connection**: rejected to avoid multiple browser instances racing on the same bridge

The design intentionally keeps only one active extension connection at a time because Chrome debugger attachment is effectively global per tab.

## Development and Testing

Run tests:

```bash
make test
```

Equivalent raw Go command:

```bash
GOTOOLCHAIN=local go test ./...
```

If you are modifying the system, these files are the best starting points:

- `cmd/chrome-bridge/main.go`: CLI lifecycle management
- `internal/server/server.go`: HTTP routing and command forwarding
- `internal/server/tools.go`: tool registry and argument validation
- `internal/bridge/manager.go`: WebSocket bridge and request/result matching

## Who This Is For

This daemon is a good fit if you need:

- A local service that lets an agent control a real browser
- A stable bridge between Chrome extension logic and automation workflows
- An HTTP layer that cleanly orchestrates browser actions without tightly coupling callers to extension internals

For lower-level protocol details and implementation notes, see:

- `chrome-bridge-api/docs/technical-plan.md`
