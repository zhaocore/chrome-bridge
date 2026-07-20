/**
 * 工具实现模块
 *
 * 定义并注册所有可供服务端调用的浏览器操作工具，
 * 包括导航、标签页管理、页面求值、网络抓包、无障碍快照、
 * 点击/填充/键盘输入、截图、PDF 导出、文件上传等。
 * 每个工具实现 Tool 接口，通过 registerTools() 统一注册。
 */

import {
  attachToTab,
  getActiveAttachedTabId,
  getTargetTab,
  markActiveAttached,
  rememberTargetTab,
  sendCdp
} from './cdp';
import {
  optionalBoolean,
  optionalNumber,
  optionalString,
  requireString,
  Tool,
  ToolArgs,
  ToolResult
} from './protocol';

// CDP responses are method-dependent and intentionally dynamic at this boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CdpObject = Record<string, any>;

/** 无障碍树节点结构 */
type AxNode = {
  nodeId: string;
  childIds?: string[];
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: string };
  description?: { value?: string };
  backendDOMNodeId?: number;
};

/** 已注册的工具映射表 */
const tools = new Map<string, Tool>();
/** 会话到标签页分组 ID 的映射 */
const groupIdsBySession = new Map<string, number>();
/** 会话到分组标题的映射 */
const groupTitlesBySession = new Map<string, string>();
/** 可用的标签页分组颜色列表 */
const groupColors = ['green', 'yellow', 'cyan', 'orange', 'pink', 'grey'] as const;
/** 下一个分组颜色的索引（循环使用） */
let nextGroupColor = 0;

/** 无障碍元素引用表：ref ID 到 DOM 节点信息的映射 */
const accessibleRefs = new Map<
  string,
  { backendDOMNodeId: number; role: string; name: string }
>();
/** 下一个可访问性引用的自增 ID */
let nextRefId = 1;

/** 需要生成 ref 的交互式角色集合 */
const interestingRoles = new Set([
  'button',
  'link',
  'textbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'treeitem'
]);

/** 已启用网络抓包的标签页集合 */
const networkEnabledTabs = new Set<number>();
/** 每个标签页的网络请求记录：tabId -> (requestId -> 请求详情) */
const networkRequests = new Map<number, Map<string, CdpObject>>();
/** CDP 网络事件监听器是否已安装 */
let networkListenerInstalled = false;

/** 注册所有内置工具到 tools 映射表 */
export function registerTools(): void {
  [
    new NavigateTool(),
    new FindTabTool(),
    new EvaluateTool(),
    new NetworkTool(),
    new SnapshotTool(),
    new ClickTool(),
    new FillTool(),
    new MouseClickTool(),
    new CdpTool(),
    new KeyTypeTool(),
    new SendKeysTool(),
    new ScreenshotTool(),
    new SaveAsPdfTool(),
    new UploadTool(),
    new CloseTabTool(),
    new ListTabsTool(),
    new CloseSessionTool()
  ].forEach((tool) => tools.set(tool.name, tool));
}

/**
 * 按名称执行工具。
 * 如果参数中包含 _tabId（且不是 close_tab/list_tabs/close_session），
 * 会先附加到指定标签页再执行工具。
 * @param name 工具名称
 * @param args 工具参数
 * @returns 工具执行结果
 */
