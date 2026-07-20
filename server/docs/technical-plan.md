# chrome-bridge-api Go/Gin 技术方案

## Summary

`chrome-bridge-api` implements the local Chrome Bridge daemon in Go. It exposes the agent-facing HTTP API on `127.0.0.1:<compiled-port>`, accepts Chrome extension WebSocket connections at `/ws`, and forwards browser tool calls through the extension protocol already used by `chrome-bridge-plugin`.

- HTTP: `GET /status`, `POST /command`, `GET /tools`, `POST /api/connections`
- WebSocket: `hello`, `hello_ack`, `ping/pong`, `tool_call`, `tool_result`
- CLI: `start`, `stop`, `restart`, `status`, `logs`, `install-skill`, plus internal `serve`
- Stack: Go 1.21, Gin, gorilla/websocket
- Port: compile-time setting. Default is `10089`; override with `go build -ldflags "-X main.defaultPort=10090" ./cmd/chrome-bridge`.

## Public Interfaces

### HTTP

| Method | Path | Purpose | Request | Response |
|---|---|---|---|---|
| `GET` | `/status` | Health and connection state | none | `{running, port, version, extension_connected, extension_id, extension_version, uptime_seconds}` |
| `POST` | `/command` | Agent tool-call entrypoint | `{action,args,session,timeout_ms}` | success `{data}` or error `{error}` |
| `GET` | `/tools` | Supported tool metadata | none | `{tools:[...]}` |
| `POST` | `/api/connections` | Popup compatibility | empty body | `{url:"ws://127.0.0.1:<compiled-port>/ws", port:<compiled-port>}` |

### WebSocket

The Chrome extension connects to `GET /ws` and sends:

```json
{"type":"hello","payload":{"extensionName":"chrome-bridge","extensionVersion":"0.1.0"}}
```

The daemon responds:

```json
{"type":"hello_ack","payload":{"version":"dev"}}
```

For each HTTP command the daemon sends:

```json
{"type":"tool_call","requestId":"req-1","payload":{"name":"navigate","args":{"url":"https://example.com"}}}
```

The extension returns:

```json
{"type":"tool_result","responseToRequestId":"req-1","payload":{"data":{"success":true}}}
```

or:

```json
{"type":"tool_result","responseToRequestId":"req-1","payload":{"error":"message"}}
```

## Implementation

- `cmd/chrome-bridge`: CLI entrypoint.
- `internal/server`: Gin router and HTTP handlers.
- `internal/bridge`: WebSocket client management, request IDs, pending calls, timeout and disconnect handling.
- `internal/session`: `session -> tabIds/current tab` state and tool arg injection.
- `internal/files`: screenshot/PDF base64 decoding and filesystem output adaptation.
- `internal/runtime`: daemon process, pid, logs and CLI support helpers.

`POST /command` validates the action, injects session state, forwards one `tool_call`, normalizes file-returning tools, updates session tab state and returns `{data}`. Browser behavior stays inside the Chrome extension.

## Tool Args

| action | args |
|---|---|
| `navigate` | `url` required, `newTab/new_tab` bool, `group_title` string |
| `find_tab` | `url` required, `active` bool |
| `snapshot` | none |
| `click` | `selector` required |
| `fill` | `selector` required, `value` required |
| `evaluate` | `code` required |
| `network` | `cmd=start|stop|list|detail`, `filter`, `requestId` |
| `upload` | `selector` required, `files` string array |
| `screenshot` | `format=png|jpeg`, `quality`, `selector`, `path` |
| `save_as_pdf` | `paper_format`, `landscape`, `scale`, `print_background`, `path` |
| `list_tabs` | none |
| `close_tab` | none |
| `close_session` | none |
| `mouse_click` | `selector` required |
| `cdp` | `method` required, `params` object |
| `key_type` | `text` required |
| `send_keys` | `keys` required, `repeat` 1-100 |

## Test Plan

- HTTP handler tests for `/status`, `/command`, `/tools`, `/api/connections`.
- WebSocket tests with a fake extension for `hello`, `tool_call`, `tool_result`, disconnect and timeout.
- Session tests for `_session`, `_tabId`, `_tabIds` injection and tab update.
- File tests for screenshot/PDF decoding, default paths, custom paths and PDF size limit.
- Runtime helper tests for status parsing and log argument parsing.

Run:

```bash
go test ./...
```
