# 协议契约（L0 probe + L1 MCP over Port）

本文是 wire 级参考。两个仓库的 `protocol.ts` 必须逐字一致（除注释与提供方额外的
`isProbeRequest`）。任何一侧新增字段，另一侧都必须**向后兼容**。

## 1. 常量

| 名称 | 值 | 说明 |
| --- | --- | --- |
| `PROBE_CHANNEL` | `lumo:probe` | 只读探测，固定 `channel` |
| `AUTHORIZE_CHANNEL` | `lumo:authorize` | 授权请求，唯一有副作用的 L0 消息 |
| `PROBE_VERSION` | `1` | 两条消息共用同一版本号，整数 |
| `MCP_PORT_NAME` | `lumo:mcp` | L1 Port 名，大小写敏感 |
| 扩展 ID | `/^[a-p]{32}$/` | Chromium 扩展 ID 字符集与长度 |

宿主：`lib/mcp/extension-protocol.ts`；提供方：`lib/agent/protocol.ts`。

**为什么是两个消息，而不是一个带标志位的**：探测必须可以随便重复（启动、每次设置写入、
每次焦点重试、甚至扫描用户还没添加的扩展），所以它不能有任何副作用；授权必须登记并
可能打开窗口，所以它只能由用户的显式动作触发。把两者塞进一条消息，就必然出现
「这次探测要不要弹窗」这种历史相关的分支——那正是旧协议的病根。

## 2. L0

### 2.1 传输

```
chrome.runtime.sendMessage(providerExtensionId, { channel, version, id?, client? })
```

- 只能从**扩展上下文**（side panel / options / background）发起，不能从 content script 发起。
- 提供方必须用 `chrome.runtime.onMessageExternal` 接收；两条消息共用一个监听器，按
  `isProbeRequest` / `isAuthorizeRequest` 分派。
- 提供方若未声明 `externally_connectable`，或该版本还没有 `lumo:authorize` 监听器，
  调用会以 `Could not establish connection. Receiving end does not exist.` 拒绝——
  宿主把它翻译成「未安装 / 该版本不支持」，而非让用户处理异常。

### 2.2 请求

```ts
interface ProbeRequest {
  channel: 'lumo:probe';
  version: number;              // 当前为 1
  id?: string;                  // 诊断用请求 id（宿主传 randomUUID）
  client?: { id: string; name: string; version: string }; // 宿主自报身份
}

interface AuthorizeRequest {
  channel: 'lumo:authorize';
  version: number;
  id?: string;
  client?: { id: string; name: string; version: string }; // 审批卡片上显示是谁在请求
}
```

`client` 是**展示提示**，不是身份。提供方的授权判断只能使用
`chrome.runtime.MessageSender.id`。

### 2.3 响应（两条消息同一个形状）

```ts
interface ProbeResponse {
  ok: boolean;                  // 协议层是否成功，不是「是否授权」
  service?: { namespace: string; name: string; version: string };
  status?: {
    enabled: boolean;           // 提供方的总开关
    authorized: boolean;        // 调用方是否在 allowlist
    ready: boolean;             // 目标能力（chrome.userScripts 等）是否可用
    reason?: { code: string; message: string }; // ready=false 的人话原因
  };
  error?: { code: string; message: string };     // ok=false 时
}
```

语义约束：

| 字段 | 规则 |
| --- | --- |
| `ok` | 只有**协议**失败才为 `false`（版本不支持、内部异常）。业务拒绝一律 `ok:true` + `status` |
| `service` | 版本不匹配时也应返回，让宿主能显示「这是谁」 |
| `status.enabled` | 智能体总开关。`false` **仍然必须可被探测到**（`ok:true`）：批准动作就是把它打开，藏起来会让第一步无从发生 |
| `status.authorized` | `sender.id ∈ allowlist`；**不要**因为 `client.id` 相同就放行 |
| `status.ready` | 与能力相关（如 `chrome.userScripts` 可用性）；`false` 必须给 `reason.message` |
| `error.code=REQUESTS_DISABLED` | 用户关掉了「扩展请求访问时打开设置」。这是**唯一**允许 `ok:false` 的业务拒绝：它表达「本扩展不参与宿主集成」，宿主据此连发现都不展示它 |

没有 `pendingApproval`：宿主不需要知道审批队列的内部状态。它在卡片上显示
「需要授权 + 授权按钮」，批准与否下次探测自然会反映在 `authorized` 里。

### 2.4 提供方判定顺序

**`handleProbe`（只读，不能有副作用）**

