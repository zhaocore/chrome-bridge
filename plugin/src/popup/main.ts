/**
 * Popup 页面入口模块
 *
 * 管理插件弹出窗口的 UI 交互：
 * - 显示连接状态和服务器 URL
 * - 测试/连接/断开 WebSocket 连接
 * - 定期刷新连接状态
 */

import './style.css';
import { DEFAULT_WS_URL } from '../background/protocol';

// 获取 DOM 元素引用
const statusEl = document.querySelector<HTMLParagraphElement>('#status')!;
const detailEl = document.querySelector<HTMLPreElement>('#detail')!;
const urlInput = document.querySelector<HTMLInputElement>('#server-url')!;
const testButton = document.querySelector<HTMLButtonElement>('#test')!;
const connectButton = document.querySelector<HTMLButtonElement>('#connect')!;
const disconnectButton = document.querySelector<HTMLButtonElement>('#disconnect')!;

if (!statusEl || !detailEl || !urlInput || !testButton || !connectButton || !disconnectButton) {
  throw new Error('Popup DOM is incomplete.');
}

/** GET_STATUS 消息的响应类型 */
type StatusResponse = {
  connected?: boolean;
  serverUrl?: string;
  error?: string;
};

/** TEST_CONNECTION 消息的响应类型 */
type TestResponse = {
  ok?: boolean;
  reason?: string;
  error?: string;
};

/** 向 background service worker 发送消息 */
function sendMessage<T>(message: Record<string, unknown>): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

/** 读取输入框中的 URL 并校验协议前缀，为空时使用默认 URL */
function normalizeUrl(): string {
  const url = urlInput.value.trim() || DEFAULT_WS_URL;
  if (!/^wss?:\/\//.test(url)) {
    throw new Error('地址必须以 ws:// 或 wss:// 开头');
  }
  return url;
}

/** 将值格式化为 JSON 字符串并显示在详情区域 */
function renderDetail(value: unknown): void {
  detailEl.textContent = JSON.stringify(value, null, 2);
}

/** 查询并刷新连接状态显示 */
async function refreshStatus(): Promise<void> {
  const status = await sendMessage<StatusResponse>({ type: 'GET_STATUS' });
  if (status.error) {
    statusEl.textContent = `状态异常：${status.error}`;
    statusEl.dataset.state = 'error';
    renderDetail(status);
    return;
  }

  const connected = status.connected === true;
  statusEl.textContent = connected ? '已连接' : '未连接';
  statusEl.dataset.state = connected ? 'connected' : 'disconnected';
  if (status.serverUrl) {
    urlInput.value = status.serverUrl;
  } else if (!urlInput.value) {
    urlInput.value = DEFAULT_WS_URL;
  }
  renderDetail(status);
}

// 测试连接按钮：测试指定 URL 的 WebSocket 可达性
testButton.addEventListener('click', async () => {
  try {
    const url = normalizeUrl();
    testButton.disabled = true;
    testButton.textContent = '测试中...';
    const result = await sendMessage<TestResponse>({ type: 'TEST_CONNECTION', url });
    renderDetail(result);
    statusEl.textContent = result.ok ? '连接测试成功' : `连接测试失败：${result.reason || result.error}`;
    statusEl.dataset.state = result.ok ? 'connected' : 'error';
  } catch (error) {
    statusEl.textContent = error instanceof Error ? error.message : String(error);
    statusEl.dataset.state = 'error';
  } finally {
    testButton.disabled = false;
    testButton.textContent = '测试';
  }
});

// 连接按钮：建立 WebSocket 连接
connectButton.addEventListener('click', async () => {
  try {
    const url = normalizeUrl();
    connectButton.disabled = true;
    await sendMessage({ type: 'CONNECT', url });
    await refreshStatus();
  } catch (error) {
    statusEl.textContent = error instanceof Error ? error.message : String(error);
    statusEl.dataset.state = 'error';
  } finally {
    connectButton.disabled = false;
  }
});

// 断开按钮：断开 WebSocket 连接
disconnectButton.addEventListener('click', async () => {
  disconnectButton.disabled = true;
  await sendMessage({ type: 'DISCONNECT' });
  await refreshStatus();
  disconnectButton.disabled = false;
});

// 初始化时刷新一次状态，并设置 2 秒间隔定时刷新
void refreshStatus();
globalThis.setInterval(() => {
  void refreshStatus();
}, 2_000);
