# Chrome Bridge Plugin

[English Version](./README.md)

`chrome-bridge-plugin` 是一个基于 TypeScript + Vite 开发的 Chrome Manifest V3 扩展。它是 Chrome Bridge 的浏览器侧实现：负责与本地 daemon 建立 WebSocket 连接，接收工具调用，通过 Chrome API 和 Chrome DevTools Protocol 执行操作，再把结果回传给 daemon。

这个实现刻意采用“源码可读、结构清晰”的方式编写，不依赖历史上难以维护的压缩产物，而是用可维护的 TypeScript 重新实现核心 bridge 链路。

## 它在整个系统中的位置

插件位于本地 daemon 与真实 Chrome 标签页之间：

```text
local daemon
  <-> ws://127.0.0.1:10089/ws
Chrome extension background service worker
  <-> chrome.debugger / Chrome DevTools Protocol
active Chrome tab
```

流程如下：

1. `chrome-bridge-api` 通过 WebSocket 发送 `tool_call`
2. 插件的 background service worker 接收请求
3. 插件根据工具名找到对应实现并执行
4. 工具通过 Chrome 扩展 API 和/或 CDP 对真实标签页执行操作
5. 插件将 `tool_result` 返回给 daemon

## 核心能力

当前插件提供这些能力：

- 基于 popup 的连接管理
- WebSocket bridge 协议支持
- 通过 `chrome.debugger` 访问 Chrome DevTools Protocol
- 浏览器操作工具注册表
- 面向真实标签页的导航、DOM 操作、输入、截图、PDF 导出等能力
- 面向多步流程的 session 关联标签页能力

## 支持的操作

当前工具注册表包括：

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

## Popup 功能

Popup 当前支持基础连接管理操作，例如：

- `GET_STATUS`
- `CONNECT`
- `DISCONNECT`
- `TEST_CONNECTION`

这些操作用于检查和管理扩展与本地 daemon 的连接状态。

## Bridge 协议

当前 WebSocket 协议包括：

- `hello`
- `hello_ack`
- `ping`
- `pong`
- `tool_call`
- `tool_result`

daemon 发送的 `tool_call` 示例：

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

插件返回的 `tool_result` 示例：

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

## 开发

```bash
cd chrome-bridge-plugin
npm install
npm run typecheck
npm run build
```

常用命令：

```bash
npm run dev       # watch 模式持续构建
npm run lint
npm run zip
```

构建产物输出到 `dist/`。

## 在 Chrome 中加载

1. 打开 `chrome://extensions`
2. 开启开发者模式
3. 点击 **Load unpacked / 加载已解压的扩展程序**
4. 选择 `chrome-bridge-plugin/dist`

加载后，background service worker 就可以连接本地 daemon 并处理 bridge 流量。

## 关键源码位置

如果你要理解或扩展这个插件，建议从这些文件开始：

- `chrome-bridge-plugin/src/background/index.ts`：background 入口
- `chrome-bridge-plugin/src/background/wsClient.ts`：WebSocket 客户端与 bridge 生命周期
- `chrome-bridge-plugin/src/background/tools.ts`：工具实现与注册表
- `chrome-bridge-plugin/src/background/cdp.ts`：Chrome DevTools Protocol 辅助逻辑
- `chrome-bridge-plugin/src/background/protocol.ts`：协议与工具类型定义
- `chrome-bridge-plugin/src/popup/main.ts`：popup UI 逻辑

## 安全边界

这个扩展声明了以下权限：

- `debugger`
- `tabs`
- `activeTab`
- `storage`
- `alarms`
- `tabGroups`
- `windows`
- `<all_urls>`

连接的 daemon 可以指挥扩展读取页面、点击、输入、截图、保存 PDF、上传文件和关闭标签页。只应将该扩展连接到可信的本地 daemon。
