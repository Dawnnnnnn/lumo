---
name: extension-provider
description: Chrome 扩展间 MCP 服务（extension provider）的完整实现与运维指南：L0 探测协议 + L1 标准 MCP over chrome.runtime.Port。用于在 Lumo 中接入/排查第三方扩展能力，或在任一 WXT / Chrome MV3 扩展中实现可被 Agent 调用的 MCP 端点（probe、allowlist、Port transport、tools/list、写操作审计与限流）。Triggers on "extension provider", "扩展服务", "插件扩展服务", "lumo:probe", "lumo:mcp", "onMessageExternal", "onConnectExternal", "MCP over runtime port".
---

# Extension Provider — 扩展间 MCP 服务

> 适用仓库：
> **Host（客户端）** = 本仓库 `lumo`；**Provider（服务端）** = `../lumo-userscript-manager`。
> 本文用「宿主」指 Lumo，「提供方」指任何暴露 MCP 的已安装扩展。

## 1. 一句话模型

一个已安装的 Chrome 扩展，只要满足三件事，就成为 Lumo 的「扩展服务」：

1. manifest 声明 `externally_connectable`；
2. 用 **一条自定义消息**（L0 probe）回答「我是谁 / 是否开启 / 是否授权 / 是否就绪」；
3. 用 **标准 MCP**（L1）在名为 `lumo:mcp` 的 `chrome.runtime.Port` 上提供 `tools/list` 与 `tools/call`。

宿主不需要为每个新提供方写代码：把提供方的 32 位扩展 ID 填进设置，即可发现并挂载其工具。

```
┌───────────────── Lumo（宿主 / MCP client） ──────────────────┐
│ side panel · options · background                            │
│   每个 trusted context 各持一份 McpRegistry 与会话            │
│   McpRegistry → ExtensionMcpServer(id=ext:<extId>)            │
│              → @ai-sdk/mcp createMCPClient                    │
└──────────┬───────────────────────────────────────────────────┘
   L0 probe│ chrome.runtime.sendMessage(extId, {channel:'lumo:probe'})
   L1 MCP  │ chrome.runtime.connect(extId, {name:'lumo:mcp'})
┌──────────▼──────────────── Provider（任一扩展） ──────────────┐
│ background SW                                                │
│   onMessageExternal  → handleProbe（含 allowlist / 审批记录）  │
│   onConnectExternal  → 校验 sender.id → ChromePortTransport    │
│                      → @modelcontextprotocol/sdk McpServer    │
└──────────────────────────────────────────────────────────────┘
```

## 2. 为什么分成 L0 + L1

单独用 MCP `initialize` 无法表达「已安装但被关闭 / 未授权 / 未就绪」：握手失败只能得到一句错误，
宿主也就无法把用户导向正确的动作（去开启、去授权、去看原因），而 MCP 也拒绝在握手完成前交换能力。

因此：

- **L0 是唯一自定义消息**，无状态、可随时呼叫、只回元数据（`service` + `status`）；
- **L1 完全标准**，JSON-RPC 由 SDK 负责，本仓库 `lib/mcp/extension-protocol.ts`
  里没有任何 JSON-RPC 或工具定义。

这条分层是硬约束：**不要**往 L0 里塞工具列表、业务数据或自定义指令。

## 3. 文件地图

### 宿主侧（本仓库）

| 文件 | 职责 |
| --- | --- |
| `lib/mcp/extension-protocol.ts` | L0 常量、`ProbeRequest/ProbeResponse`、`isProbeResponse()`、`isExtensionId()` |
| `lib/mcp/extension-probe.ts` | 发送 probe、1500ms 超时、区分「不可达」与「业务失败」 |
| `lib/mcp/transports/chrome-port.ts` | 宿主侧 `MCPTransport` 实现（预启动缓冲、`isClosed`、`onDisconnect`） |
| `lib/mcp/extension-server.ts` | `ExtensionMcpServer`：状态机、错误文案、工具命名空间、懒重连 |
| `lib/mcp/extension-registry.ts` | 注册 / 按设置同步 / 焦点重试 / 手动 refresh |
| `lib/mcp/settings.ts` | `normalizeMcpSettings()`、`normalizeExtensionProviders()`、默认值 |
| `lib/mcp/registry.ts` | 全局工具合并、重名 first-wins、结果归一化 |
| `lib/mcp/index.ts` | `initBuiltinMcpServers()` 中挂载、storage 变更同步 |
| `store/storage-schema.ts` / `store/storage.ts` | `mcpSettings` 持久化，写入前 normalize |
| `entrypoints/options/McpSettings.tsx` | 「Extensions」分区：添加/启停/刷新/移除/工具展开 |
| `entrypoints/sidepanel/main.tsx` | 面板获得焦点时重试（5s 节流），覆盖「去别处审批再回来」 |
| `entrypoints/background.ts` | 后台上下文同样初始化（工具执行在哪个上下文，就需要哪里的会话） |
| `tests/extension-server.test.ts` | 状态机 / 重连 / 命名空间 / 失败文案 |
| `tests/extension-provider.test.ts` | 设置规范化 / 响应守卫 / ID 校验 |