1. `isProbeRequest(message)` 不通过 → 监听器返回 `false`（不占用通道，不回复）。
2. `request.version !== PROBE_VERSION` → `{ ok:false, service, error:{code:'UNSUPPORTED_PROTOCOL'} }`。
3. 读取 `agentSettings`；`promptOnRequest === false` → `{ ok:false, error:{code:'REQUESTS_DISABLED'} }`
   （这个开关是「是否参与宿主集成」的总闸，不是提示偏好）。
4. 由 `sender.id` 计算 `authorized`。
5. 计算 `ready`（如 `checkUserScriptsAvailable()`）。
6. 返回 `ok:true` + `service` + `status`。**不登记、不提示、不开页。**

**`handleAuthorize`（唯一允许有副作用的 L0）**

1. 同样先校验 channel 与 version。
2. `promptOnRequest === false` → `{ ok:false, error:{code:'REQUESTS_DISABLED'} }`，不登记、不弹窗。
3. 读 `agentSettings`；已授权 → 直接回 `authorized:true`，什么都不做。
4. 未授权 → `recordPendingRequest(senderId, client)` 后 `promptForRequest(pending)`。
   **不要 await 这条链路**：它写存储、开标签页，而宿主在等这条回复；
   慢提示不该让调用看起来"没回应"。
5. 返回与 probe 同形状的响应（通常是 `authorized:false`）——审批发生在被打开的界面里。

**这条路径没有冷却**。`lumo:authorize` 只由宿主卡片上的显式按钮发出，用户点一次就必须
看得见一次反应；按 24h/10s 限流会表现成"点了没反应"。重复请求会复用同一行记录，
并清掉之前的 `dismissedAt`（重新可批准）。

### 2.5 宿主判定顺序

`probeExtension()` / `authorizeExtension()`（`lib/mcp/extension-probe.ts`）共用一条发送路径：

1. 组请求；`client.id = chrome.runtime.id`，`client.version = manifest.version`。
2. `Promise.race` 式 2000ms 超时（`PROBE_TIMEOUT_MS`）。冷启动的 MV3 service worker
   是唯一慢的来源，留出余量；超时按 `error` 呈现，不静默。
3. `isProbeResponse()` 守卫：非对象 / `ok` 非布尔 → 「malformed response」。
4. 捕获异常并分类：消息匹配
   `/Receiving end does not exist|Could not establish connection/i` → `unreachable: true`。

`ExtensionMcpServer` 的判定顺序见 SKILL.md §5。

### 2.6 时序

```
host                                     provider
 │ sendMessage(lumo:probe)                 │  version → 集成开关 → policy → ready（只读）
 │<────────────────────────────────────────│ { ok, service, status }
 │ status.authorized = false               │
 │ 卡片进入 unauthorized + 「授权」按钮      │
 │                                         │
 │ （用户点「授权」）                        │
 │ sendMessage(lumo:authorize)             │
 │────────────────────────────────────────>│ recordPendingRequest
 │                                         │ promptForRequest → 打开设置页
 │<────────────────────────────────────────│ { ok, service, status: authorized:false }
 │                                         │ 用户在提供方界面点「允许并启用」
 │ （用户回到宿主，焦点重试）                 │
 │ sendMessage(lumo:probe)                 │
 │────────────────────────────────────────>│ authorized:true
 │<────────────────────────────────────────│
 │ connect(extId, lumo:mcp)                │
 │────────────────────────────────────────>│ onConnectExternal
 │                                         │ resolveAgentAccess(sender.id)
 │                                         │ ├─ 拒绝 → transport.close()
 │                                         │ └─ 通过 → new McpServer(...).connect(transport)
 │ initialize (JSON-RPC)                   │
 │────────────────────────────────────────>│
 │<────────────────────────────────────────│
 │  tools/list                             │
```

## 3. L1 — MCP over `chrome.runtime.Port`

### 3.1 帧格式

**裸 JSON-RPC 对象**，没有信封、没有 base64、没有额外字段：

```ts
port.postMessage(jsonRpcMessage);   // 发送
port.onMessage.addListener(fn);     // 接收
```

不要包成 `{type:'mcp', payload}`——那会破坏 SDK 的 `JSONRPCMessage` 类型与错误处理。

### 3.2 双方职责

| | 宿主（client） | 提供方（server） |
| --- | --- | --- |
| SDK | `@ai-sdk/mcp` `createMCPClient` | `@modelcontextprotocol/sdk` `McpServer` |
| Transport 接口 | `MCPTransport`（含 `protocolVersion?` / `setProtocolVersion?`） | SDK `Transport`（无版本字段） |
| 会话 | 一个 `ExtensionMcpServer` 一个逻辑会话 | **每个 Port 新建一个 `McpServer`** |
| 协商 | SDK 发起 `initialize` | SDK 应答 |
| 工具 | `listTools()` → 包装成 AI SDK tool | `registerTool()` |