export async function executeTool(name: string, args: ToolArgs): Promise<ToolResult> {
  const tool = tools.get(name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}. Available: ${[...tools.keys()].join(', ')}`);
  }

  if (
    typeof args._tabId === 'number' &&
    name !== 'close_tab' &&
    name !== 'list_tabs' &&
    name !== 'close_session'
  ) {
    await attachToTab(args._tabId);
    markActiveAttached(args._tabId);
    delete args._tabId;
  }

  return tool.execute(args);
}

/** 附加到当前目标标签页并返回标签页对象 */
async function attachCurrentTab(): Promise<chrome.tabs.Tab> {
  const tab = await getTargetTab();
  if (!tab.id) {
    throw new Error('Active tab has no id.');
  }
  await attachToTab(tab.id);
  rememberTargetTab(tab.id);
  return tab;
}

/**
 * 将标签页归入会话对应的标签组。
 * 如果会话已有分组则直接加入；否则查找或创建新分组。
 * 分组失败不影响工具执行（仅为便利功能）。
 * @param tabId 标签页 ID
 * @param session 会话标识
 * @param title 分组标题（可选）
 */
async function groupTab(tabId: number, session: string, title?: string): Promise<void> {
  try {
    const existingGroupId = groupIdsBySession.get(session);
    if (existingGroupId !== undefined) {
      await chrome.tabs.group({ tabIds: tabId, groupId: existingGroupId });
      return;
    }

    const groupTitle = title || groupTitlesBySession.get(session) || `agent:${session}`;
    const [existingGroup] = await chrome.tabGroups.query({ title: groupTitle });

    if (existingGroup?.id !== undefined) {
      await chrome.tabs.group({ tabIds: tabId, groupId: existingGroup.id });
      groupIdsBySession.set(session, existingGroup.id);
      return;
    }

    groupTitlesBySession.set(session, groupTitle);
    const groupId = await chrome.tabs.group({ tabIds: tabId });
    await chrome.tabGroups.update(groupId, {
      title: groupTitle,
      color: groupColors[nextGroupColor++ % groupColors.length],
      collapsed: false
    });
    groupIdsBySession.set(session, groupId);
  } catch {
    // Tab grouping is a convenience. Tool execution should not fail because a
    // browser version or profile policy does not support groups.
  }
}

/** 等待标签页加载完成，超时默认 30 秒 */
function waitForLoad(tabId: number, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const isLoaded = (tab: chrome.tabs.Tab): boolean =>
      tab.status === 'complete' && !!tab.url && tab.url !== 'about:blank';

    const timer = globalThis.setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('navigate: page load timeout (30s)'));
    }, timeoutMs);

    const listener = (updatedTabId: number, changeInfo: { status?: string }, tab: chrome.tabs.Tab) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete' && isLoaded(tab)) {
        globalThis.clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };

    void chrome.tabs.get(tabId).then((tab) => {
      if (isLoaded(tab)) {
        globalThis.clearTimeout(timer);
        resolve();
      } else {
        chrome.tabs.onUpdated.addListener(listener);
      }
    });
  });
}

/** 将 URL 或主机名转换为 Chrome 扩展匹配模式（如 *://example.com/*） */
function patternFromUrl(input: string): string {
  if (input.includes('*')) return input;
  try {
    return `*://${new URL(input).hostname}/*`;
  } catch {
    return `*://${input.replace(/^\.+/, '')}/*`;
  }
}

