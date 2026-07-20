/**
 * WebSocket 客户端模块
 *
 * 管理插件与 chrome-bridge 服务端之间的 WebSocket 连接，
 * 包括连接、断开、自动重连、健康检查、端口自动发现，
 * 以及接收服务端的工具调用请求并返回执行结果。
 */

import {
  BridgeMessage,
  DEFAULT_WS_URL,
  DEFAULT_WS_URLS,
  HEALTHCHECK_ALARM,
  HEALTHCHECK_INTERVAL_MINUTES,
  PORT_SCAN_TIMEOUT_MS,
  RECONNECT_ALARM,
  RECONNECT_DELAY_MS,
  STORAGE_KEYS,
  ToolArgs,
  ToolResult
} from './protocol';

/** 工具执行器函数类型：接收工具名和参数，返回执行结果 */
export type ToolExecutor = (name: string, args: ToolArgs) => Promise<ToolResult>;

/**
 * BridgeSocket — 管理与服务端之间的 WebSocket 连接生命周期。
 *
 * 核心职责：
 * - 建立/断开 WebSocket 连接
 * - 自动端口发现（扫描默认端口列表）
 * - 断线自动重连（定时器 + chrome.alarms 双保险）
 * - 健康检查（定期探测并恢复连接）
 * - 接收服务端的 tool_call 消息，调用对应工具并回传结果
 */
export class BridgeSocket {
  /** 当前 WebSocket 实例 */
  private socket: WebSocket | null = null;
  /** 当前连接状态 */
  private state: 'connected' | 'connecting' | 'disconnected' = 'disconnected';
  /** 当前连接的 WebSocket URL */
  private currentUrl = '';
  /** 是否应在断线后自动重连 */
  private shouldReconnect = false;
  /** 重连定时器句柄 */
  private reconnectTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  /** 标记是否正在主动断开（避免断开时触发自动重连） */
  private isDisconnecting = false;
  /** 是否启用自动端口发现模式 */
  private autoPortDiscovery = true;

  /** @param executeTool 工具执行回调，用于处理服务端发来的工具调用 */
  constructor(private readonly executeTool: ToolExecutor) {}

  /** 根据连接状态更新插件图标（已连接/未连接） */
  private async updateActionIcon(connected: boolean): Promise<void> {
    const prefix = connected ? 'connected' : 'disconnected';
    await chrome.action.setIcon({
      path: {
        16: `icons/${prefix}-16.png`,
        32: `icons/${prefix}-32.png`,
        48: `icons/${prefix}-48.png`,
        128: `icons/${prefix}-128.png`
      }
    });
  }

  /** 当前是否已连接 */
  isConnected(): boolean {
    return this.state === 'connected';
  }

  /** 获取当前连接的服务端 URL */
  getServerUrl(): string {
    return this.currentUrl;
  }

  /** 启动定期健康检查定时器 */
  async startHealthcheck(): Promise<void> {
    await chrome.alarms.create(HEALTHCHECK_ALARM, {
      periodInMinutes: HEALTHCHECK_INTERVAL_MINUTES
    });
  }

