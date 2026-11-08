# 宿主侧实现（Lumo）

面向「修改 Lumo 的 extension provider 支持」的读者。所有路径相对本仓库根目录。

## 1. 数据模型

```ts
// lib/mcp/types.ts
export interface McpExtensionProviderConfig {
  id: string;        // 32 位扩展 ID
  enabled: boolean;
  label?: string;    // 用户覆盖；默认用提供方自报的 service.name
}

export interface McpSettings {
  servers: McpExternalServerConfig[];      // HTTP / SSE / WebMCP
  disabledBuiltins: string[];
  webmcpEnabled: boolean;
  extensionProviders: McpExtensionProviderConfig[];  // 新增
}
```

`McpTransportType` 新增了 `'extension'`，这是宿主区分「扩展服务」与「外部 HTTP MCP」的唯一标记：

- `lib/mcp/index.ts` 的 `syncExternalServers()` 显式跳过 `info.transport === 'extension'`；
- `entrypoints/options/McpSettings.tsx` 的列表过滤同样用这个字段。

> 不要用 `builtin` 或 id 前缀来区分，`builtin` 已被内置服务器占用，id 前缀是展示约定。

## 2. 规范化（settings）

`lib/mcp/settings.ts`：

```ts
export const DEFAULT_MCP_SETTINGS: McpSettings = {
  servers: [], disabledBuiltins: [], webmcpEnabled: false, extensionProviders: [],
};
```

`normalizeExtensionProviders(value)` 的规则（每条都有理由，改动需同步测试）：

| 规则 | 理由 |
| --- | --- |
| 非数组 → `[]` | 旧版本记录没有该字段 |
| ID 必须匹配 `/^[a-p]{32}$/` | 手改/导入的脏值会变成永远连不上的条目 |
| 去重（保留首个） | 同一扩展不能开两个会话、抢同一个命名空间 |
| `enabled` 缺省为 `true`，只有显式 `false` 才关 | 新增条目立即生效 |
| `label` trim 后为空则不存 | 避免空字符串盖掉自报名 |
| `slice(0, 16)` | 记录有界，UI 不会无限增长 |

`normalizeMcpSettings(raw)` 额外做两件事：

1. 剔除已迁移的历史字段 `injectInstructions`（现在归属系统提示设置），
   否则它会被带进导入导出；
2. 逐个字段兜底类型（`servers` / `disabledBuiltins` / `webmcpEnabled`）。

**写入路径也要 normalize**：`store/storage.ts` 的 `setMcpSettings()` 调
`STORAGE_FIELDS.mcpSettings.normalize`，`store/storage-schema.ts` 的字段定义同样挂
`normalize`。这样 UI、扩展消息、导入三条路径共用一套修复逻辑。

## 3. 注册表生命周期

`lib/mcp/extension-registry.ts` 持有 `Map<extensionId, ExtensionMcpServer>`，
registry id 固定为 **`ext:<extensionId>`**。

```
initBuiltinMcpServers()                 // 每个 trusted context 各一次
  ├─ 注册内置 server
  ├─ initExternalMcpServers()
  ├─ initExtensionProviders(settings)   // 只注册，不连接
  └─ mcpRegistry.connectAll()           // 统一连接（内部 probe）
        ↳ setupMcpStorageSync()
              └─ chrome.storage.onChanged: mcpSettings
                    ├─ syncExternalServers()
                    ├─ syncWebMcpServer()
                    └─ syncExtensionProviders()
```