/** 判断 URL 的主机名是否与给定模式匹配 */
function sameHost(url: string | undefined, pattern: string): boolean {
  if (!url) return false;
  try {
    const wantedHost = pattern.replace(/^\*:\/\//, '').replace(/\/\*$/, '');
    return new URL(url).hostname === wantedHost;
  } catch {
    return false;
  }
}

/** 清空无障碍元素引用表 */
function resetRefs(): void {
  accessibleRefs.clear();
  nextRefId = 1;
}

/** 注册一个无障碍元素引用，返回形如 @e1 的引用标识 */
function addRef(backendDOMNodeId: number, role: string, name: string): string {
  const ref = `e${nextRefId++}`;
  accessibleRefs.set(ref, { backendDOMNodeId, role, name });
  return `@${ref}`;
}

/** 根据引用标识（@e1 或 e1）查找对应的 DOM 节点信息 */
function getRef(selector: string): { backendDOMNodeId: number; role: string; name: string } | undefined {
  const ref = selector.startsWith('@') ? selector.slice(1) : selector;
  return accessibleRefs.get(ref);
}

/** 判断字符串是否为无障碍引用格式（@e1 或 e1） */
function isRef(selector: string): boolean {
  return /^@?e\d+$/.test(selector);
}

/** 通过 CSS 选择器在页面中查找元素，返回其 CDP objectId */
async function objectIdFromSelector(selector: string, toolName: string): Promise<string> {
  const result = await sendCdp<CdpObject>('Runtime.evaluate', {
    expression: `document.querySelector(${JSON.stringify(selector)})`,
    returnByValue: false
  });

  if (result.exceptionDetails) {
    throw new Error(`${toolName}: ${result.exceptionDetails.text}`);
  }

  if (result.result?.subtype === 'null' || !result.result?.objectId) {
    throw new Error(`${toolName}: element not found: ${selector}`);
  }

  return result.result.objectId;
}

/** 通过无障碍引用查找元素，返回其 CDP objectId */
async function objectIdFromRef(selector: string, toolName: string): Promise<string> {
  const ref = getRef(selector);
  if (!ref) {
    throw new Error(`${toolName}: unknown ref "${selector}". Run snapshot first.`);
  }

  const result = await sendCdp<CdpObject>('DOM.resolveNode', {
    backendNodeId: ref.backendDOMNodeId
  });

  if (!result.object?.objectId) {
    throw new Error(`${toolName}: could not resolve ${selector} to a DOM element.`);
  }

  return result.object.objectId;
}

/** 根据选择器或引用获取元素的 CDP objectId（自动判断类型） */
async function objectIdForSelectorOrRef(selector: string, toolName: string): Promise<string> {
  return isRef(selector)
    ? objectIdFromRef(selector, toolName)
    : objectIdFromSelector(selector, toolName);
}

/** navigate 工具：导航到指定 URL，支持在新标签页或当前标签页中打开 */
class NavigateTool implements Tool {
  name = 'navigate';

  async execute(args: ToolArgs): Promise<ToolResult> {
    const url = requireString(args, 'url', this.name);
    const newTab = optionalBoolean(args, 'newTab') ?? optionalBoolean(args, 'new_tab');
    const session = optionalString(args, '_session');
    const groupTitle = optionalString(args, 'group_title');

    if (newTab) {
      const tab = await chrome.tabs.create({ url, active: true });
      if (!tab.id) throw new Error('navigate: created tab has no id.');
      rememberTargetTab(tab.id);
      if (session) await groupTab(tab.id, session, groupTitle);
      await attachToTab(tab.id);
      await waitForLoad(tab.id);
      return { success: true, url, tabId: tab.id };
    }

    let tab = await getTargetTab();
    if (!tab.id || tab.url?.startsWith('chrome://') || tab.url?.startsWith('edge://')) {
      tab = await chrome.tabs.create({ url, active: true });
      if (!tab.id) throw new Error('navigate: created tab has no id.');
      rememberTargetTab(tab.id);
      await waitForLoad(tab.id);
      return { success: true, url, tabId: tab.id };
    }

    await attachToTab(tab.id);
    rememberTargetTab(tab.id);

    const sameUrl = tab.url === url || tab.url === `${url}/`;
    let frameId: string | undefined;

    if (sameUrl) {
      await sendCdp('Page.reload', { ignoreCache: true });
    } else {
      const result = await sendCdp<{ frameId?: string }>('Page.navigate', { url });
      frameId = result.frameId;
    }

    await waitForLoad(tab.id);
    return { success: true, url, tabId: tab.id, frameId };
  }
}

/** find_tab 工具：查找匹配 URL 的已打开标签页并附加 debugger */
class FindTabTool implements Tool {
  name = 'find_tab';

  async execute(args: ToolArgs): Promise<ToolResult> {
    const url = requireString(args, 'url', this.name);
    const pattern = patternFromUrl(url);
    const session = optionalString(args, '_session');
    const preferActive = optionalBoolean(args, 'active');

    let tab: chrome.tabs.Tab | undefined;
    if (preferActive) {
      const focusedWindow = await chrome.windows.getLastFocused({
        populate: true,
        windowTypes: ['normal']
      });
      tab = focusedWindow.tabs?.find((candidate) => candidate.active && sameHost(candidate.url, pattern));
    }

    tab ||= (await chrome.tabs.query({ url: pattern }))[0];

    if (!tab?.id) {
      throw new Error(`find_tab: no open tab found matching ${url}`);
    }

    if (session) await groupTab(tab.id, session);
    await attachToTab(tab.id);
    rememberTargetTab(tab.id);
    return { success: true, url: tab.url ?? url, tabId: tab.id };
  }
}

/** evaluate 工具：在当前标签页中执行 JavaScript 表达式并返回结果 */
class EvaluateTool implements Tool {
  name = 'evaluate';

  async execute(args: ToolArgs): Promise<ToolResult> {
    const code = requireString(args, 'code', this.name);
    await attachCurrentTab();

    const result = await sendCdp<CdpObject>('Runtime.evaluate', {
      expression: code,
      returnByValue: true,
      awaitPromise: true
    });

    if (result.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
      throw new Error(`evaluate: ${description}`);
    }

    return { type: result.result?.type, value: result.result?.value };
  }
}

/** network 工具：网络请求抓包，支持 start/stop/list/detail 子命令 */
class NetworkTool implements Tool {
  name = 'network';

  async execute(args: ToolArgs): Promise<ToolResult> {
    const cmd = requireString(args, 'cmd', this.name);
    switch (cmd) {
      case 'start':
        return this.start();
      case 'stop':
        return this.stop();
      case 'list':
        return this.list(optionalString(args, 'filter'));
      case 'detail':
        return this.detail(requireString(args, 'requestId', this.name));
      default:
        throw new Error(`network: unknown cmd "${cmd}"`);
    }
  }

  private async start(): Promise<ToolResult> {
    const tab = await attachCurrentTab();
    if (!tab.id) throw new Error('network: active tab has no id.');

    networkEnabledTabs.add(tab.id);
    networkRequests.set(tab.id, new Map());
    await sendCdp('Network.enable');

    if (!networkListenerInstalled) {
      chrome.debugger.onEvent.addListener((source, method, params) => {
        const tabId = source.tabId;
        if (!tabId || !networkEnabledTabs.has(tabId)) return;
        const eventParams = params as CdpObject | undefined;
        if (!eventParams?.requestId) return;

        const requests = networkRequests.get(tabId) ?? new Map<string, CdpObject>();
        networkRequests.set(tabId, requests);

        if (method === 'Network.requestWillBeSent') {
          requests.set(eventParams.requestId, {
            requestId: eventParams.requestId,
            url: eventParams.request?.url,
            method: eventParams.request?.method,
            timestamp: eventParams.timestamp
          });
        }

        if (method === 'Network.responseReceived') {
          const request = requests.get(eventParams.requestId);
          if (request) {
            request.status = eventParams.response?.status;
            request.mimeType = eventParams.response?.mimeType;
          }
        }

        if (method === 'Network.loadingFinished') {
          const request = requests.get(eventParams.requestId);
          if (request) {
            request.completed = true;
          }
        }
      });
      networkListenerInstalled = true;
    }

    return { success: true, message: 'network capture started' };
  }

  private async stop(): Promise<ToolResult> {
    const tabId = getActiveAttachedTabId();
    if (tabId !== null) {
      networkEnabledTabs.delete(tabId);
      await sendCdp('Network.disable');
    }
    return { success: true, message: 'network capture stopped' };
  }

  private list(filter?: string): ToolResult {
    const tabId = getActiveAttachedTabId();
    const requests = [...(tabId === null ? [] : networkRequests.get(tabId)?.values() ?? [])];
    const filtered = filter ? requests.filter((request) => String(request.url).includes(filter)) : requests;

    return {
      count: filtered.length,
      requests: filtered.map((request) => ({
        requestId: request.requestId,
        url: request.url,
        method: request.method,
        status: request.status,
        mimeType: request.mimeType,
        completed: request.completed ?? false
      }))
    };
  }

  private async detail(requestId: string): Promise<ToolResult> {
    const tabId = getActiveAttachedTabId();
    const request = tabId === null ? undefined : networkRequests.get(tabId)?.get(requestId);
    if (!request) {
      throw new Error(`network: request "${requestId}" not found`);
    }

    const body = await sendCdp<CdpObject>('Network.getResponseBody', { requestId });
    let parsedBody: unknown = body.body;
    if (!body.base64Encoded) {
      try {
        parsedBody = JSON.parse(String(body.body));
      } catch {
        parsedBody = body.body;
      }
    }

    return {
      requestId: request.requestId,
      url: request.url,
      method: request.method,
      status: request.status,
      mimeType: request.mimeType,
      base64Encoded: body.base64Encoded,
      body: parsedBody
    };
  }
}

/** snapshot 工具：获取页面的无障碍树快照，为交互式元素生成 ref 引用 */
class SnapshotTool implements Tool {
  name = 'snapshot';

  async execute(): Promise<ToolResult> {
    const tab = await attachCurrentTab();
    resetRefs();

    const result = await sendCdp<{ nodes: AxNode[] }>('Accessibility.getFullAXTree');
    return {
      url: tab.url,
      title: tab.title,
      tree: this.buildTree(result.nodes)
    };
  }

  private buildTree(nodes: AxNode[]): unknown[] {
    const nodesById = new Map(nodes.map((node) => [node.nodeId, node]));
    const root = nodes[0];
    if (!root) return [];
    return this.formatChildren(root, nodesById);
  }

  private formatChildren(node: AxNode, nodesById: Map<string, AxNode>): unknown[] {
    const children: unknown[] = [];

    for (const childId of node.childIds ?? []) {
      const child = nodesById.get(childId);
      if (!child) continue;
      const formatted = this.formatNode(child, nodesById);
      if (Array.isArray(formatted)) {
        children.push(...formatted);
      } else if (formatted) {
        children.push(formatted);
      }
    }

    return children;
  }

  private formatNode(node: AxNode, nodesById: Map<string, AxNode>): unknown {
    const role = node.role?.value;

    if (!role || role === 'none' || role === 'generic') {
      const children = this.formatChildren(node, nodesById);
      if (children.length === 0) return null;
      return children.length === 1 ? children[0] : children;
    }

    const item: Record<string, unknown> = { role };
    if (node.name?.value) item.name = node.name.value;
    if (node.value?.value) item.value = node.value.value;
    if (node.description?.value) item.description = node.description.value;
    if (interestingRoles.has(role) && node.backendDOMNodeId !== undefined) {
      item.ref = addRef(node.backendDOMNodeId, role, node.name?.value ?? '');
    }

    const children = this.formatChildren(node, nodesById);
    if (children.length > 0) item.children = children;
    return item;
  }
}

/** click 工具：点击指定元素（支持 CSS 选择器或 ref 引用） */
class ClickTool implements Tool {
  name = 'click';

  async execute(args: ToolArgs): Promise<ToolResult> {
    const selector = requireString(args, 'selector', this.name);
    await attachCurrentTab();

    if (isRef(selector)) {
      const objectId = await objectIdFromRef(selector, this.name);
      const result = await sendCdp<CdpObject>('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function() {
          this.scrollIntoView({ block: 'center', inline: 'center' });
          this.click();
          return { success: true, tag: this.tagName, text: (this.textContent || '').slice(0, 100) };
        }`,
        returnByValue: true
      });
      if (result.exceptionDetails) throw new Error(`click: ${result.exceptionDetails.text}`);
      return result.result?.value ?? { success: true };
    }

    const expression = `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return { error: 'element not found: ${selector}' };
      element.scrollIntoView({ block: 'center', inline: 'center' });
      element.click();
      return { success: true, tag: element.tagName, text: (element.textContent || '').slice(0, 100) };
    })()`;

    const result = await sendCdp<CdpObject>('Runtime.evaluate', {
      expression,
      returnByValue: true
    });

    if (result.exceptionDetails) throw new Error(`click: ${result.exceptionDetails.text}`);
    if (result.result?.value?.error) throw new Error(result.result.value.error);
    return result.result?.value ?? { success: true };
  }
}

/** fill 工具：在输入框中填充值并触发 input/change 事件 */
class FillTool implements Tool {
  name = 'fill';

  async execute(args: ToolArgs): Promise<ToolResult> {
    const selector = requireString(args, 'selector', this.name);
    const value = args.value;
    if (value === undefined || value === null) {
      throw new Error('fill: value is required');
    }

    await attachCurrentTab();
    const objectId = await objectIdForSelectorOrRef(selector, this.name);
    const result = await sendCdp<CdpObject>('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function() {
        const value = ${JSON.stringify(String(value))};
        this.scrollIntoView({ block: 'center', inline: 'center' });
        if ('value' in this) {
          this.value = value;
        } else {
          this.textContent = value;
        }
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true, tag: this.tagName };
      }`,
      returnByValue: true
    });

    if (result.exceptionDetails) throw new Error(`fill: ${result.exceptionDetails.text}`);
    return result.result?.value ?? { success: true };
  }
}

