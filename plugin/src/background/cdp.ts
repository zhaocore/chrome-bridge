/**
 * Chrome DevTools Protocol (CDP) 封装模块
 *
 * 管理浏览器标签页的 debugger 附加/分离，
 * 并提供向当前活动标签页发送 CDP 命令的统一接口。
 */

/// <reference types="chrome" />

/** 已附加 debugger 的标签页 ID 集合 */
const attachedTabIds = new Set<number>();

/** 当前活动附加的标签页 ID */
let activeAttachedTabId: number | null = null;
/** 上一次操作的目标标签页 ID（用于快速复用） */
let lastTargetTabId: number | null = null;

/** 标签页关闭时清理对应的附加状态 */
chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabIds.delete(tabId);
  if (activeAttachedTabId === tabId) activeAttachedTabId = null;
  if (lastTargetTabId === tabId) lastTargetTabId = null;
});

/** debugger 分离时清理对应的附加状态 */
chrome.debugger.onDetach.addListener((source) => {
  if (!source.tabId) return;
  attachedTabIds.delete(source.tabId);
  if (activeAttachedTabId === source.tabId) activeAttachedTabId = null;
});

/**
 * 附加 debugger 到指定标签页。
 * 如果已附加则直接设为活动标签页；否则先尝试分离（确保幂等），再重新附加。
 * @param tabId 目标标签页 ID
 */
export async function attachToTab(tabId: number): Promise<void> {
  if (attachedTabIds.has(tabId)) {
    activeAttachedTabId = tabId;
    return;
  }

  // Chrome allows only one debugger attachment per tab. Detaching first makes
  // reconnects deterministic when the worker was restarted or a previous tool failed.
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // The tab may not have been attached. That is fine.
  }

  await chrome.debugger.attach({ tabId }, '1.3');
  attachedTabIds.add(tabId);
  activeAttachedTabId = tabId;
}

/**
 * 向当前活动附加的标签页发送 CDP 命令。
 * @param method CDP 方法名（如 'Page.navigate'）
 * @param params 方法参数
 * @returns CDP 响应结果
 */
export async function sendCdp<T = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  if (activeAttachedTabId === null) {
    throw new Error('No tab attached. Attach a tab before sending CDP commands.');
  }
  const result = await chrome.debugger.sendCommand({ tabId: activeAttachedTabId }, method, params);
  return result as T;
}

/**
 * 获取目标标签页：优先使用当前活动附加的标签页，
 * 其次尝试上一次操作的标签页，最后回退到当前窗口的活动标签页。
 * @returns 目标标签页对象
 */
export async function getTargetTab(): Promise<chrome.tabs.Tab> {
  if (activeAttachedTabId !== null) {
    try {
      return await chrome.tabs.get(activeAttachedTabId);
    } catch {
      attachedTabIds.delete(activeAttachedTabId);
      activeAttachedTabId = null;
    }
  }

  if (lastTargetTabId !== null) {
    try {
      return await chrome.tabs.get(lastTargetTabId);
    } catch {
      lastTargetTabId = null;
    }
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error('No active tab found.');
  }

  lastTargetTabId = tab.id;
  return tab;
}

/** 记住上一次操作的目标标签页 ID，便于后续快速复用 */
export function rememberTargetTab(tabId: number): void {
  lastTargetTabId = tabId;
}

/** 标记指定标签页为当前活动附加的标签页 */
export function markActiveAttached(tabId: number): void {
  activeAttachedTabId = tabId;
}

/** 获取当前活动附加的标签页 ID */
export function getActiveAttachedTabId(): number | null {
  return activeAttachedTabId;
}
