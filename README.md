# Chrome Bridge

[中文文档](README.zh.md)

Chrome Bridge is an open-source browser control bridge for Chrome and Edge. It lets AI agents operate the local browser: open pages, click, fill forms, extract content, take screenshots, export PDFs, and upload files.

Highlights:

- Local execution: page content, cookies, and login sessions stay on the machine.
- Browser reuse: works with the user's current Chrome/Edge profile and login state.
- Agent-friendly: Claude Code, Cursor, Codex, and any agent that can run HTTP or shell commands can use it.
- Fully open source: Go daemon, TypeScript extension, agent skill package, and website are auditable.

![Chrome Bridge architecture](docs/arch.png)

## Use Cases

- E-commerce comparison: search across platforms and extract prices and links.
- Research: open multiple sources and collect structured information.
- Form filling: fill repeated forms automatically.
- Data entry: extract web data and enter it into systems.
- Job search: search and filter roles across job boards.
- Web archiving: batch screenshots or PDF exports.

## Packages

| Package | Stack | Role |
| --- | --- | --- |
| `chrome-bridge-api` | Go 1.21 + Gin + WebSocket | Local daemon with HTTP/WebSocket APIs |
| `chrome-bridge-plugin` | TypeScript + Vite + Manifest V3 | Chrome/Edge extension that runs browser actions |
| `chrome-bridge-skill` | Markdown | Agent skill package and usage guide |
| `chrome-bridge-web` | Next.js 16 + React 19 + Tailwind v4 | Website |

## How It Works

```text
AI Agent
  -> 127.0.0.1:10089 HTTP API
  -> local daemon
  -> ws://127.0.0.1:10089/ws
  -> Chrome/Edge extension
  -> Chrome DevTools Protocol
  -> current browser tab
```

Default listen address: `127.0.0.1:10089`

The extension uses `chrome.debugger` to call Chrome DevTools Protocol. It inherits the current browser's login state, cookies, and extension configuration. Connect it only to a trusted local daemon.

## Installation

macOS / Linux:

```bash
curl -fsSL https://github.com/zhaocore/chrome-bridge/raw/refs/heads/master/install.sh | bash
```

Windows PowerShell:

```powershell
irm https://github.com/zhaocore/chrome-bridge/raw/refs/heads/master/install.ps1 | iex
```

Then install the browser extension:

[Chrome Web Store - ChromeBridge](https://chromewebstore.google.com/detail/chromebridge/banojplagbjebdnnmklagfagbepelcha)

Verify the connection:

```bash
~/.chrome-bridge/bin/chrome-bridge status
```

It is ready when `running: true` and `extension_connected: true` are shown.

## Commands

```bash
~/.chrome-bridge/bin/chrome-bridge start
~/.chrome-bridge/bin/chrome-bridge stop
~/.chrome-bridge/bin/chrome-bridge restart
~/.chrome-bridge/bin/chrome-bridge status
```

List available tools:

```bash
curl -s http://127.0.0.1:10089/tools
```

Call example:

```bash
curl -s -X POST http://127.0.0.1:10089/command \
  -H 'Content-Type: application/json' \
  -d '{"action":"navigate","args":{"url":"https://example.com","newTab":true},"session":"demo"}'
```

## Tools

| Tool | Description |
| --- | --- |
| `navigate` | Open a URL |
| `find_tab` | Find and reuse an existing tab |
| `snapshot` | Read the page accessibility tree |
| `click` / `mouse_click` | Click an element |
| `fill` | Fill an input or editable area |
| `evaluate` | Run JavaScript |
| `screenshot` | Take a screenshot and return the file path |
| `save_as_pdf` | Export the current page as PDF |
| `network` | Read or analyze network requests |
| `upload` | Upload files |
| `list_tabs` | List session tabs |
| `close_tab` | Close the current tab |
| `close_session` | Close all tabs in a session |
| `cdp` | Call a CDP method directly |
| `key_type` / `send_keys` | Type text or send key events |

Use `GET /tools` for the full parameter schema.

## Sessions

Each `session` maps to a group of browser tabs. Use different sessions for different tasks to reduce interference.

Close a session after the task:

```bash
curl -s -X POST http://127.0.0.1:10089/command \
  -H 'Content-Type: application/json' \
  -d '{"action":"close_session","args":{},"session":"demo"}'
```

## WebSocket Protocol

The daemon and extension communicate through WebSocket.

| Message Type | Direction | Purpose |
| --- | --- | --- |
| `hello` | extension -> daemon | Handshake |
| `hello_ack` | daemon -> extension | Handshake acknowledgement |
| `ping` / `pong` | Both | Heartbeat |
| `tool_call` | daemon -> extension | Tool call |
| `tool_result` | extension -> daemon | Tool result |

`tool_call` example:

```json
{
  "type": "tool_call",
  "requestId": "req-1",
  "payload": {
    "name": "navigate",
    "args": {
      "url": "https://example.com",
      "newTab": true
    }
  }
}
```

## Directory Structure

```text
chrome-bridge/
├── install.sh
├── install.ps1
├── AGENT_INSTALL.md
├── chrome-bridge-api/
│   ├── cmd/chrome-bridge/
│   └── internal/
├── chrome-bridge-plugin/
│   ├── src/background/
│   ├── src/popup/
│   └── public/manifest.json
├── chrome-bridge-skill/
│   ├── SKILL.md
│   └── references/operations.md
└── chrome-bridge-web/
    ├── app/
    ├── components/
    └── docs/
```

## FAQ

**Does Chrome Bridge upload page content?**

No. Browser operations run locally. The agent's own model requests follow the rules of the selected model platform.

**How is it different from Playwright or Selenium?**

Playwright and Selenium are script automation frameworks. Chrome Bridge is built for AI agents and reuses the user's current browser environment.

**Is it paid?**

Chrome Bridge is free and open source. Cost depends only on the agent or model service you use.

**Which agents are supported?**

Any agent that can run HTTP requests or shell commands can connect. The installer tries to inject skill files for runtimes such as Claude Code, Cursor, and Codex.

## References

- [GitHub - chrome-bridge](https://github.com/zhaocore/chrome-bridge)
- [Chrome Web Store - ChromeBridge](https://chromewebstore.google.com/detail/chromebridge/banojplagbjebdnnmklagfagbepelcha)
- [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/)
- [Chrome Extensions Manifest V3](https://developer.chrome.com/docs/extensions/mv3/intro/)
