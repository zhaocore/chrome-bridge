# 技术架构

Chrome Bridge 的技术栈分三层，全程本地执行。

## 本地守护进程（chrome-bridge-api）

用 Go 编写，负责接收来自 Agent 的指令、管理浏览器连接、维护会话状态。跑在用户的 macOS、Linux 或 Windows 系统上，不依赖云端。

核心能力：

- **生命周期管理**：`start`、`stop`、`restart`、`status`
- **HTTP API**：`GET /status`、`POST /command`、`GET /tools`、`POST /api/connections`
- **WebSocket 端点**：`/ws`，供 Chrome 扩展建立唯一桥接连接
- **参数校验**：工具调用参数在进入浏览器侧之前先做验证
- **会话状态**：`session → tabIds` 映射，支持多步浏览器操作串联
- **文件归一化**：截图、PDF 等二进制结果写入磁盘并返回文件路径
- **运行日志**：便于排查扩展未连接、调用超时、参数错误等问题

默认监听地址：`127.0.0.1:10089`

## 浏览器扩展层（chrome-bridge-plugin）

Chrome/Edge 扩展通过 Chrome DevTools Protocol（CDP）执行具体操作。CDP 是 Chrome 官方调试协议，Puppeteer、Playwright 都基于它。Chrome Bridge 的不同点是直接挂在用户当前浏览器实例上，而不是另起一个隔离的无头浏览器——这意味着**登录态、Cookie、扩展配置全部继承**。

数据流：

```
local daemon
  <-> ws://127.0.0.1:10089/ws
Chrome extension background service worker
  <-> chrome.debugger / Chrome DevTools Protocol
active Chrome tab
```

扩展权限包括 `debugger`、`tabs`、`activeTab`、`storage`、`alarms`、`tabGroups`、`windows`、`<all_urls>`。一个已连接的 daemon 可以指示扩展读取页面、点击、输入、截图、导出 PDF、上传文件、关闭标签页。因此，**只应将此扩展连接到受信任的本地守护进程**。

## 安全隔离层

Agent 通过本地守护进程发指令，得到的是操作结果（如"点击成功""提取到 50 行数据"），不会拿到用户的密码、Cookie 原文等敏感凭证。

整个流程：

```
Agent 发送自然语言指令
  → 本地守护进程解析
  → WebSocket 转发给 Chrome 扩展
  → CDP 调用浏览器执行
  → 结果回传守护进程
  → 标准化后返回 Agent
```

全程不出本机。

## 本地优先 vs 云端方案

云端浏览器自动化方案（Playwright Cloud、Selenium Grid、Skyvern 等）共同的痛点是登录态和数据合规。Chrome Bridge 的本地路径直接绕过去了。

| 维度 | 云端方案 | Chrome Bridge |
| --- | --- | --- |
| 登录态 | 需要重新模拟登录、处理验证码 | 直接复用用户当前浏览器登录状态 |
| 数据流向 | 网页内容上传至服务器处理 | 全程本地执行，不出本机 |
| 反爬应对 | 容易被识别为自动化流量 | 行为模式与真人浏览器一致 |
| 部署成本 | 需配置云端环境 | 一行命令安装 |
| 合规风险 | 涉及第三方数据传输 | 无外部数据流转 |

视觉代理类方案（如 Skyvern、WebVoyager）的另一个问题是要把页面截图传给视觉模型识别——这意味着所有页面内容都被云端"看"过一遍。Chrome Bridge 通过 CDP 直接读 DOM 结构和无障碍树，省掉了视觉识别这一步，也省掉了数据外传的风险。

对企业用户而言，这个差异是决定性的。很多内部系统、合规敏感场景里，"页面内容能不能让外部 AI 看到"本身就是项目能不能落地的前提。