### 提供方侧（`../lumo-userscript-manager`）

| 文件 | 职责 |
| --- | --- |
| `lib/agent/protocol.ts` | 同一份 L0 契约的镜像 + `isProbeRequest()` 入参守卫 |
| `lib/agent/probe.ts` | probe 处理：版本、策略、可用性、审批记录 |
| `lib/agent/policy.ts` | `resolveAgentAccess(senderId)`，enabled 与 authorized 分离 |
| `lib/agent/pending.ts` | 审批队列、冷却、自动打开设置页、approve/dismiss |
| `lib/agent/transport.ts` | 提供方侧 `Transport`（SDK 接口），授权检查期间的入站缓冲 |
| `lib/agent/mcp-server.ts` | 每个 Port 建一个 `McpServer`，注册工具面 |
| `lib/agent/tools.ts` | 工具面、读写门禁、按策略注册 |
| `lib/agent/audit.ts` | 审计（参数只存哈希） |
| `lib/agent/rate-limit.ts` | 写操作滑动窗口 30 次/60s |
| `entrypoints/background.ts` | `onMessageExternal` / `onConnectExternal` 同步注册 |
| `store/storage-schema.ts` | `agentSettings`、`agentPendingRequests`（均不导出） |
| `entrypoints/options/SettingsPage.tsx` | `#/settings/agent`：开关、允许列表、审批卡片、活动日志 |
| `tests/agent.test.ts` | probe 矩阵、Port 往返、写门禁、审计 |

## 4. 不可违反的不变量

1. **端口名固定为 `lumo:mcp`**，probe 频道固定为 `lumo:probe`，probe 版本为 `1`。
2. **`isExtensionId()` 是唯一 ID 判据**：`/^[a-p]{32}$/`。任何来源（UI、storage、导入）都必须过这一关。
3. **probe 必须在未授权时也回 `ok:true`**，把拒绝写进 `status`；只有协议本身失败（版本、内部异常）才 `ok:false`。
   否则宿主无法区分「没装」「关了」「没授权」。
4. **授权只认 `sender.id`**，绝不信任 `client.name` / `service.name`（自报值，仅用于展示）。
5. **L1 之前必须同时满足 `enabled && authorized`**；`ready` 只是能力可用性。
6. **提供方在每次工具调用时重新校验策略**；会话可长于设置，写入开关关掉后必须立刻失败。
7. **Port 关闭 ≠ 服务消失**。MV3 的 service worker 空闲会被回收，宿主必须保留逻辑会话与缓存工具，下一次调用懒重连。
8. **重连必须重新 `initialize`**：提供方为每个 Port 新建 `McpServer`，不要使用 `initialInitializeResult`。
9. **工具名必须带命名空间**，宿主侧形如 `<namespace>_<tool>`；冲突 first-wins，不静默覆盖。
10. **L0 只回元数据**，工具与业务数据只在授权后的 L1 交换；日志与审计里不得出现脚本源码。

## 5. 状态矩阵（probe → 宿主行为）

宿主 `ExtensionMcpServer.doConnect()` 按此顺序判定，文案即用户可见错误：

