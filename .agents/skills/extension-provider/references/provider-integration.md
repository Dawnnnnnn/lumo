# 提供方实现（以 `lumo-userscript-manager` 为参考）

面向「让一个扩展成为 extension provider」的读者。参考实现路径均在
`../lumo-userscript-manager`。

## 1. manifest 前提

```ts
// wxt.config.ts
manifest: {
  externally_connectable: { ids: ['*'] },
}
```

- 必须是 `"*"`：宿主的未打包 ID 每次加载都可能不同，无法预先列举。
- 这是**可达性**，不是授权。真正的授权在 `lib/agent/policy.ts`（`sender.id` + allowlist）。
- 不加这一项时，宿主的 `sendMessage` 会直接拒绝，用户看到「未安装或未暴露端点」。
- 提供方不需要任何额外 permission 就能收发 Port / `onMessageExternal`。

## 2. 后台接线（顺序很重要）

```ts
export default defineBackground(() => {
  // 同步注册：MV3 的事件监听器必须在顶层同步挂上，
  // 否则 SW 冷启动时事件可能已经派发完毕。
  chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
    if (!isProbeRequest(message)) return false;
    void handleProbe(message, sender).then(sendResponse, (error) =>
      sendResponse({ ok: false, error: { code: 'INTERNAL', message: String(error) } }),
    );
    return true;  // 异步响应
  });

  chrome.runtime.onConnectExternal.addListener((port) => {
    if (port.name !== MCP_PORT_NAME) return;
    const transport = new ChromePortTransport(port);
    void (async () => {
      const access = await resolveAgentAccess(port.sender?.id);
      if (!access.enabled || !access.authorized) {
        await transport.close();   // 未授权：立刻断开，不交换任何能力
        return;
      }
      const server = createAgentMcpServer(port.sender?.id, access.settings);
      transport.onclose = () => { void server.close().catch(() => undefined); };
      await server.connect(transport);
    })().catch((error) => {
      console.error('[Provider] MCP session failed:', error);
      void transport.close();
    });
  });
});
```

要点：

- `isProbeRequest()` 失败时返回 `false`（不 `sendResponse`），把通道让给别的监听器；
- `return true` 才能异步 `sendResponse`；
- **在授权检查完成前不要构造 `McpServer`**，也不要读脚本库；
- 授权检查是异步的（storage），所以 transport 必须先建好以接收并缓冲入站消息。

## 3. L0 处理（`lib/agent/probe.ts` + `lib/agent/authorize.ts`）

两条消息、两个函数，判定顺序见 `references/protocol.md` §2.4。

`probe.ts` —— **只读**，一个副作用都不能有：

```ts
if (request.version !== PROBE_VERSION) {
  return { ok: false, service, error: { code: 'UNSUPPORTED_PROTOCOL', message: ... } };
}
const settings = await storage.getAgentSettings();
// 总闸：`promptOnRequest` 决定本扩展是否参与宿主集成（可被发现 + 可被授权）。
if (!settings.promptOnRequest) {
  return { ok: false, service, error: { code: 'REQUESTS_DISABLED', message: '...' } };
}
const authorized = Boolean(sender.id && settings.allowedExtensionIds.includes(sender.id));
const availability = await checkUserScriptsAvailable();   // ready
return {
  ok: true, service,
  status: {
    enabled: settings.enabled,
    authorized,
    ready: availability.ok,
    ...(availability.ok ? {} : { reason: { code: 'USER_SCRIPTS_UNAVAILABLE', message: availability.error } }),
  },
};
```

`authorize.ts` —— 唯一的副作用入口：

```ts
const settings = await storage.getAgentSettings();
const authorized = Boolean(sender.id && settings.allowedExtensionIds.includes(sender.id));
if (!authorized) {
  // 不 await：写存储 + 开标签页，宿主正在等这条回复。
  void recordPendingRequest(sender.id, request.client).then((pending) => promptForRequest(pending));
}
return { ok: true, service, status: { enabled: settings.enabled, authorized, ready: availability.ok } };
```

**不要**再往 probe 里塞 `recordPendingRequest`。那会让回答依赖历史（"探测过一次了"），
并把回复挂在一条串行化的写队列上——一旦提示链路卡住，probe 就永远不回，
宿主侧表现为「装了但探测不到」。

## 4. 策略（`lib/agent/policy.ts`）

## 4. 策略（`lib/agent/policy.ts`）

```ts
export interface AgentAccess { settings: AgentSettings; enabled: boolean; authorized: boolean }

export async function resolveAgentAccess(senderId?: string): Promise<AgentAccess> {
  const settings = await storage.getAgentSettings();
  return { settings, enabled: settings.enabled, authorized: Boolean(senderId && settings.allowedExtensionIds.includes(senderId)) };
}
```