| 函数 | 触发 | 行为 |
| --- | --- | --- |
| `initExtensionProviders(settings)` | 上下文启动 | 已存在则跳过；只 `register()`，连接交给 `connectAll()` |
| `syncExtensionProviders(settings)` | 设置变化 | 移除多余项（`unregister` 内部会 `disconnect`）；新增项注册并在 `enabled` 时连接；已存在项 `updateConfig()`，按 `enabled` 升降序连接/断开 |
| `retryExtensionProviders()` | side panel `focus` / `visibilitychange`（5s 节流） | 只重试「enabled 且状态不是 connected/connecting」的提供方 |
| `refreshExtensionProvider(id)` | 设置卡片刷新按钮 | `disconnect()` → `connect()` → `notifyChange()` |
| `getExtensionProvider(id)` | 内部/调试 | 返回实例（未从 `lib/mcp/index.ts` 导出） |

关键点：

- `syncExtensionProviders()` **只在成员变化或 enabled 翻转时**做重活。
  切换无关的 MCP 偏好（例如指令注入）不能触发全体重新 probe。
- 新增条目的 `enabled` 为 `true` 时直接 `connect()`，不等待下一次 `connectAll()`。
- 移除条目时先 `servers.delete()` 再 `mcpRegistry.unregister()`，
  避免 `unregister` 的异步 `disconnect` 期间又被同步逻辑找回。

### 为什么要在 side panel 上做焦点重试

审批发生在**提供方自己的设置页**。用户切走再切回侧栏时，宿主会话仍停在 `error`，
没有焦点重试就会要求用户手动点「重新连接」，违反「无需解释即可使用」。
节流的 5s 是为了避免焦点/可见性抖动造成 probe 风暴。

## 4. `ExtensionMcpServer`

文件：`lib/mcp/extension-server.ts`。它实现 `IMcpServer`，把「一个已安装扩展」
伪装成和内置/HTTP 服务器同构的 MCP server。

### 4.1 字段

| 字段 | 含义 |
| --- | --- |
| `status` | `disconnected / connecting / connected / error` |
| `descriptor` | probe 拿到的 `service`（namespace/name/version） |
| `client` / `transport` | 当前 MCP 会话；断开后置空 |
| `toolDefinitions` / `aiTools` | 对外工具面（本地名 → AI SDK tool） |
| `needsReconnect` | 物理端口已死、逻辑会话保留 |
| `connecting` | 并发 `connect()` 去重 |
| `config` | `McpExtensionProviderConfig` 的实时副本 |

### 4.2 `getInfo()`

```ts
{
  id: `ext:${config.id}`,
  name: config.label || descriptor?.name || `Extension ${config.id.slice(0, 8)}`,
  description: descriptor ? `${name} ${version} · extension provider`
                          : 'Extension provider over the runtime MCP transport',
  transport: 'extension',
  builtin: false,
  enabled: config.enabled,
  icon: 'puzzle',
}
```

名称优先级：用户覆盖 > 自报 `service.name` > ID 前 8 位。probe 之前也能稳定渲染。

### 4.3 `connect()` 状态机

```
enabled === false            → status = disconnected（不 probe）
已有 connecting Promise      → 复用（去重）
doConnect():                    // lumo:probe，只读，永不弹窗
  status = connecting
  probe 失败                 → fail(...) → status = error
  !authorized                → status = unauthorized + 「授权」按钮（不是 error）
  status 校验（见 SKILL §5）  → fail(...) → status = error
  closeSession()             // 先关旧会话
  新 Port transport
  createMCPClient({ transport, clientName:'lumo', version, onUncaughtError })
  链式 onclose
  listTools() → 生成 definitions/tools
  needsReconnect = false
  status = connected

authorize():                    // lumo:authorize，唯一会弹窗的调用
  status = authorizing
  sendMessage(extId, lumo:authorize)   // 提供方登记 + 打开审批卡片
  authorized ? openSession() : status = unauthorized
```

`connect()` 与 `authorize()` 之外的任何路径（启动、设置写入、焦点重试、懒重连）都只能发
`lumo:probe`。这条约束就是「用户没点授权，就不会被弹走」的实现。

失败时**不清空** `toolDefinitions/aiTools`：`error` 状态下 `getAITools()` 本就不会被
`mcpRegistry` 收集，但缓存能让「同类错误修复后重连」更快，也让 UI 仍能显示上次的工具数。
`disconnect()`（用户显式关闭/移除）才清空。

