# 开发流程

两个仓库的命令相同（WXT + Vitest）：

| 目的 | 命令 |
| --- | --- |
| 类型检查 | `npm run compile`（`tsc --noEmit`） |
| 单测（全量） | `npm test` |
| 单测（本功能） | `npx vitest run tests/extension-server.test.ts tests/extension-provider.test.ts` |
| 提供方单测 | `cd ../lumo-userscript-manager && npx vitest run tests/agent.test.ts` |
| 开发构建 | `npm run dev`（提供方会先跑 `predev: build:runtime`） |
| 产物 | `npm run build` → `.output/chrome-mv3` |
| 打包 | `npm run zip` |

> **本技能目录只允许放 `.md`。** 两个仓库的 `tsconfig` 都是
> `"include": ["../**/*"]`（`.wxt/tsconfig.json`），所以 `.agents/**/*.ts`
> 会被 `tsc --noEmit` 纳入编译。放一个引用 `@modelcontextprotocol/sdk` 的 `.ts`
> 到 Lumo（未安装该依赖）会直接让 `npm run compile` 失败。

---

## 1. 场景 A：把「任意一个已装扩展」接成服务

**宿主侧零代码改动。** 前提是对方已经实现协议（或按下节改造）。

1. 提供方 `externally_connectable` 就绪，加载扩展，记下 ID
   （`chrome://extensions` 或对方设置页的「扩展 ID」卡片）。
2. Lumo → 设置 → MCP → Extensions → Add extension → 粘贴 ID。
3. 预期：卡片出现，状态 `error`，文案为「waiting for you to approve this extension」
   或「does not allow this extension」。
4. 去提供方设置页（`#/settings/agent`）批准；回到侧栏（触发 focus 重试，5s 节流内可能需要等一下）。
5. 预期：`connected`，工具数 = `3`（只读）或 `8`（`allowWrites` 开启）。

排查入口：`references/troubleshooting.md`。

---

## 2. 场景 B：给提供方加一个工具

1. 在 `lib/agent/tools.ts` 的 `registerAgentTools()` 里 `server.registerTool(...)`；
2. 判断是读还是写：
   - 读 → `guardedRead(senderId, run)`，放在 `if (!settings.allowWrites) return;` **之前**；
   - 写 → `guardedWrite(senderId, '<tool>', args, run)`，放在之后；
3. 返回用 `ok()` / `failed()`；写操作把目标 uuid 写进 `target.uuid` 以便审计关联；
4. 若新增业务错误码，同时更新 `failed({code})` 的使用点与测试断言；
5. 更新 `buildAgentInstructions()` 里对应的段落（宿主当前不消费，保持文档一致性仍然必要）；
6. 工具名用 `snake_case`，唯一；宿主会加 `<namespace>_` 前缀，最终名不超过 57 字符；
7. 跑 `npx vitest run tests/agent.test.ts`，补一条正向 + 一条门禁用例。

**不需要动宿主**：宿主在 `tools/list` 时动态发现，`MAX_TOOLS=64` 内自动挂载。
工具数变化后宿主需要一次重连才刷新——手动「重新连接」或等下一次懒重连。

---

## 3. 场景 C：改宿主能力（会同时影响所有提供方）

按顺序改，缺一层就会出现「UI 有、模型没有」或「设置生效、注册表不生效」：

1. `lib/mcp/types.ts`：`McpExtensionProviderConfig` / `McpTransportType`；
2. `lib/mcp/settings.ts`：`DEFAULT_MCP_SETTINGS` + `normalizeExtensionProviders()`；
3. `store/storage-schema.ts` 的字段 `normalize` 与 `store/storage.ts` 的写回；
4. `lib/mcp/extension-registry.ts`：成员/开关变化的同步逻辑；
5. `lib/mcp/extension-server.ts`：状态机、工具映射、错误文案；
6. `lib/mcp/index.ts`：`initBuiltinMcpServers` 与 storage 同步；
7. `entrypoints/options/McpSettings.tsx` + `i18n/{en,zh}.ts`；
8. 测试：`tests/extension-server.test.ts`、`tests/extension-provider.test.ts`。

如果新字段可以缺省（旧数据没有），**必须**在 `normalize*` 里补默认值，
否则 `storage.getMcpSettings()` 拿到 `undefined`，下游 `.map`/`.some` 直接抛错。

---

## 4. 测试写法

### 4.1 宿主（`tests/extension-server.test.ts`）

只测 `ExtensionMcpServer` 的状态机，不碰真实 chrome：

```ts
vi.mock('@/lib/mcp/extension-probe', () => ({
  probeExtension: mocks.probe,
  authorizeExtension: mocks.authorize,
}));
vi.mock('@ai-sdk/mcp', () => ({
  createMCPClient: async ({ transport }) => {
    // 关键：真实实现会「占有」transport.onclose，mock 必须复现，
    // 否则测不出 lib/mcp/extension-server.ts 里的链式 onclose 逻辑。
    transport.onclose = () => {};
    return { initializeResult: {}, listTools: mocks.listTools,
             callTool: mocks.callTool, close: async () => {} };
  },
}));
vi.mock('@/lib/mcp/transports/chrome-port', () => ({
  ChromePortTransport: { connect: () => makeFakeTransport() },
}));
```

必须覆盖的用例（对应现有实现的事实）：

