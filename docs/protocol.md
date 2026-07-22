# WebSocket 桥接协议

守护进程与扩展之间通过 WebSocket 通信，协议消息类型包括：

| 消息类型 | 方向 | 用途 |
| --- | --- | --- |
| `hello` | 扩展 → daemon | 握手，携带扩展名称和版本 |
| `hello_ack` | daemon → 扩展 | 握手确认，返回 daemon 版本 |
| `ping` / `pong` | 双向 | 心跳保活 |
| `tool_call` | daemon → 扩展 | 工具调用请求 |
| `tool_result` | 扩展 → daemon | 工具执行结果 |

## 示例

`tool_call`：

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

`tool_result`：

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