`AgentSettings`（`types/index.ts`）：

| 字段 | 默认 | 语义 |
| --- | --- | --- |
| `enabled` | `false` | 总开关。false 时拒绝一切会话与调用 |
| `allowedExtensionIds` | `[]` | allowlist，≤16 条，逐条校验 `/^[a-p]{32}$/` |
| `allowWrites` | `true` | 是否注册写工具 / 是否允许写调用 |
| `reviewWrites` | `false` | 新建脚本落盘即禁用 + `pendingReview` |
| `promptOnRequest` | `true` | **是否参与宿主集成**：关闭后不被发现、不弹窗（probe/authorize 都回 `REQUESTS_DISABLED`） |

`enabled` 与 `authorized` 必须**分开**：宿主要渲染「去开启」与「去授权」两个不同动作。

## 5. Transport（`lib/agent/transport.ts`）

实现 SDK 的 `Transport`：

```ts
class ChromePortTransport implements Transport {
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
  // start / send / close / handleMessage / handleDisconnect 见 protocol.md §3.3
}
```

- `send` 在已关闭时抛错（不要静默丢弃，SDK 需要感知失败）；
- `close` 先置 `closed`，再 `port.disconnect()`，最后 `onclose()`；
- `handleDisconnect` 也要 `onclose()`（对端关闭与主动关闭走同一出口）。

## 6. MCP server（`lib/agent/mcp-server.ts`）

```ts
export function createAgentMcpServer(senderId: string | undefined, settings: AgentSettings): McpServer {
  const server = new McpServer({
    name: 'lumo-userscripts',
    version: chrome.runtime.getManifest().version,
  });
  registerAgentTools(server, senderId, settings);
  return server;
}
```

- `name` 只用于 `initialize` 的 serverInfo，宿主工具命名空间来自 **probe 的 `service.namespace`**，
  两者不要混用。
- **每个 Port 新建一个 server**，不复用实例（Port 关闭即会话结束）。
- 工具注册时机由 `settings.allowWrites` 决定：关闭时不注册写工具，
  模型根本看不到这些能力（比「注册后拒绝」体验更好）。

## 7. 工具设计约定

### 7.1 返回结构

```ts
// 成功：JSON 文本 + structuredContent，便于模型与程序化客户端两用
function ok(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }],
           ...(isRecord(payload) ? { structuredContent: payload } : {}) };
}

// 业务失败：调用成功但 isError=true，让模型拿到可行动的 code
function failed(payload: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }],
           structuredContent: payload, isError: true };
}

// 协议/权限失败：纯文本 isError
function fail(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}
```

区分标准：

| 情况 | 用哪个 | 理由 |
| --- | --- | --- |
| 正常结果 | `ok` | 模型可解析 |
| `CONFLICT` / `NOT_FOUND` / `INVALID_CODE` / `RATE_LIMITED` | `failed` | 模型能据 `code` 自我修正 |
| 未开启 / 未授权 / 写被禁用 | `fail` | 模型不该尝试绕过 |
| transport 异常 | 让异常抛出 | JSON-RPC 层错误，不伪装成工具结果 |

### 7.2 描述与 schema

模型能看到的只有工具名、`description` 与 `inputSchema`，**`description` 必须自解释**：

- 说明「什么时候用」「返回什么」「有什么副作用」；
- 显式写出约束（`Each oldText must match exactly once`、`Permanent deletion is not available`）；
- `annotations`（`readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`）如实填写，
  它是给宿主与模型的语义提示，当前不参与鉴权；
- zod schema 保持扁平：避免 `$ref` 与深层递归，部分厂商会拒绝复杂 JSON Schema；
- 大文本参数要有硬上限并在描述里说明。

### 7.3 参考实现的工具面（`lib/agent/tools.ts`）

| 工具 | 类型 | 参数 | 行为 |
| --- | --- | --- | --- |
| `list` | read | `query?` `enabled?` `tag?` `url?` `includeRemoved?` `limit?`(1–200, 默认 100) | 紧凑索引行；`url` 过滤「此页会跑哪些脚本」 |
| `get` | read | `id?` `name?` `namespace?` `includeCode?` `codeOffset?` `codeLength?`(≤128KB) | 详情；代码默认 64KB 窗口 |
| `diagnostics` | read | `id?` | `chrome.userScripts` 可用性、注册数、错误脚本 |
| `set_enabled` | write | `ids[]`(1–50) `enabled` | 启用即视为完成评审 |
| `create` | write | `code`(≤5MB) `sourceUrl?` `enabled?` | 校验 metablock；review 开启时禁用 + `pendingReview` |
| `edit` | write | `id` `edits[{oldText,newText}]`(1–20) `expectedCodeHash?` | 锚点替换，整批原子；再校验 metablock |
| `update` | write | `id` `code?` `selfMetadata?` `expectedCodeHash?` | 整体替换；优先用 `edit` |
| `install` | write | `url` `enabled?` | 下载安装（含 `@require/@resource`）；name+namespace 相同则更新 |
| `delete` | write | `id` | 仅移入回收站，永久删除不对 Agent 开放 |