  /** 健康检查回调：当连接断开时尝试探测并恢复连接 */
  async handleHealthcheckAlarm(): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting') {
      return;
    }

    const target = await this.resolveReconnectTarget();
    if (!target) {
      return;
    }

    const probeUrl = target.autoPortDiscovery
      ? ((await this.findConnectableUrl()) ?? DEFAULT_WS_URL)
      : target.url;

    if (!probeUrl) {
      return;
    }

    const result = await this.testConnection(probeUrl, PORT_SCAN_TIMEOUT_MS);

    if (result.ok) {
      await this.connect(target.autoPortDiscovery ? undefined : target.url);
    }
  }

  /**
   * 连接到服务端。
   * @param url 目标 WebSocket URL；不传则启用自动端口发现模式
   */
  async connect(url?: string): Promise<void> {
    const autoPortDiscovery = !url;
    if (!autoPortDiscovery && url !== this.currentUrl && this.state !== 'disconnected') {
      await this.disconnect();
    }

    if (this.state === 'connecting' || this.state === 'connected') {
      return;
    }

    const targetUrl = autoPortDiscovery ? await this.findAvailableDefaultUrl() : url;
    await this.openSocket(targetUrl, autoPortDiscovery);
  }

  /**
   * 打开 WebSocket 连接并设置事件监听。
   * 连接成功后发送 hello 握手消息，断线时触发自动重连。
   * @param targetUrl 目标 WebSocket URL
   * @param autoPortDiscovery 是否为自动端口发现模式
   */
  private async openSocket(targetUrl: string, autoPortDiscovery: boolean): Promise<void> {
    this.currentUrl = targetUrl;
    this.shouldReconnect = true;
    this.isDisconnecting = false;
    this.autoPortDiscovery = autoPortDiscovery;
    this.state = 'connecting';

    await chrome.storage.session.set({
      [STORAGE_KEYS.shouldReconnect]: true,
      [STORAGE_KEYS.wsUrl]: targetUrl,
      [STORAGE_KEYS.autoPortDiscovery]: autoPortDiscovery
    });
    await chrome.storage.local.set({
      [STORAGE_KEYS.localUrl]: targetUrl,
      [STORAGE_KEYS.autoPortDiscovery]: autoPortDiscovery
    });

    try {
      const socket = new WebSocket(targetUrl);
      this.socket = socket;

      socket.addEventListener('open', () => {
        if (this.isDisconnecting) {
          socket.close();
          return;
        }

        this.state = 'connected';
        this.clearReconnectTimer();
        void this.updateActionIcon(true);
        this.send({
          type: 'hello',
          payload: {
            extensionName: 'chrome-bridge',
            extensionVersion: chrome.runtime.getManifest().version
          }
        });
      });

      socket.addEventListener('message', (event) => {
        try {
          this.handleMessage(JSON.parse(String(event.data)) as BridgeMessage);
        } catch (error) {
          console.error('[chrome-bridge] invalid ws message', error);
        }
      });

      socket.addEventListener('close', () => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.state = 'disconnected';
        void this.updateActionIcon(false);

        if (!this.isDisconnecting && this.shouldReconnect) {
          this.scheduleReconnect();
        }
      });

      socket.addEventListener('error', (error) => {
        console.error('[chrome-bridge] websocket error', error);
      });
    } catch (error) {
      this.state = 'disconnected';
      void this.updateActionIcon(false);
      console.error('[chrome-bridge] websocket connect failed', error);
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
    }
  }

  /** 主动断开连接，清除重连状态和定时器 */
  async disconnect(): Promise<void> {
    this.isDisconnecting = true;
    this.shouldReconnect = false;
    this.clearReconnectTimer();
    await chrome.storage.session.set({ [STORAGE_KEYS.shouldReconnect]: false });
    await chrome.alarms.clear(RECONNECT_ALARM);

    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }

    this.state = 'disconnected';
    await this.updateActionIcon(false);
  }

 /** 如果之前设置了自动重连，则尝试恢复连接 */
  async reconnectIfNeeded(): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting') {
      return;
    }

    const target = await this.resolveReconnectTarget();
    if (!target) {
      return;
    }

    if (!target.autoPortDiscovery && !target.url) {
      return;
    }

    await this.connect(target.autoPortDiscovery ? undefined : target.url);
  }

  /**
   * 从 session/local 存储中解析重连目标。
   * 优先使用 session 存储中的配置，其次回退到 local 存储。
   * @returns 重连目标信息（URL 和是否自动端口发现），无有效配置时返回默认自动发现
   */
  private async resolveReconnectTarget(): Promise<
    | { url?: string; autoPortDiscovery: boolean }
    | null
  > {

    const session = await chrome.storage.session.get([
      STORAGE_KEYS.shouldReconnect,
      STORAGE_KEYS.wsUrl,
      STORAGE_KEYS.autoPortDiscovery
    ]);
    const shouldReconnect = session[STORAGE_KEYS.shouldReconnect] === true;
    const sessionUrl = session[STORAGE_KEYS.wsUrl];
    const sessionAutoPortDiscovery =
      session[STORAGE_KEYS.autoPortDiscovery] === true ||
      (session[STORAGE_KEYS.autoPortDiscovery] !== false &&
        typeof sessionUrl === 'string' &&
        DEFAULT_WS_URLS.includes(sessionUrl));

    if (shouldReconnect && sessionAutoPortDiscovery) {
      return { autoPortDiscovery: true };
    }

    if (shouldReconnect && typeof sessionUrl === 'string') {
      return { url: sessionUrl, autoPortDiscovery: false };
    }

    const local = await chrome.storage.local.get([
      STORAGE_KEYS.localUrl,
      STORAGE_KEYS.autoPortDiscovery
    ]);
    const localUrl = local[STORAGE_KEYS.localUrl];
    const localAutoPortDiscovery =
      local[STORAGE_KEYS.autoPortDiscovery] === true ||
      (local[STORAGE_KEYS.autoPortDiscovery] !== false &&
        (typeof localUrl !== 'string' || DEFAULT_WS_URLS.includes(localUrl)));

    if (localAutoPortDiscovery) {
      return { autoPortDiscovery: true };
    }

    if (typeof localUrl === 'string') {
      return { url: localUrl, autoPortDiscovery: false };
    }

    return { autoPortDiscovery: true };
  }

  /**
   * 测试到指定 URL 的 WebSocket 连接是否可达。
   * @param url 目标 WebSocket URL
   * @param timeoutMs 超时时间（毫秒），默认 5 秒
   * @returns 连接成功返回 { ok: true }，失败返回 { ok: false, reason }
   */
  async testConnection(
    url: string,
    timeoutMs = 5_000
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    return new Promise((resolve) => {
      let socket: WebSocket;

      try {
        socket = new WebSocket(url);
      } catch (error) {
        resolve({ ok: false, reason: error instanceof Error ? error.message : 'invalid url' });
        return;
      }

      let resolved = false;
      const timer = globalThis.setTimeout(() => {
        if (resolved) return;
        resolved = true;
        socket.close();
        resolve({ ok: false, reason: 'timeout' });
      }, timeoutMs);

      socket.addEventListener('open', () => {
        if (resolved) return;
        resolved = true;
        globalThis.clearTimeout(timer);
        socket.close();
        resolve({ ok: true });
      });

      socket.addEventListener('error', () => {
        if (resolved) return;
        resolved = true;
        globalThis.clearTimeout(timer);
        socket.close();
        resolve({ ok: false, reason: 'connect failed' });
      });
    });
  }

  /** 安排重连：先设置 setTimeout 延迟重连，再创建 chrome.alarms 作为备份唤醒 */
  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    this.reconnectTimer = globalThis.setTimeout(() => {
      void this.connect(this.autoPortDiscovery ? undefined : this.currentUrl);
    }, RECONNECT_DELAY_MS);
    void chrome.alarms.create(RECONNECT_ALARM, { delayInMinutes: 1 });
  }

  private async findAvailableDefaultUrl(): Promise<string> {
    const connectableUrl = await this.findConnectableUrl();
    if (connectableUrl) {
      return connectableUrl;
    }

    return DEFAULT_WS_URL;
  }

  /** 扫描默认端口列表，返回第一个可连接的 URL；全部不可达则返回 null */
  async findConnectableUrl(): Promise<string | null> {
    for (const candidateUrl of DEFAULT_WS_URLS) {
      const result = await this.testConnection(candidateUrl, PORT_SCAN_TIMEOUT_MS);
      if (result.ok) {
        return candidateUrl;
      }
    }

    return null;
  }

  /** 清除重连定时器和对应的 chrome.alarms */
  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      globalThis.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    void chrome.alarms.clear(RECONNECT_ALARM);
  }

  /** 处理收到的 WebSocket 消息：ping 回 pong，tool_call 转发执行 */
  private handleMessage(message: BridgeMessage): void {
    switch (message.type) {
      case 'ping':
        this.send({ type: 'pong', responseToRequestId: message.requestId });
        return;
      case 'hello_ack':
        return;
      case 'tool_call':
        void this.handleToolCall(message);
        return;
      default:
        console.log('[chrome-bridge] unhandled ws message', message.type);
    }
  }

  /** 处理服务端发来的工具调用请求，执行后回传 tool_result */
  private async handleToolCall(message: BridgeMessage): Promise<void> {
    const payload = 'payload' in message ? message.payload : undefined;

    if (!payload || typeof payload !== 'object' || !('name' in payload)) {
      this.send({
        type: 'tool_result',
        responseToRequestId: message.requestId,
        payload: { error: 'missing tool name' }
      });
      return;
    }

    const toolPayload = payload as { name?: unknown; args?: unknown };
    const name = typeof toolPayload.name === 'string' ? toolPayload.name : '';
    const args =
      toolPayload.args && typeof toolPayload.args === 'object'
        ? (toolPayload.args as ToolArgs)
        : {};

    try {
      const data = await this.executeTool(name, args);
      this.send({
        type: 'tool_result',
        responseToRequestId: message.requestId,
        payload: { data }
      });
    } catch (error) {
      this.send({
        type: 'tool_result',
        responseToRequestId: message.requestId,
        payload: { error: error instanceof Error ? error.message : String(error) }
      });
    }
  }

  /** 通过当前 WebSocket 发送 JSON 消息（仅在连接已打开时发送） */
  private send(message: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }
}