/** mouse_click 工具：模拟鼠标在元素中心位置的点击（通过 CDP Input 事件） */
class MouseClickTool implements Tool {
  name = 'mouse_click';

  async execute(args: ToolArgs): Promise<ToolResult> {
    const selector = requireString(args, 'selector', this.name);
    await attachCurrentTab();

    const objectId = await objectIdForSelectorOrRef(selector, this.name);
    await sendCdp('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function() { this.scrollIntoView({ block: 'center', inline: 'center' }); }`
    });

    const box = await sendCdp<CdpObject>('DOM.getBoxModel', { objectId });
    const content = box.model?.content as number[] | undefined;
    if (!content || content.length < 8) {
      throw new Error('mouse_click: element has no layout box');
    }

    const x = (content[0] + content[2] + content[4] + content[6]) / 4;
    const y = (content[1] + content[3] + content[5] + content[7]) / 4;

    await sendCdp('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'none',
      buttons: 0
    });
    await sendCdp('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1
    });
    await sendCdp('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      buttons: 0,
      clickCount: 1
    });

    return { success: true, x: Math.round(x), y: Math.round(y) };
  }
}

/** cdp 工具：直接发送任意 CDP 命令到当前标签页 */
class CdpTool implements Tool {
  name = 'cdp';

  async execute(args: ToolArgs): Promise<ToolResult> {
    const method = requireString(args, 'method', this.name);
    const params = args.params && typeof args.params === 'object' ? (args.params as Record<string, unknown>) : {};
    await attachCurrentTab();
    return sendCdp(method, params);
  }
}