| probe 返回 | 宿主状态 | 用户看到 |
| --- | --- | --- |
| `sendMessage` 拒绝（`Receiving end does not exist` / `Could not establish connection`） | `error` | Extension is not installed, or it does not expose an agent endpoint. |
| 超时 1500ms / 其他异常 | `error` | 原始错误信息 |
| `ok:false`（如 `UNSUPPORTED_PROTOCOL`） | `error` | `error.message` |
| 缺 `service` 或 `status` | `error` | Probe response is missing service or status. |
| `status.enabled === false` | `error` | Agent access is turned off in `<name>`. |
| `!authorized && pendingApproval` | `error` | `<name>` is waiting for you to approve this extension. Open its settings, allow `<lumoId>`, then reconnect. |
| `!authorized` | `error` | `<name>` does not allow this extension. Add `<lumoId>` to its allowed extension IDs. |
| `!ready` | `error` | `status.reason.message` ?? `<name>` is not ready. |
| 全部通过 | `connecting → connected` | 工具列表出现（卡片上显示数量） |

`McpServerStatus` 只有四态：`connected | connecting | disconnected | error`。

## 6. 能力边界（当前实现）

- **只支持 tools**：`listTools` / `callTool`。未消费 `resources`、`prompts`、`sampling`、`elicitation`。
- **模型可见面只有工具名、`description` 与 `inputSchema`**：工具描述是唯一的语义通道，必须自解释。
- **`annotations` 未消费**：`readOnlyHint` 等只是元数据；宿主不做权限判断，门禁在提供方。
- **`structuredContent` 会随 JSON 文本一起回传**，但宿主模型侧走 `normalizeToCallToolResult` + `mcpToModelOutput`。
- **上限**：单提供方最多 `MAX_TOOLS = 1024` 个工具；namespace ≤16 字符；tool ≤40 字符；
  合计 ≤57 字符（低于 OpenAI function name 的 64 字符上限，**不要放宽**）。
- **保留命名空间**：`browser` `page` `file` `network` `devtools` `webmcp` `ext`；命中则回退为 `ext_<id 前 8 位>`。
- **不支持的 MCP 特性必须优雅降级**：提供方只注册 tools，客户端只调用 tools。

## 7. 任务路由

| 你要做的事 | 读这里 |
| --- | --- |
| 对齐 wire 格式、字段语义、错误码、版本演进 | [`references/protocol.md`](references/protocol.md) |
| 改宿主：设置、注册表、状态机、命名空间、UI | [`references/host-integration.md`](references/host-integration.md) |
| 写提供方：manifest、probe、transport、tools、审批、审计 | [`references/provider-integration.md`](references/provider-integration.md) |
| 新增/接入一个服务、加工具、写测试、手工联调 | [`references/development.md`](references/development.md) |
| 排查「连不上 / 工具消失 / 授权反复弹」 | [`references/troubleshooting.md`](references/troubleshooting.md) |
| 从零起一个最小提供方 | [`templates/provider-skeleton.md`](templates/provider-skeleton.md) |

## 8. 最短接通路径

**宿主（用户视角）**：设置 → MCP → Extensions → 添加扩展 → 粘贴 32 位 ID → 卡片出现。
宿主自身 ID 在同一分区可一键复制（`options.mcp.extensions.copyId`），审批时要用。

**提供方（开发者视角）**：

1. `wxt.config.ts` 加 `externally_connectable: { ids: ['*'] }`（`*` 必需：宿主的未打包 ID 每次安装都变）；
2. `background.ts` 顶层同步注册 `onMessageExternal`（probe）与 `onConnectExternal`（Port）；
3. 写一个带缓冲的 Port → MCP `Transport`；
4. 用官方 SDK 建 `McpServer` 并注册工具；
5. 存一份 `agentSettings`（enabled / allowlist / allowWrites / reviewWrites）并在每次调用时复核。

完整代码见 `templates/provider-skeleton.md`。

## 9. 提交前自检

- [ ] 新常量/频道名没有第二处字面量（都从 `extension-protocol.ts` 引用）。
- [ ] 新增 storage 字段同时更新 `DEFAULT_*` 与 `normalize*`，并考虑旧数据缺字段。
- [ ] 新增错误文案走 i18n（`options.mcp.extensions.*`），且不写「请点击」式指导语。
- [ ] 新增工具名符合 `<namespace>_<snake_case>`，未侵占保留命名空间。
- [ ] Port 断开、宿主重启、提供方重新加载三种情况下都能自愈。
- [ ] 单测覆盖：命名空间、懒重连、未授权/未开启/未就绪三条拒绝路径、设置规范化。
- [ ] 新增文件为 `.md`（本目录下的 `.ts` 会被 `tsc --noEmit` 纳入编译；见 `references/development.md`）。
