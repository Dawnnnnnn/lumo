# 最小提供方骨架

从零实现一个可被 Lumo 发现并调用的 extension provider。这是**最小可用集合**，
真实项目请按 `references/provider-integration.md` 补齐策略、审批、审计、限流。

> 只作为文档保存为 `.md`：两个仓库的 `tsc` 会编译 `../**/*.ts`。

## 1. manifest

```ts
// wxt.config.ts
export default defineConfig({
  manifest: {
    // 必需：宿主的未打包 ID 每次都可能不同，无法预先列举。
    externally_connectable: { ids: ['*'] },
  },
});
```

## 2. 协议常量与守卫

```ts
// lib/agent/protocol.ts
export const PROBE_CHANNEL = 'lumo:probe' as const;
export const AUTHORIZE_CHANNEL = 'lumo:authorize' as const;
export const PROBE_VERSION = 1;
export const MCP_PORT_NAME = 'lumo:mcp';
export const AGENT_NAMESPACE = 'myservice';   // → 工具名前缀 myservice_
export const AGENT_SERVICE_NAME = 'My Service';

export interface ProbeRequest {
  channel: typeof PROBE_CHANNEL;
  version: number;
  id?: string;
  client?: { id: string; name: string; version: string };
}

export interface ProbeResponse {
  ok: boolean;
  service?: { namespace: string; name: string; version: string };
  status?: {
    enabled: boolean;
    authorized: boolean;
    ready: boolean;
    reason?: { code: string; message: string };
  };
  error?: { code: string; message: string };
}

// 两条 L0 消息形状相同，只有 channel 不同：一个只读，一个登记并弹窗。
export interface AuthorizeRequest extends Omit<ProbeRequest, 'channel'> {
  channel: typeof AUTHORIZE_CHANNEL;
}

export function isProbeRequest(value: unknown): value is ProbeRequest {
  if (!value || typeof value !== 'object') return false;
  const data = value as Record<string, unknown>;
  return data.channel === PROBE_CHANNEL && typeof data.version === 'number';
}

export function isAuthorizeRequest(value: unknown): value is AuthorizeRequest {
  if (!value || typeof value !== 'object') return false;
  const data = value as Record<string, unknown>;
  return data.channel === AUTHORIZE_CHANNEL && typeof data.version === 'number';
}

export function isExtensionId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-p]{32}$/.test(value);
}
```

## 3. Transport（带授权期间缓冲）

```ts
// lib/agent/transport.ts
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

export class ChromePortTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private active = false;
  private closed = false;
  private pending: JSONRPCMessage[] = [];

  constructor(private readonly port: chrome.runtime.Port) {
    port.onMessage.addListener(this.handleMessage);
    port.onDisconnect.addListener(this.handleDisconnect);
  }

  async start(): Promise<void> {
    this.active = true;
    const queued = this.pending;
    this.pending = [];
    for (const message of queued) this.onmessage?.(message);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) throw new Error('The agent port is closed.');
    try {
      this.port.postMessage(message);
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.port.disconnect();
    } catch {
      // 已断开。
    }
    this.onclose?.();
  }

  private handleMessage = (message: unknown): void => {
    if (this.closed) return;
    if (!this.active) {
      this.pending.push(message as JSONRPCMessage);
      return;
    }
    this.onmessage?.(message as JSONRPCMessage);
  };

  private handleDisconnect = (): void => {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  };
}
```

## 4. Probe（只读）与 Authorize（唯一有副作用）

```ts
// lib/agent/probe.ts
import { AGENT_NAMESPACE, AGENT_SERVICE_NAME, PROBE_VERSION, type ProbeRequest, type ProbeResponse } from './protocol';
import { storage } from '@/store/storage';

export async function handleProbe(
  request: ProbeRequest,
  sender: chrome.runtime.MessageSender,
): Promise<ProbeResponse> {
  const service = {
    namespace: AGENT_NAMESPACE,
    name: AGENT_SERVICE_NAME,
    version: chrome.runtime.getManifest().version,
  };

  // 1. 版本优先：旧宿主不该看到「请授权」。
  if (request.version !== PROBE_VERSION) {
    return {
      ok: false,
      service,
      error: { code: 'UNSUPPORTED_PROTOCOL', message: `Unsupported probe version ${request.version}.` },
    };
  }

  // 2. 策略：只信 sender.id。
  const settings = await storage.getAgentSettings();
  const authorized = Boolean(sender.id && settings.allowedExtensionIds.includes(sender.id));

  // 3. 就绪：这里换成你自己的能力检查。
  const ready = true;

  // 4. 业务拒绝也是 ok:true。
  //    这里**不要**登记待审批、不要开页面：probe 会被宿主反复调用（启动 /
  //    设置写入 / 焦点重试 / 目录扫描），一旦有副作用就会变成「探测过一次
  //    就再也不回」。
  return {
    ok: true,
    service,
    status: {
      enabled: settings.enabled,
      authorized,
      ready,
      ...(ready ? {} : { reason: { code: 'NOT_READY', message: 'Service is not ready.' } }),
    },
  };
}
```

