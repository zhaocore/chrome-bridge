# Chrome Bridge Plugin

[中文说明 / Chinese Version](./README.zh-CN.md)

`chrome-bridge-plugin` is a Chrome Manifest V3 extension written in TypeScript and built with Vite. It is the browser-side half of Chrome Bridge: it maintains a WebSocket connection to the local daemon, receives tool calls, executes them through Chrome APIs and the Chrome DevTools Protocol, and sends results back.

This implementation is intentionally source-first and readable. It does not copy opaque bundled logic from an older extension build; instead, it reimplements the core bridge flow in maintainable TypeScript.

## Where It Fits

The plugin sits between the local daemon and a real Chrome tab:

```text
local daemon
  <-> ws://127.0.0.1:10089/ws
Chrome extension background service worker
  <-> chrome.debugger / Chrome DevTools Protocol
active Chrome tab
```

At a high level:

1. `chrome-bridge-api` sends a `tool_call` over WebSocket
2. The plugin background service worker receives the request
3. The plugin resolves the named tool and executes it
4. The tool uses Chrome extension APIs and/or CDP commands against a real tab
5. The plugin sends a `tool_result` message back to the daemon

## Core Capabilities

The plugin currently provides:

- Popup-driven connection management
- WebSocket bridge protocol support
- Chrome DevTools Protocol access through `chrome.debugger`
- A tool registry for browser actions
- Real-tab interaction primitives such as navigation, DOM actions, input, screenshots, and PDF export
- Session-aware tab targeting for multi-step workflows

## Supported Actions

The current tool registry includes:

- `navigate`
- `find_tab`
- `evaluate`
- `network`
- `snapshot`
- `click`
- `fill`
- `mouse_click`
- `cdp`
- `key_type`
- `send_keys`
- `screenshot`
- `save_as_pdf`
- `upload`
- `close_tab`
- `list_tabs`
- `close_session`

## Popup Features

The popup supports basic bridge lifecycle actions such as:

- `GET_STATUS`
- `CONNECT`
- `DISCONNECT`
- `TEST_CONNECTION`

These are used to inspect and manage the connection between the extension and the local daemon.

## Bridge Protocol

The WebSocket protocol currently includes:

- `hello`
- `hello_ack`
- `ping`
- `pong`
- `tool_call`
- `tool_result`

Example `tool_call` sent by the daemon:

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

Example `tool_result` returned by the plugin:

```json
{
  "type": "tool_result",
  "responseToRequestId": "req-1",
  "payload": {
    "data": {
      "success": true,
      "url": "https://example.com",
      "tabId": 123
    }
  }
}
```

## Development

```bash
cd chrome-bridge-plugin
npm install
npm run typecheck
npm run build
```

Useful commands:

```bash
npm run dev       # build in watch mode
npm run lint
npm run zip
```

Build output is written to `dist/`.

## Load in Chrome

1. Open `chrome://extensions`
2. Enable Developer Mode
3. Click **Load unpacked**
4. Select `chrome-bridge-plugin/dist`

Once loaded, the background service worker can connect to the local daemon and start handling bridge traffic.

## Key Source Files

If you want to understand or extend the plugin, start here:

- `chrome-bridge-plugin/src/background/index.ts`: background entrypoint
- `chrome-bridge-plugin/src/background/wsClient.ts`: WebSocket client and bridge lifecycle
- `chrome-bridge-plugin/src/background/tools.ts`: tool implementations and registry
- `chrome-bridge-plugin/src/background/cdp.ts`: Chrome DevTools Protocol helpers
- `chrome-bridge-plugin/src/background/protocol.ts`: protocol and tool types
- `chrome-bridge-plugin/src/popup/main.ts`: popup UI logic

## Security Boundary

This extension requests permissions including:

- `debugger`
- `tabs`
- `activeTab`
- `storage`
- `alarms`
- `tabGroups`
- `windows`
- `<all_urls>`

A connected daemon can instruct the extension to read pages, click, type, capture screenshots, save PDFs, upload files, and close tabs. Only connect this extension to a trusted local daemon.
