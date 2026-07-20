# Terms of Use & Privacy

**Last updated:** July 10, 2026

"We" in this document refers to the maintainers of the open-source Chrome Bridge project. "The software" refers to the `chrome-bridge-plugin` browser extension contained in this repository. This document covers the open-source extension itself. It does **not** cover any third-party product, hosted service, local daemon distribution, or custom deployment that uses or bundles this extension.

---

## 1. Open Source Extension Privacy

The software is a browser-side bridge extension. Its main purpose is to maintain a WebSocket connection to a trusted daemon and execute browser automation actions through Chrome extension APIs and the Chrome DevTools Protocol.

The extension does **not** include analytics, advertising SDKs, telemetry collection, or a built-in cloud backend.

In the open-source implementation:

- The extension does **not** automatically send your browsing data to the project maintainers
- The extension does **not** automatically upload page content, cookies, passwords, or form data to any maintainer-controlled server
- The extension stores only limited connection state locally in browser extension storage, such as the last WebSocket URL and reconnect preferences

The project is open source and can be audited in this repository.

---

## 2. Local Daemon Boundary

The extension is designed to connect to a daemon that you run or otherwise trust. In the default open-source flow, the extension connects to a local WebSocket endpoint such as:

```text
ws://127.0.0.1:10089/ws
```

Once connected, the daemon can send tool calls to the extension. Depending on the tool, the extension may:

- Read page structure or page content
- Click, type, scroll, or navigate
- Capture screenshots
- Export pages as PDF
- Upload files into web pages
- List or close browser tabs
- Execute Chrome DevTools Protocol commands against the attached tab

This means the daemon you connect to may gain access to sensitive page data available in the tabs it controls. Only connect the extension to a daemon you trust and only use it on pages you are comfortable exposing to that daemon.

If your daemon forwards page data, screenshots, prompts, or task instructions to an LLM provider or any remote service, that data processing happens outside this extension and is governed by the daemon operator's configuration and privacy terms.

---

## 3. Data Processing by the Extension

The extension performs its browser automation work locally inside your browser.

Data is processed by the extension only when one of the following happens:

- You manually connect the extension to a WebSocket server
- A connected daemon sends a tool call
- You use popup actions such as connection testing

During those flows, the extension may process:

- WebSocket connection metadata such as server URL and connection status
- Active-tab identifiers and tab metadata needed to target browser actions
- Page DOM, accessibility tree snapshots, or evaluated page results requested by the connected daemon
- Screenshot or PDF data generated from a controlled tab
- File content that you explicitly instruct the browser automation flow to upload

The extension processes this data in order to complete the requested browser action. The exact scope depends on the tool call sent by the connected daemon.

---

## 4. Data Storage

The open-source extension stores a small amount of state in browser extension storage:

- Last connected WebSocket URL
- Whether auto-reconnect is enabled
- Whether automatic port discovery is enabled

This storage is used for reconnect behavior and popup status display.

The open-source extension does **not** implement its own cloud sync or maintainer-operated data retention layer.

Removing the extension clears its extension-managed local data according to browser behavior. You may also clear extension storage through your browser's extension management and developer tooling.

---

## 5. Permissions and Their Purpose

The extension requests permissions including:

- `debugger`
- `tabs`
- `activeTab`
- `storage`
- `alarms`
- `tabGroups`
- `windows`
- `<all_urls>`

These permissions are required to:

- Attach Chrome DevTools Protocol sessions to tabs
- Inspect and control tabs and windows involved in automation
- Persist local connection settings
- Reconnect and run health checks
- Operate on pages that you direct the extension to control

Because these permissions are broad, you should review the source code and use the extension only in environments you trust.

---

## 6. Optional External Services

The extension source includes generic hooks that may call external HTTP or WebSocket endpoints if you explicitly configure or integrate them. For example:

- Connecting to a non-local WebSocket bridge server
- Calling a custom connection-generation endpoint exposed by another service

Those services are **not** part of the privacy commitments of this open-source extension unless we explicitly state otherwise in a separate service-specific policy.

If you use a third-party daemon, hosted bridge, managed browser service, or custom API, you are responsible for reviewing that service's security model, privacy policy, and terms of use.

---

## 7. Your Control

- You choose whether to install the extension
- You choose which daemon or server the extension connects to
- You can disconnect the extension at any time
- You can inspect and modify the source code before building or loading it
- You can remove the extension to stop all extension-side processing

If you do not want a page to be read, automated, or captured, do not use the extension on that page and do not connect it to an automation daemon for that task.

---

## 8. Disclaimer

This software is provided on an "AS IS" basis, without warranties of any kind, to the extent permitted by applicable law.

You are responsible for:

- Ensuring you have permission to automate the websites and data you access
- Complying with website terms, internal security requirements, and applicable laws
- Evaluating the safety of any daemon, server, or model provider connected to the extension

We are not responsible for data loss, account restrictions, legal claims, or other consequences arising from the way you configure, deploy, or use the extension with third-party or self-hosted systems.

---

## Changes

We may update this document as the open-source extension evolves.

## Contact

Please use the issue tracker or repository discussion channel for this project.