### 4.4 工具映射

```ts
const prefix = sanitizeNamespace(service.namespace, config.id);
const exposed = `${prefix}_${sanitizeToolName(definition.name)}`;
```

`sanitizeNamespace()`：

- 小写、非 `[a-z0-9]` → `_`、去首尾 `_`、截断 16；
- 必须以字母开头、非空、不在保留集合
  `browser | page | file | network | devtools | webmcp | ext`；
- 不满足 → `ext_<id 前 8 位>`。

`sanitizeToolName()`：小写、非 `[a-z0-9_]` → `_`、去首尾、截断 40，空则 `tool`。

于是：

| 提供方 `service.namespace` | 工具 `list` | 结果 |
| --- | --- | --- |
| `userscripts` | `list` | `userscripts_list` |
| `Page Tools!` | `Find Element` | `page_tools_find_element` |
| `page`（保留） | `click` | `ext_<8位>_click` |
| `""` | `x` | `ext_<8位>_x` |

单提供方 `listed.tools` 先 `slice(0, MAX_TOOLS)`（64），再对**暴露名**去重
（同名后者丢弃），避免提供方工具名规范化后自撞。

工具对象：

```ts
tool({
  description: definition.description ?? '',
  inputSchema: jsonSchema(inputSchema),
  execute: async (args) => this.callTool(localName, args ?? {}),
})
```

注意 `execute` 用的是**提供方的本地名**（`definition.name`），不是暴露名。

`inputSchema` 缺失时兜底 `{ type:'object', properties:{} }`。
**不要**在宿主侧改写 schema（例如把 `$ref` 展开）：SDK 与各家模型对 JSON Schema
的接受度不同，宿主只做透传，schema 质量由提供方负责。

### 4.5 `callTool` / `ensureConnected`

```ts
private async callTool(name, args) {
  await this.ensureConnected();
  if (!this.client) throw new Error('The extension provider is not connected.');
  return this.client.callTool({ name, arguments: args });
}

private async ensureConnected() {
  if (this.client && !this.needsReconnect && !this.transport?.isClosed) return;
  await this.connect();
  if (!this.client || this.needsReconnect || this.transport?.isClosed) {
    throw new Error(this.error ?? 'Could not reconnect to the extension provider.');
  }
}
```

三层判据（`needsReconnect` / `transport.isClosed` / `client` 是否存在）缺一不可：
SDK 客户端可能仍持有对象，而物理 Port 已关闭。

`onUncaughtError` 只记一条 `console.warn` 并置 `needsReconnect`，不把状态改成 `error`：
传输层抖动不应让工具面在 UI 上闪断。

## 5. 全局工具合并

`lib/mcp/registry.ts#getAllAITools()`：

```ts
const owners = new Map<string, string>();
for (const server of this.getAllServers()) {
  if (server.getStatus() !== 'connected' || !server.getInfo().enabled) continue;
  for (const [name, t] of Object.entries(server.getAITools(context))) {
    if (owners.has(name)) {
      console.warn(`[MCP] Tool "${name}" from ${owner} collides with ${previous}; keeping the first registration.`);
      continue;
    }
    owners.set(name, owner);
    allTools[name] = wrapToolExecute(t);
  }
}
```

- 冲突策略：**first-wins**（先注册者胜），并打警告。顺序 = `register()` 顺序：
  内置 → 外部 HTTP → WebMCP → 扩展服务。
- `wrapToolExecute()` 把结果归一化为 `CallToolResult`，并补 `toModelOutput`。
  托管工具已经自带 `toModelOutput` 时不再覆盖。
- 工具上下文 `McpToolExecutionContext` 当前只带 `conversationId`；
  `ExtensionMcpServer.getAITools()` 忽略它（扩展工具不依赖会话上下文）。