/** key_type 工具：通过 CDP Input.insertText 直接插入文本 */
class KeyTypeTool implements Tool {
  name = 'key_type';

  async execute(args: ToolArgs): Promise<ToolResult> {
    const text = requireString(args, 'text', this.name);
    await attachCurrentTab();
    await sendCdp('Input.insertText', { text });
    return { success: true, length: text.length };
  }
}

/** 按键规格：键名、代码、虚拟键码和可选的文本 */
type KeySpec = {
  key: string;
  code: string;
  vkc: number;
  text?: string;
};

/** 修饰键规格：位掩码、键名、代码和虚拟键码 */
const modifierSpecs = {
  alt: { bit: 1, key: 'Alt', code: 'AltLeft', vkc: 18 },
  ctrl: { bit: 2, key: 'Control', code: 'ControlLeft', vkc: 17 },
  control: { bit: 2, key: 'Control', code: 'ControlLeft', vkc: 17 },
  cmd: { bit: 4, key: 'Meta', code: 'MetaLeft', vkc: 91 },
  meta: { bit: 4, key: 'Meta', code: 'MetaLeft', vkc: 91 },
  shift: { bit: 8, key: 'Shift', code: 'ShiftLeft', vkc: 16 }
} as const;

/** 特殊按键名到 KeySpec 的映射表 */
const keySpecs: Record<string, KeySpec> = {
  enter: { key: 'Enter', code: 'Enter', vkc: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', vkc: 13, text: '\r' },
  escape: { key: 'Escape', code: 'Escape', vkc: 27 },
  esc: { key: 'Escape', code: 'Escape', vkc: 27 },
  tab: { key: 'Tab', code: 'Tab', vkc: 9 },
  backspace: { key: 'Backspace', code: 'Backspace', vkc: 8 },
  delete: { key: 'Delete', code: 'Delete', vkc: 46 },
  space: { key: ' ', code: 'Space', vkc: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', vkc: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vkc: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vkc: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', vkc: 39 },
  home: { key: 'Home', code: 'Home', vkc: 36 },
  end: { key: 'End', code: 'End', vkc: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', vkc: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', vkc: 34 }
};

/** 将按键字符串解析为 KeySpec，支持特殊键、F 键、字母和数字 */
function parseKey(raw: string): KeySpec {
  const key = raw.toLowerCase();
  if (keySpecs[key]) return keySpecs[key];

  const functionKey = key.match(/^f(\d{1,2})$/);
  if (functionKey) {
    const index = Number(functionKey[1]);
    if (index >= 1 && index <= 12) {
      return { key: `F${index}`, code: `F${index}`, vkc: 111 + index };
    }
  }

  if (/^[a-zA-Z]$/.test(raw)) {
    const upper = raw.toUpperCase();
    return { key: raw.toLowerCase(), code: `Key${upper}`, vkc: upper.charCodeAt(0), text: raw.toLowerCase() };
  }

  if (/^[0-9]$/.test(raw)) {
    return { key: raw, code: `Digit${raw}`, vkc: raw.charCodeAt(0), text: raw };
  }

  throw new Error(`send_keys: unknown key "${raw}"`);
}

/** send_keys 工具：发送组合键（如 Ctrl+Enter），支持修饰键和重复次数 */
class SendKeysTool implements Tool {
  name = 'send_keys';

  async execute(args: ToolArgs): Promise<ToolResult> {
    const keys = requireString(args, 'keys', this.name);
    const repeat = optionalNumber(args, 'repeat') ?? 1;
    if (!Number.isInteger(repeat) || repeat < 1 || repeat > 100) {
      throw new Error('send_keys: repeat must be an integer in [1, 100]');
    }

    await attachCurrentTab();
    const platform = await chrome.runtime.getPlatformInfo();
    const mod = platform.os === 'mac' ? modifierSpecs.cmd : modifierSpecs.ctrl;
    const segments = keys.trim().split(/\s+/);
    let dispatched = 0;

    for (let index = 0; index < repeat; index++) {
      for (const segment of segments) {
        const pieces = segment.split('+').map((piece) => piece.trim()).filter(Boolean);
        const key = parseKey(pieces.at(-1) ?? '');
        const modifiers = pieces.slice(0, -1).map((piece) => {
          const normalized = piece.toLowerCase();
          if (normalized === 'mod') return mod;
          const modifier = modifierSpecs[normalized as keyof typeof modifierSpecs];
          if (!modifier) throw new Error(`send_keys: "${piece}" is not a modifier`);
          return modifier;
        });

        let modifierBits = 0;
        for (const modifier of modifiers) {
          modifierBits |= modifier.bit;
          await sendCdp('Input.dispatchKeyEvent', {
            type: 'keyDown',
            modifiers: modifierBits,
            key: modifier.key,
            code: modifier.code,
            windowsVirtualKeyCode: modifier.vkc
          });
        }

        const eventPayload: Record<string, unknown> = {
          type: 'keyDown',
          modifiers: modifierBits,
          key: key.key,
          code: key.code,
          windowsVirtualKeyCode: key.vkc
        };
        if (key.text && modifierBits === 0) {
          eventPayload.text = key.text;
        }

        await sendCdp('Input.dispatchKeyEvent', eventPayload);
        await sendCdp('Input.dispatchKeyEvent', {
          type: 'keyUp',
          modifiers: modifierBits,
          key: key.key,
          code: key.code,
          windowsVirtualKeyCode: key.vkc
        });

        for (const modifier of modifiers.reverse()) {
          modifierBits &= ~modifier.bit;
          await sendCdp('Input.dispatchKeyEvent', {
            type: 'keyUp',
            modifiers: modifierBits,
            key: modifier.key,
            code: modifier.code,
            windowsVirtualKeyCode: modifier.vkc
          });
        }

        dispatched++;
      }
    }

    return { success: true, dispatched, os: platform.os };
  }
}

/** screenshot 工具：截取页面或指定元素的截图（PNG/JPEG） */
class ScreenshotTool implements Tool {
  name = 'screenshot';

  async execute(args: ToolArgs): Promise<ToolResult> {
    await attachCurrentTab();
    const format = optionalString(args, 'format') === 'jpeg' ? 'jpeg' : 'png';
    const selector = optionalString(args, 'selector');
    const options: Record<string, unknown> = { format };

    if (format === 'jpeg') {
      options.quality = optionalNumber(args, 'quality') ?? 80;
    }

    if (selector) {
      const objectId = await objectIdForSelectorOrRef(selector, this.name);
      await sendCdp('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function() { this.scrollIntoView({ block: 'center', inline: 'center' }); }`
      });

      const box = await sendCdp<CdpObject>('DOM.getBoxModel', { objectId });
      const border = box.model?.border as number[] | undefined;
      if (!border || border.length < 8) {
        throw new Error('screenshot: element has no layout box');
      }

      const xs = [border[0], border[2], border[4], border[6]];
      const ys = [border[1], border[3], border[5], border[7]];
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      const width = Math.max(...xs) - x;
      const height = Math.max(...ys) - y;

      options.clip = { x, y, width, height, scale: 1 };
    }

    const result = await sendCdp<{ data: string }>('Page.captureScreenshot', options);
    return { format, dataLength: result.data.length, data: result.data };
  }
}

