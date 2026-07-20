# Chrome Bridge API

[English Version](./README.md)

`chrome-bridge-api` 是 Chrome Bridge 的本地守护进程（daemon），负责把 AI Agent 发出的浏览器操作请求，转发给已连接的 Chrome 扩展，并将执行结果通过本地 HTTP API 返回。

它解决的是一个很具体的问题：**让本地 Agent 通过一个稳定、可编排、可观测的服务层来控制真实浏览器**，而不是直接把控制逻辑塞进扩展或临时脚本里。

## 它在整个项目中的位置

当前仓库主要包含两部分：

- `chrome-bridge-api`：本地 Go 守护进程，对外提供 HTTP / WebSocket 服务
- `chrome-bridge-plugin`：Chrome 扩展，负责在浏览器内实际执行操作

它们的关系如下：

1. Agent 调用本地 `chrome-bridge-api`
2. API 将命令通过 WebSocket 转发给 Chrome 扩展
3. 扩展在真实页面中执行点击、输入、截图、抓网络请求等操作
4. 扩展把结果回传给 API
5. API 将结果标准化后返回给调用方

## 核心能力

当前守护进程提供这些能力：

- 管理本地守护进程生命周期：`start`、`stop`、`restart`、`status`
- 暴露本地 HTTP API，供 Agent 或脚本调用
- 暴露 WebSocket 入口，供 Chrome 扩展建立唯一桥接连接
- 校验工具调用参数，避免无效请求直接进入浏览器侧
- 维护基础会话状态，支持多步浏览器操作串联
- 将截图、PDF 等二进制结果规范化为可消费的文件结果
- 记录运行日志，便于排查扩展未连接、调用超时、参数错误等问题

## 支持的浏览器操作

当前服务注册的工具包括：

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

可通过 `GET /tools` 获取机器可读的工具清单及参数要求。

## 运行要求

- Go `1.21+`
- 已构建并加载 `chrome-bridge-plugin`
- Chrome 扩展能连接到本地守护进程

如果只启动 API 而没有连接扩展，HTTP 服务仍可启动，但大部分浏览器操作会返回“extension not connected”类错误。

## 目录结构

```text
chrome-bridge-api/
├── cmd/chrome-bridge/        # CLI 入口
├── internal/bridge/          # WebSocket bridge 与请求/响应分发
├── internal/server/          # HTTP API 与工具校验
├── internal/session/         # 会话状态管理
├── internal/files/           # 文件结果标准化
├── internal/runtime/         # 守护进程启动、PID、日志等运行时能力
└── docs/technical-plan.md    # 更底层的协议与实现说明
```

## 构建

默认端口编译进二进制，默认值为 `10089`。

```bash
make build
```

如果你想在构建时改默认端口：

```bash
make build PORT=10090
```

## 启动与管理

启动守护进程：

```bash
./bin/chrome-bridge start
```

查看状态：

```bash
./bin/chrome-bridge status
```

停止与重启：

```bash
./bin/chrome-bridge stop
./bin/chrome-bridge restart
```

以前台模式直接运行服务：

```bash
./bin/chrome-bridge serve
```

查看日志：

```bash
./bin/chrome-bridge logs -n 100
./bin/chrome-bridge logs -f
./bin/chrome-bridge logs --prev
```

安装仓库里的 Codex Skill：

```bash
./bin/chrome-bridge install-skill
```

## HTTP API

默认监听地址：`127.0.0.1:10089`

### `GET /status`

返回守护进程健康状态和连接状态，包括扩展是否已经连接。

示例：

```bash
curl -s http://127.0.0.1:10089/status
```

### `GET /tools`

返回当前支持的工具，以及各工具要求的 `required` / `optional` 参数。

示例：

```bash
curl -s http://127.0.0.1:10089/tools
```

### `POST /api/connections`

返回扩展需要连接的 WebSocket 地址与端口。

示例：

```bash
curl -s -X POST http://127.0.0.1:10089/api/connections
```

### `POST /command`

通过已连接的扩展执行浏览器命令。

请求体格式：

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

字段说明：

- `action`：要调用的工具名
- `args`：工具参数
- `session`：可选，会话名，用于串联多步浏览器操作
- `timeout_ms`：可选，单次调用超时时间，默认 `30000`

示例：

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

这是给 Chrome 扩展使用的 WebSocket 入口，不是给普通脚本直接调用的业务接口。

## 常见调用流程

一个最常见的调试流程通常是：

1. 启动守护进程
2. 确认扩展已连接：`/status`
3. 查看工具清单：`/tools`
4. 发起命令：`/command`
5. 检查返回结果或日志

例如：

```bash
./bin/chrome-bridge start
curl -s http://127.0.0.1:10089/status
curl -s http://127.0.0.1:10089/tools
```

## 错误处理与行为说明

服务端目前有这些关键行为：

- **未知工具**：会在进入桥接层前被拒绝
- **缺少必填参数**：会直接返回 `400`
- **扩展未连接**：通常返回 `503`
- **调用超时**：通常返回 `504`
- **扩展执行出错**：通常返回 `502`
- **第二个扩展重复连接**：会被拒绝，以避免多个浏览器实例争抢同一桥接通道

设计上同一时刻只保留一个活动扩展连接，这是为了避免 tab 级调试附着冲突。

## 开发与测试

运行测试：

```bash
make test
```

等价的原始 Go 命令：

```bash
GOTOOLCHAIN=local go test ./...
```

如果你在改这些模块，建议优先关注：

- `cmd/chrome-bridge/main.go`：CLI 生命周期管理
- `internal/server/server.go`：HTTP 路由与命令转发
- `internal/server/tools.go`：工具注册与参数校验
- `internal/bridge/manager.go`：WebSocket 桥接与请求匹配

## 适合谁用

这个服务主要适用于：

- 需要让本地 Agent 控制真实浏览器的工具链
- 需要稳定桥接 Chrome 扩展与本地自动化逻辑的开发者
- 希望通过 HTTP 层统一编排浏览器操作，而不是直接耦合扩展实现的项目

如果你要找更底层的协议、实现思路和演进计划，请继续看：

- `chrome-bridge-api/docs/technical-plan.md`