## 6. UI（`entrypoints/options/McpSettings.tsx`）

结构：

```
MCP 设置页
├─ Built-in servers
├─ External servers (HTTP / SSE)
├─ Extensions          ← 本功能
│   ├─ 「本扩展」ID + 复制按钮
│   ├─ Add extension（AnimatePresence 高度展开）
│   └─ ExtensionProviderCard × N（折叠）
│        ├─ 名称（label > service.name > id8）
│        ├─ 徽标 options.mcp.extensions.badge
│        ├─ StatusBadge / 关闭态
│        ├─ 工具数
│        ├─ Switch（enabled）
│        ├─ 刷新（refreshExtensionProvider）
│        ├─ 移除（行内二次确认）
│        └─ 展开：ServerExpandedContent（工具列表 + 错误）
└─ WebMCP
```

数据流：

- `useMcpPreferences()` 读整个 `mcpSettings`，并订阅 `chrome.storage.onChanged`
  以同步另一个标签页/侧栏的改动；
- 写操作统一 `storage.setMcpSettings({...current, ...patch})`（内部会 normalize）；
- `useInitMcpServers()` 负责 `initBuiltinMcpServers()` 与 `mcpRegistry.subscribe`；
- 卡片状态来自 `states.find(s => s.info.id === \`ext:${config.id}\`)`，
  若 registry 尚未注册则用 `config` 构造 fallback state（避免一帧空白）。

添加表单用 `isExtensionId()` 校验，错误文案 `options.mcp.extensions.invalidId`；
重复 ID 在 `addExtension()` 里静默忽略（已存在即无操作）。

i18n 键（`i18n/en.ts`、`i18n/zh.ts`）：

```
options.mcp.extensions.title / description / thisExtension / copyId / add /
idLabel / idPlaceholder / invalidId / empty / badge / refresh / remove / removeConfirm
```

设计约束（与 AGENTS.md 一致）：

- 空态用虚线框 + 一句状态陈述，不放「点击添加」式 CTA；
- 移除是行内确认条（`height: 0 → auto`，150ms），不用模态；
- 展开面板 200ms 高度动画，收起时不留残影；
- 所有按钮 `shrink-0`，名称 `truncate`，窄侧栏下不换行错位。

## 7. 上下文模型（容易踩的坑）

`initBuiltinMcpServers()` 会在 **background**（`entrypoints/background.ts`）、
**side panel**（`entrypoints/sidepanel/main.tsx`）、以及打开 MCP 设置页时的 **options**
（`McpSettings.tsx#useInitMcpServers`）执行。它开头有
`if (mcpRegistry.getAllServers().length > 0) return;`——每个上下文是独立的 JS realm，
因此各有一份 registry、各开一套 Port。

推论：

1. 提供方会看到 2–3 条并发会话，必须无状态化（见 protocol.md §3.7）；
2. 工具执行发生在**发起对话的上下文**（通常是 side panel），
   因此 `background` 里的 registry 不参与模型工具面；
3. 不能把「已连接」写进 storage 之类的共享状态——状态是各上下文私有的运行时事实。

## 8. 扩展点（改这里之前先想清楚）

| 需求 | 改动位置 | 注意 |
| --- | --- | --- |
| 消费 `annotations` | `getAITools()` 映射时保留 | AI SDK tool 无对应字段，需自定义元数据表 |
| 支持 resources/prompts | 新增能力开关 + 独立 UI 入口 | MCP 能力协商后才有意义；不要塞进 L0 |
| 每提供方独立超时/重试 | `extension-probe.ts` 常量 | 2000ms：冷启动 SW 的余量 |
| 允许 label 编辑 UI | `McpSettings.tsx` + `updateConfig` | `syncExtensionProviders` 不因 label 变化重连 |
| 提供方排序 | `McpSettings` 本地排序 | registry 顺序决定工具冲突优先级，改排序会影响 first-wins 结果 |