/** 纸张尺寸映射表（宽 × 高，单位英寸） */
const paperSizes: Record<string, [number, number]> = {
  letter: [8.5, 11],
  legal: [8.5, 14],
  a4: [8.27, 11.69],
  a3: [11.69, 16.54],
  tabloid: [11, 17]
};

/** save_as_pdf 工具：将当前页面导出为 PDF */
class SaveAsPdfTool implements Tool {
  name = 'save_as_pdf';

  async execute(args: ToolArgs): Promise<ToolResult> {
    await attachCurrentTab();
    const [paperWidth, paperHeight] = paperSizes[(optionalString(args, 'paper_format') ?? 'letter').toLowerCase()] ?? paperSizes.letter;
    const scale = optionalNumber(args, 'scale') ?? 1;
    if (scale < 0.1 || scale > 2) {
      throw new Error(`save_as_pdf: scale must be in [0.1, 2.0], got ${scale}`);
    }

    const result = await sendCdp<{ data: string }>('Page.printToPDF', {
      printBackground: optionalBoolean(args, 'print_background') !== false,
      landscape: optionalBoolean(args, 'landscape') ?? false,
      scale,
      paperWidth,
      paperHeight,
      preferCSSPageSize: true
    });

    const title = await sendCdp<CdpObject>('Runtime.evaluate', {
      expression: 'document.title',
      returnByValue: true
    });

    return {
      data: result.data,
      mimeType: 'application/pdf',
      dataLength: result.data.length,
      pageTitle: title.result?.value ?? '',
      requestedFileName: optionalString(args, 'file_name') ?? ''
    };
  }
}