```ts
// lib/agent/authorize.ts —— 用户点了宿主的「授权」，这里才是该弹窗的地方
export async function handleAuthorize(
  request: AuthorizeRequest,
  sender: chrome.runtime.MessageSender,
): Promise<ProbeResponse> {
  const service = { namespace: AGENT_NAMESPACE, name: AGENT_SERVICE_NAME, version: chrome.runtime.getManifest().version };
  if (request.version !== PROBE_VERSION) {
    return { ok: false, service, error: { code: 'UNSUPPORTED_PROTOCOL', message: '...' } };
  }

  const settings = await storage.getAgentSettings();
  const authorized = Boolean(sender.id && settings.allowedExtensionIds.includes(sender.id));

  if (!authorized) {
    // 不 await：写存储 + 开标签页，宿主正在等这条回复。
    void recordPendingRequest(sender.id, request.client).then((pending) => promptForRequest(pending));
  }

  return { ok: true, service, status: { enabled: settings.enabled, authorized, ready: true } };
}
```

## 5. 后台接线

```ts
// entrypoints/background.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { handleProbe } from '@/lib/agent/probe';
import { handleAuthorize } from '@/lib/agent/authorize';
import { isAuthorizeRequest, isProbeRequest, MCP_PORT_NAME } from '@/lib/agent/protocol';
import { ChromePortTransport } from '@/lib/agent/transport';
import { storage } from '@/store/storage';

function createServer(senderId: string | undefined): McpServer {
  const server = new McpServer({ name: 'my-service', version: chrome.runtime.getManifest().version });

  server.registerTool(
    'ping',
    {
      title: 'Ping the service',
      annotations: { readOnlyHint: true, idempotentHint: true },
      // 模型只读工具名、描述与 schema；描述必须自解释。
      description: 'Returns the extension version and the caller ID. Use it to verify connectivity.',
      inputSchema: {},
    },
    async () => ({
      content: [{ type: 'text', text: JSON.stringify({ ok: true, caller: senderId ?? null }) }],
      structuredContent: { ok: true, caller: senderId ?? null },
    }),
  );

  return server;
}

export default defineBackground(() => {
  // 必须同步注册；两条 L0 消息共用一个监听器。
  chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
    const handler = isProbeRequest(message)
      ? handleProbe(message, sender)
      : isAuthorizeRequest(message)
        ? handleAuthorize(message, sender)
        : null;
    if (!handler) return false;

    void handler.then(sendResponse, (error) =>
      sendResponse({ ok: false, error: { code: 'INTERNAL', message: String(error) } }),
    );
    return true;
  });

  chrome.runtime.onConnectExternal.addListener((port) => {
    if (port.name !== MCP_PORT_NAME) return;
    const transport = new ChromePortTransport(port);
    void (async () => {
      // 每次建会话都重新校验；未授权直接断开，不交换任何能力。
      const settings = await storage.getAgentSettings();
      const authorized = Boolean(port.sender?.id && settings.allowedExtensionIds.includes(port.sender.id));
      if (!settings.enabled || !authorized) {
        await transport.close();
        return;
      }
      const server = createServer(port.sender?.id);
      transport.onclose = () => { void server.close().catch(() => undefined); };
      await server.connect(transport);
    })().catch(() => void transport.close());
  });
});
```

## 6. 接上宿主

1. 构建 → Load unpacked → 复制扩展 ID；
2. Lumo → 设置 → MCP → Extensions → Add extension（内置目录命中时直接点那一行）；
3. 卡片显示「需要授权」→ 点「授权」→ 提供方弹出审批卡片 →「允许并启用」；
4. 回侧栏（焦点重试自动连上），卡片应变 `connected`，工具出现 `myservice_ping`；
5. 在对话里调用，验证返回。

## 7. 之后必须补的

- [ ] 审批队列 + 自动开设置页（`references/provider-integration.md` §9）
- [ ] 写工具门禁 / 限流 / 审计（§8）
- [ ] `allowWrites` 关闭时不注册写工具
- [ ] 每次调用复核策略（`requireAccess`）
- [ ] 单测：probe 矩阵 + Port 往返 + 未授权端口关闭
- [ ] i18n 中英文案（设置页）