| 用例 | 断言 |
| --- | --- |
| 命名空间 | `userscripts_list` / `userscripts_get`，`transport === 'extension'` |
| 懒重连 | `transport.isClosed = true` 后调用工具 → `createClient` 第二次被调用，状态回到 `connected`，参数用**本地名** |
| 调用路由 | `callTool({name:'list', arguments})`，返回原样透传 |
| 未授权 | `error` + 「does not allow this extension」 |
| 待审批 | `error` + 「waiting for you to approve」 |
| 已关闭 | `error` + 「turned off」 |
| 不可达 | `error` + 「not installed」 |

`tests/extension-provider.test.ts` 覆盖纯函数：`normalizeMcpSettings` 迁移
（含剔除 `injectInstructions`）、脏 ID/重复 ID、`isProbeResponse`、`isExtensionId`。

### 4.2 提供方（`tests/agent.test.ts`）

用官方 SDK 的 `Client` 驱动真实的 `McpServer`，只把物理层换成内存对象：

- `MemoryTransport` 对：`send` 里 `queueMicrotask(() => peer.onmessage?.(m))`；
- `FakePort` 对：`postMessage` / `disconnect` 双向派发 `onMessage` / `onDisconnect`；
- `chrome` stub：`runtime.{id,getManifest,getURL}`、`storage.local.{get,set}`、
  `tabs.{query,create,update}`、`windows.update`、`userScripts.getScripts`。

必须覆盖：

1. `isProbeRequest` 信封校验（错误 channel / null）；
2. deny-by-default：未配置时仍回 `ok:true` 且 `status.enabled=false`；
3. 未知调用方 → 写入 pending 队列；`approvePendingRequest` → `enabled:true` + 入 allowlist；
4. 版本不匹配 → `ok:false` + `UNSUPPORTED_PROTOCOL`，**但 `service` 仍然返回**；
5. Port 往返：`initialize → tools/list → tools/call` 全链路；
6. 未授权 Port 被立即关闭，且不暴露工具；
7. `allowWrites=false` 时工具面只有读工具；会话中途关掉后调用失败；
8. 限流：第 31 次写在同一分钟内返回 `RATE_LIMITED`；
9. `reviewWrites=true` 时 `create` 保存为禁用 + `pendingReview`。

### 4.3 新增测试的判定标准

一个改动至少要有：一条「正常路径」+ 一条「策略/边界拒绝路径」。
只有 UI 文案改动的，至少补一条 i18n key 存在性断言（参考
`tests/i18n-options-models.test.ts` 的写法）。

---

## 5. 手工联调（真机）

1. 两个仓库各 `npm run build`，`chrome://extensions` 打开开发者模式，
   Load unpacked 分别加载 `.output/chrome-mv3`。
2. 在 Lumo 的 MCP → Extensions 分区复制「本扩展」ID；
   在提供方的 Agent 设置里 Add 这个 ID（或在宿主卡片上点「授权」→ 提供方弹出审批卡片 →「允许并启用」）。
3. 在 Lumo 添加提供方 ID，确认状态与工具数。
4. 打开侧栏发起一轮对话，验证真实工具调用（读 + 写各一次）。
5. 断线自愈：
   - `chrome://serviceworker-internals` → Stop 提供方 SW；
   - 立刻在侧栏再发一条消息 → 应先自动重连成功，且**工具列表不闪断**。
6. 策略即时性：
   - 关闭提供方总开关 → 下一次工具调用失败；
   - 关闭 `allowWrites` → 写调用失败、读调用仍成功；
   - 关闭 Lumo 侧卡片开关 → 工具从模型工具面消失。
7. 审批回路：在提供方移除 allowlist 条目，回 Lumo 点「重新连接」→ 应出现
   琥珀色 `unauthorized` +「授权」按钮；批准后侧栏 focus 自动恢复。
8. 多上下文：同时打开设置页与侧栏，确认两边状态各自正确（这是预期，不是 bug）。

---

## 6. 版本与发布

| 变更 | 处理 |
| --- | --- |
| 提供方加工具 | 只改自身 `manifest.version`；宿主无需发版 |
| L0 字段新增（可选） | 不改 `PROBE_VERSION`；两侧守卫已容忍未知字段 |
| L0 语义变更 | `PROBE_VERSION + 1`，两侧同步发版；旧宿主得到 `UNSUPPORTED_PROTOCOL` |
| 宿主 `MAX_TOOLS` / 命名规则变更 | 视为契约变更：会影响所有提供方的工具名，必须同步文档与测试 |
| 商店发布 | 扩展 ID 不变；未打包加载的 ID 会变，需重新添加 |

发布前跑：`npm run compile && npm test && npm run build`（两个仓库各一遍）。

---

## 7. 代码评审清单

- [ ] L0 响应在 `enabled=false` / `authorized=false` 时仍然是 `ok:true`。
- [ ] 授权只用 `sender.id`；`client.*` / `service.name` 只用于展示。
- [ ] 每条 Port 一个 `McpServer`；没有跨会话共享的 session 状态。
- [ ] 写工具每次调用都 `requireAccess(..., true)`，且先限流后执行。
- [ ] 审计只存哈希，不存源码；失败不影响主流程。
- [ ] 新增 storage 字段有 `DEFAULT_*` + `normalize` + 旧数据用例。
- [ ] 新增 UI 文案进 i18n，中英各一条；空态/加载/错误三态齐全。
- [ ] 新增工具描述自解释（模型只读 name / description / inputSchema）。
- [ ] 断线、重连、禁用、卸载四条路径都手工验证过。
