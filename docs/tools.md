# 浏览器操作工具

当前注册的工具涵盖导航、DOM 交互、输入、截图、文件操作等完整链路：

| 工具 | 参数 | 返回 | 说明 |
| --- | --- | --- | --- |
| `navigate` | `url`, `newTab`(bool), `group_title` | `{success, url, tabId}` | 导航到指定 URL，首次调用建议 `newTab:true` |
| `find_tab` | `url`, `active`(bool) | `{success, url, tabId}` | 复用已打开的标签页，按域名匹配 |
| `snapshot` | — | `{url, title, tree}` | 无障碍树（文本），用于读取页面内容和定位元素 |
| `click` | `selector` | `{success, tag, text}` | 合成 `el.click()` |
| `fill` | `selector`, `value` | `{success, tag, mode}` | 支持 `<input>`/`<textarea>` 和 `[contenteditable]` |
| `evaluate` | `code` | `{type, value}` | 执行 JS，支持 async/await |
| `screenshot` | `format`, `quality`, `selector`, `path` | `{format, path, sizeBytes}` | 截图写入磁盘，返回文件路径 |
| `save_as_pdf` | `paper_format`, `landscape`, `scale`, `path` | `{path, sizeBytes}` | 当前页面导出为 PDF |
| `network` | `cmd`, `filter`, `requestId` | 请求/响应数据 | 网络请求拦截与分析 |
| `upload` | `selector`, `files` | `{success, fileCount}` | 文件上传 |
| `list_tabs` | — | `{success, tabs[]}` | 列出当前会话的标签页 |
| `close_tab` | — | `{success, closed}` | 关闭当前标签页 |
| `close_session` | — | `{success, closed}` | 关闭会话所有标签页 |
| `mouse_click` | `selector` | — | 模拟鼠标点击 |
| `cdp` | `method`, `params` | — | 直接调用 CDP 方法 |
| `key_type` | `text` | — | 键入文本 |
| `send_keys` | `keys`, `repeat` | — | 发送按键序列 |

可通过 `GET /tools` 获取机器可读的工具清单及参数要求。

## 会话管理

每个会话映射到一个独立的浏览器标签页组。使用不同的 session 名称操作不同网站，保持隔离：

```bash
curl -s -X POST http://127.0.0.1:10089/command \
  -H 'Content-Type: application/json' \
  -d '{"action":"navigate","args":{"url":"https://example.com","newTab":true},"session":"my-task"}'
```

任务结束时调用 `close_session` 清理所有标签页。