/** upload 工具：向文件输入元素设置本地文件路径 */
class UploadTool implements Tool {
  name = 'upload';

  async execute(args: ToolArgs): Promise<ToolResult> {
    const selector = requireString(args, 'selector', this.name);
    const files = args.files;
    if (!Array.isArray(files) || files.length === 0 || files.some((file) => typeof file !== 'string')) {
      throw new Error('upload: files is required as an array of local paths');
    }

    await attachCurrentTab();
    const document = await sendCdp<CdpObject>('DOM.getDocument');
    const query = await sendCdp<CdpObject>('DOM.querySelector', {
      nodeId: document.root.nodeId,
      selector
    });

    if (!query.nodeId) {
      throw new Error(`upload: element not found: ${selector}`);
    }

    await sendCdp('DOM.setFileInputFiles', {
      nodeId: query.nodeId,
      files
    });

    return { success: true, selector, fileCount: files.length, files };
  }
}

/** close_tab 工具：关闭指定标签页 */
class CloseTabTool implements Tool {
  name = 'close_tab';

  async execute(args: ToolArgs): Promise<ToolResult> {
    const tabId = args._tabId;
    if (typeof tabId !== 'number') {
      return { success: true, closed: false, reason: 'session has no tab' };
    }

    try {
      await chrome.tabs.remove(tabId);
      return { success: true, closed: true };
    } catch {
      return { success: true, closed: false, reason: 'tab already closed' };
    }
  }
}