约定：

- `expectedCodeHash` 是实现级乐观锁，冲突回 `CONFLICT` + `currentCodeHash`；
- 错误码集合：`NOT_FOUND` `CONFLICT` `INVALID_INPUT` `INVALID_CODE` `EDIT_FAILED` `RATE_LIMITED`；
- 写工具只在 `allowWrites` 时注册，但**每次调用仍要复核**（见 §8）。

## 8. 写操作门禁、限流、审计

```ts
async function guardedWrite(senderId, tool, args, run) {
  const target: { uuid?: string } = {};
  const access = await requireAccess(senderId, true);   // ← 每次调用重新读设置
  if (!consumeWrite(senderId)) { /* 审计 + RATE_LIMITED */ }
  try {
    const response = await run(target, access);          // run 拿到实时 access
    await recordAgentAudit({ tool, senderId, args, targetUuid: target.uuid,
                             result: response.isError ? 'error' : 'ok', message: ... });
    return response;
  } catch (error) { /* 审计 + fail */ }
}
```

- `requireAccess()` 抛错 → `fail(...)`，即 `enabled` / `authorized` / `allowWrites`
  三项在**每次调用**都生效，用户关掉开关后下一次调用立刻失败；
- 副作用：会话中途关掉 `allowWrites` 时，工具**仍留在宿主的缓存工具表**里（宿主不会主动刷新），
  调用会以 `Writing is disabled in ...` 失败。这是可接受的：失败比静默成功安全。

限流（`lib/agent/rate-limit.ts`）：

```ts
export const WRITE_WINDOW_MS = 60_000;
export const WRITE_LIMIT = 30;
```

- 按 `senderId` 分桶，模块级共享（同一提供方的多条会话共用额度）；
- 只限写操作；读操作不限；
- 拒绝时回 `{ code:'RATE_LIMITED' }`，模型可等待重试。

审计（`lib/agent/audit.ts` + `lib/db/index.ts`）：

- 字段：`time / tool / senderId / argsHash / targetUuid? / result / message?`；
- 参数只存 **SHA-256**，因为写调用会携带完整脚本源码；
- 单条 `message` 截断 500 字符；
- 保留策略 `pruneAgentAudit(30 天, 1000 条)`；写审计失败被吞掉，不能把成功写操作变成错误。

## 9. 审批体验（`lib/agent/pending.ts`）

```
lumo:authorize 且未授权
  → recordPendingRequest(senderId, client)
       · 无 senderId 或非法 ID → 忽略
       · 已授权 → 忽略
       · 复用同 ID 记录，更新 lastSeen / name / version
       · 队列上限 5，最新在前
       · 已 dismiss → 直接清除 dismissedAt（显式请求重新可批准）
  → promptForRequest(pending)
       · promptOnRequest=false → 直接返回（且 probe 已经拒绝过，正常走不到这里）
       · **没有冷却**：显式授权一次就弹一次；重复请求复用同一行并清掉 dismissedAt
       · 写 promptedAt 供页面内审批弹窗判断"刚刚被请求"（PROMPT_FRESH_MS = 60s）
       · 打开 options.html#/settings/agent（单例：已开则聚焦/导航）
```

`approvePendingRequest(id)`：**同时**置 `enabled:true` 并加入 allowlist，然后从队列移除
（「允许并启用」是一个动作，不是两个开关）。
`dismissPendingRequest(id)`：只打 `dismissedAt`，不动策略。

队列与策略都存在 `chrome.storage.local`，且 `exportable: false`——这是**运行时同意状态**，
不能随备份导出到另一台机器。

## 10. 并发与幂等

- 每个 Port 一个 `McpServer`，不共享 session；
- 限流桶、审计写入、pending 队列是模块级/存储级共享状态，必须幂等；
- `pending.ts` 用 `chain` promise 串行化「读-改-写」，避免两个宿主同时授权时丢记录；
- 不要在 `transport.onclose` 里清理全局状态（另一个会话仍在用）。

## 11. 最小骨架

见 [`../templates/provider-skeleton.md`](../templates/provider-skeleton.md)：
manifest 片段 + protocol + transport + probe + server + 一个示例工具。