两个 SDK 必须保持 MCP spec 兼容。升级任一侧时，必须用真实客户端跑一次
`initialize / tools/list / tools/call`（见 `references/development.md`）。

### 3.3 缓冲（两侧都要）

客户端 `createMCPClient` 的调用顺序是「先挂 `onmessage`，再 `start()`」，
服务端在授权检查期间也不能丢消息。所以两侧 transport 都实现：

```ts
private active = false;
private pending: JSONRPCMessage[] = [];

private handleMessage = (message: unknown) => {
  if (this.closed) return;
  if (!this.active) { this.pending.push(message as JSONRPCMessage); return; }
  this.onmessage?.(message as JSONRPCMessage);
};

async start() {
  this.active = true;
  const queued = this.pending;
  this.pending = [];
  for (const m of queued) this.onmessage?.(m);
}
```

没有这段缓冲，`initialize` 响应可能在客户端完成注册前到达，表现为「连接成功但没有工具」。

### 3.4 `onclose` 的归属（宿主侧陷阱）

`createMCPClient()` 会**覆盖** `transport.onclose`（指向它自己的 `onClose`）。
所以：

```ts
const transport = ChromePortTransport.connect(id);
transport.onclose = () => { this.needsReconnect = true; };  // 会被覆盖
const client = await createMCPClient({ transport, ... });

const sdkOnClose = transport.onclose;                        // 链式保留
transport.onclose = () => { sdkOnClose?.(); this.needsReconnect = true; };
```

`ChromePortTransport` 因此额外暴露 `onDisconnect?`（语义是「物理端口断开」），
但当前实现仍以 `transport.isClosed` 作为存活判据：`ensureConnected()` 在
`needsReconnect || transport.isClosed` 时重连。**改这里必须保留三层判据**，
否则会出现「客户端以为还连着、工具调用直接失败」。

### 3.5 关闭语义

| 事件 | 含义 | 宿主反应 | 提供方反应 |
| --- | --- | --- | --- |
| `port.disconnect()`（主动） | 正常关闭 | `disconnect()`：清空工具缓存 | `onclose` → `server.close()` |
| 提供方 SW 空闲回收 | 物理断开，服务仍在 | 标记 `needsReconnect`，**保留**缓存工具 | 无（进程已回收） |
| 提供方被卸载/禁用 | 逻辑消失 | 下次调用 `probe` 失败 → `error` | — |
| 宿主关掉开关 | 用户意图 | `disconnect()` + 清空 | Port 收到断开 |

因此 `disconnect()` 与「端口掉了」是两种不同处理：
前者清空工具，后者必须保留（否则模型会在重连窗口里失去工具定义）。

### 3.6 重连为什么必须重新 `initialize`

提供方 `onConnectExternal` 对每个 Port 执行 `createAgentMcpServer(...)` 并 `connect(transport)`，
即**新会话、新 server 实例**。`initialInitializeResult` 只适用于「服务端会保留会话」的传输
（如 Streamable HTTP），在这里复用会拿到一个服务端不认识的 session。

重连流程（`ensureConnected()`）：

```
缓存工具保留
  → connect()
      → probe（校验策略仍允许）
      → 新 Port + 新 client + 新 initialize
      → tools/list 覆盖缓存
  → 执行原 tool call（用缓存的 local name）
```

### 3.7 多上下文与并发

宿主会在 **background / side panel / options** 各自初始化一次 registry，
因此同一个提供方可能同时看到 **多条 Port / 多个 MCP 会话**。

提供方必须保证：

- 每 Port 一个 `McpServer`，不共享 session 级状态；
- 模块级状态（限流桶、审计队列）可被多会话并发访问，仍需按 `sender.id` 聚合；
- 任何会话都不能因为另一个会话关闭而失效（不要在 `onclose` 里做全局清理）。

## 4. 版本演进

| 变更 | 做法 |
| --- | --- |
| 新增可选请求/响应字段 | 不改 `PROBE_VERSION`；双方守卫必须容忍未知字段 |
| 改变字段语义、删除字段、改变判定顺序 | `PROBE_VERSION + 1`；提供方回 `UNSUPPORTED_PROTOCOL` 并附 `service` |
| 新增 MCP 能力（resources 等） | 走 MCP 标准能力协商，不动 L0 |
| 拆分/重命名工具 | 提供方改名即视为新工具；宿主 `MAX_TOOLS` 与命名空间规则不变 |

宿主对 probe 响应只做 `isProbeResponse()`（`ok` 为布尔）这一层守卫，
不做 schema 全量校验——新增字段因此天然兼容；但**不要**依赖未校验字段做安全判断。