/** list_tabs 工具：列出指定标签页的信息（URL、标题、分组等） */
class ListTabsTool implements Tool {
  name = 'list_tabs';

  async execute(args: ToolArgs): Promise<ToolResult> {
    const tabIds = Array.isArray(args._tabIds) && args._tabIds.length > 0
      ? args._tabIds
      : typeof args._tabId === 'number'
        ? [args._tabId]
        : [];

    const tabs: Record<string, unknown>[] = [];
    for (const tabId of tabIds) {
      try {
        const tab = await chrome.tabs.get(tabId);
        let groupTitle = '';
        if (typeof tab.groupId === 'number' && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
          try {
            groupTitle = (await chrome.tabGroups.get(tab.groupId)).title ?? '';
          } catch {
            groupTitle = '';
          }
        }

        tabs.push({
          tabId: tab.id,
          url: tab.url ?? '',
          title: tab.title ?? '',
          active: tab.active ?? false,
          groupTitle
        });
      } catch {
        // Ignore tabs that were closed between the daemon request and execution.
      }
    }

    return { success: true, tabs };
  }
}

/** close_session 工具：关闭会话关联的所有标签页 */
class CloseSessionTool implements Tool {
  name = 'close_session';

  async execute(args: ToolArgs): Promise<ToolResult> {
    const tabIds = Array.isArray(args._tabIds) && args._tabIds.length > 0
      ? args._tabIds
      : typeof args._tabId === 'number'
        ? [args._tabId]
        : [];

    let closed = 0;
    for (const tabId of tabIds) {
      try {
        await chrome.tabs.remove(tabId);
        closed++;
      } catch {
        // Already closed.
      }
    }

    return { success: true, closed };
  }
}
