/**
 * 协议与常量定义模块
 *
 * 统一管理 WebSocket 连接参数、端口配置、存储键名、
 * 消息类型以及工具函数的参数校验辅助方法。
 */

/// <reference types="chrome" />

/** 默认 WebSocket 端口范围（单个端口 10089） */
const DEFAULT_WS_PORT_RANGE = { start: 10089, end: 10089 } as const;
/** 默认 WebSocket 主机地址 */
const DEFAULT_WS_HOST = '127.0.0.1';
/** 默认 WebSocket 路径 */
const DEFAULT_WS_PATH = '/ws';

/** 根据起始和结束端口生成连续端口数组 */
function createPortRange(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

/** 将环境变量中的端口字符串解析为端口号数组，支持逗号分隔和方括号包裹 */
function parsePortList(value: unknown): number[] {
  if (typeof value !== 'string' || !value.trim()) {
    return [];
  }

  const rawPorts = value.trim().replace(/^\[/, '').replace(/\]$/, '').split(',');
  const ports = rawPorts
    .map((port) => Number(port.trim()))
    .filter((port) => Number.isInteger(port) && port > 0 && port <= 65_535);

  return [...new Set(ports)];
}

/** 默认端口列表（由默认端口范围生成） */
export const DEFAULT_WS_PORTS = createPortRange(
  DEFAULT_WS_PORT_RANGE.start,
  DEFAULT_WS_PORT_RANGE.end
);
/** 从环境变量 VITE_WS_PORTS 解析的自定义端口列表 */
export const WS_PORTS = parsePortList(import.meta.env.VITE_WS_PORTS);
/** 实际使用的端口列表：优先使用环境变量配置，否则回退到默认端口 */
export const ACTIVE_WS_PORTS = WS_PORTS.length > 0 ? WS_PORTS : DEFAULT_WS_PORTS;
/** 默认 WebSocket URL 列表（由实际端口列表生成） */
export const DEFAULT_WS_URLS = ACTIVE_WS_PORTS.map(
  (port) => `ws://${DEFAULT_WS_HOST}:${port}${DEFAULT_WS_PATH}`
);
/** 默认 WebSocket URL（列表中的第一个） */
export const DEFAULT_WS_URL = DEFAULT_WS_URLS[0];
/** 端口扫描超时时间（毫秒） */
export const PORT_SCAN_TIMEOUT_MS = 1_000;
/** 重连定时器对应的 chrome.alarms 名称 */
export const RECONNECT_ALARM = 'chrome-bridge-reconnect';
/** 健康检查定时器对应的 chrome.alarms 名称 */
export const HEALTHCHECK_ALARM = 'chrome-bridge-healthcheck';
/** 重连延迟时间（毫秒） */
export const RECONNECT_DELAY_MS = 5_000;
/** 健康检查间隔（分钟），0.5 分钟 = 30 秒 */
export const HEALTHCHECK_INTERVAL_MINUTES = 0.5;

/** chrome.storage 中使用的键名集合 */
export const STORAGE_KEYS = {
  shouldReconnect: 'chrome_bridge_lite_should_reconnect',
  wsUrl: 'chrome_bridge_lite_ws_url',
  autoPortDiscovery: 'chrome_bridge_lite_auto_port_discovery',
  localUrl: 'chrome_bridge_lite_local_url'
} as const;

/** JSON 值的递归类型定义 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** 工具调用的参数类型，包含通用键值对和可选的内部控制字段 */
export type ToolArgs = Record<string, unknown> & {
  _tabId?: number;
  _tabIds?: number[];
  _session?: string;
  group_title?: string;
};

/** 工具执行结果的联合类型 */
export type ToolResult = Record<string, unknown> | unknown[] | string | number | boolean | null;

/** 工具调用载荷：包含工具名称和参数 */
export type ToolCallPayload = {
  name?: string;
  args?: ToolArgs;
};

/** WebSocket 消息类型：支持 ping/hello_ack/tool_call 及其他自定义消息 */
export type BridgeMessage =
  | { type: 'ping'; requestId?: string }
  | { type: 'hello_ack'; requestId?: string }
  | { type: 'tool_call'; requestId?: string; payload?: ToolCallPayload }
  | { type: string; requestId?: string; payload?: unknown };

/** 工具接口：每个工具需提供名称和异步执行方法 */
export type Tool = {
  name: string;
  execute(args: ToolArgs): Promise<ToolResult>;
};

/** 从参数中提取必填的字符串值，缺失或非字符串时抛出异常 */
export function requireString(args: ToolArgs, key: string, toolName: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value) {
    throw new Error(`${toolName}: ${key} is required`);
  }
  return value;
}

/** 从参数中提取可选的字符串值 */
export function optionalString(args: ToolArgs, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

/** 从参数中提取可选的布尔值 */
export function optionalBoolean(args: ToolArgs, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === 'boolean' ? value : undefined;
}

/** 从参数中提取可选的数值（需为有限数） */
export function optionalNumber(args: ToolArgs, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
