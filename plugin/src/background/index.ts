/**
 * Service Worker 入口模块
 *
 * 负责初始化工具注册、WebSocket 连接管理、
 * 定时器（重连/健康检查）监听，以及 popup 页面的消息处理。
 */

import { HEALTHCHECK_ALARM, RECONNECT_ALARM } from './protocol';
import { executeTool, registerTools } from './tools';
import { BridgeSocket } from './wsClient';

// 注册所有内置工具
registerTools();

// 创建 WebSocket 桥接实例，绑定工具执行回调
const bridge = new BridgeSocket(executeTool);

// 初始化时设置未连接状态的图标
void chrome.action.setIcon({
  path: {
    16: 'icons/disconnected-16.png',
    32: 'icons/disconnected-32.png',
    48: 'icons/disconnected-48.png',
    128: 'icons/disconnected-128.png'
  }
});

// 启动时尝试恢复连接（如果之前设置了自动重连）
void bridge.reconnectIfNeeded();
// 启动定期健康检查
void bridge.startHealthcheck();

// 监听定时器事件：重连和健康检查
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) {
    void bridge.reconnectIfNeeded();
    return;
  }

  if (alarm.name === HEALTHCHECK_ALARM) {
    void bridge.handleHealthcheckAlarm();
  }
});

// 监听来自 popup 页面的消息，支持状态查询、连接/断开、测试连接和生成连接
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void (async () => {
    try {
      switch (message.type) {
        case 'GET_STATUS':
          sendResponse({
            connected: bridge.isConnected(),
            serverUrl: bridge.getServerUrl()
          });
          return;
        case 'CONNECT':
          if (typeof message.url !== 'string') {
            throw new Error('CONNECT requires url');
          }
          await bridge.connect(message.url);
          sendResponse({ success: true });
          return;
        case 'DISCONNECT':
          await bridge.disconnect();
          sendResponse({ success: true });
          return;
        case 'TEST_CONNECTION':
          if (typeof message.url !== 'string') {
            throw new Error('TEST_CONNECTION requires url');
          }
          sendResponse(await bridge.testConnection(message.url));
          return;
        case 'GENERATE_CONNECTION': {
          if (typeof message.serverBase !== 'string') {
            throw new Error('GENERATE_CONNECTION requires serverBase');
          }
          const response = await fetch(`${message.serverBase}/api/connections`, {
            method: 'POST'
          });
          if (!response.ok) {
            throw new Error(`Server error: ${response.status}`);
          }
          sendResponse(await response.json());
          return;
        }
        default:
          sendResponse({ error: `unknown type: ${String(message.type)}` });
      }
    } catch (error) {
      sendResponse({ error: error instanceof Error ? error.message : String(error) });
    }
  })();

  // The response is sent asynchronously from the promise above.
  return true;
});
