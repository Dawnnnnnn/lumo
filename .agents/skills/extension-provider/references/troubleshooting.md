# 排查手册

先定位，再改。下面每条都给出**用户可见文案 / 日志锚点 → 根因 → 修复**。

## 0. 三个观测点

| 位置 | 看什么 |
| --- | --- |
| Lumo → 设置 → MCP → Extensions → 展开卡片 | `status`、错误文案、工具列表 |
| Lumo 控制台 | `[MCP] Tool "…" … collides with …`、`[MCP:<extId>] Uncaught transport error:` |
| 提供方 SW 控制台（`chrome://extensions` → service worker） | probe 记录、`MCP session failed`、审计警告 |

---

## 1. 连不上

### 1.1 `Extension is not installed, or it does not expose an agent endpoint.`

宿主把 `sendMessage` 的拒绝归类为 `unreachable`。按可能性排序：

| 根因 | 验证 | 修复 |
| --- | --- | --- |
| ID 抄错 / 少一位 / 含大写 | 与 `chrome://extensions` 逐字符比对，必须 `/^[a-p]{32}$/` | 重新添加（非法 ID 在输入时就会被 `isExtensionId` 拦下） |
| 提供方未声明 `externally_connectable` | 看其 `manifest.json` | 加 `{ ids: ['*'] }`，重新加载 |
| 提供方已卸载/被禁用 | `chrome://extensions` | 重新加载后重新添加（未打包 ID 会变） |
| 提供方 SW 崩溃 | 提供方 SW 控制台 | 修异常；监听器必须在顶层同步注册 |
| 未打包 ID 变了 | 重新加载后 ID 变化 | Lumo 里删掉旧条目，加新 ID |

### 1.2 `Probe timed out after 2000 ms.`

- 冷启动 SW 首次 probe 可能接近 2s 超时（大依赖、同步初始化）。probe 本身必须只读：
  如果它在等写存储或开标签页，问题不在冷启动，而在 `handleProbe` 里塞了副作用。
- 也先确认提供方的 **「扩展请求访问时打开设置」没有被关掉**：它是「是否参与宿主集成」的总闸，
  关闭时 probe 直接回 `ok:false`（`REQUESTS_DISABLED`），宿主连发现都不会展示它。
- **「装了但探测不到 / 探测过一次就不再回应」的头号原因**：旧实现把
  `recordPendingRequest`（串行化的读-改-写，还会连带打开标签页）放在 probe 路径上。
  提示链路一旦卡住，probe 就永远不回复。现在 probe 只读，副作用全部挪到 `lumo:authorize`——
  若又出现同样症状，第一件事是检查 `handleProbe` 里有没有 `await` 任何写操作。
- 常见写法错误：把 `onMessageExternal` 注册放在某个 `await` 之后 → 冷启动事件丢失。
- 修复：监听器同步注册；把重活挪到事件回调里。超时后宿主在侧栏重新获得焦点时会自动重试
  （`retryExtensionProviders`，5s 节流）。

### 1.3 `Probe response is missing service or status.`

提供方回了 `ok:true` 但没带 `service`/`status`。检查 `handleProbe` 的每个分支是否都构造完整对象。

### 1.4 `The extension returned a malformed probe response.`

`isProbeResponse()` 只要求 `ok` 是布尔：
说明返回的不是对象、或 `ok` 是字符串，最常见原因是 `onMessageExternal` 里
忘了 `return true`（异步 `sendResponse` 失效，宿主收到 `undefined`）。

---

## 2. 授权

### 2.1 `… is waiting for you to approve this extension.`

正常状态，不是错误。做这三件事：

1. 提供方设置页 `#/settings/agent` → Access requests → 「允许并启用」；
2. 回到 Lumo 侧栏（focus 触发重试），或点卡片上的刷新；
3. 若仍不恢复，点「重新连接」强制 re-probe。

### 2.2 `… does not allow this extension. Add <id> to its allowed extension IDs.`

宿主 ID 不在 allowlist。注意文案里给出的就是**当前宿主真实 ID**，
直接用「本扩展」旁的复制按钮，避免手抄。

### 2.3 审批卡片不出现

- `promptOnRequest` 关闭：probe 与 authorize 都回 `REQUESTS_DISABLED`，宿主连发现都不会展示它；
- 宿主发的是 `lumo:probe` 而不是 `lumo:authorize`：只有后者会弹窗（probe 只读）；
- 探测方 `sender.id` 为空或非法 → `recordPendingRequest` 直接忽略；
- 打开的不是扩展页面（content script 发不出 `sendMessage`）。

授权路径**没有冷却**：若点击后没有弹窗，问题一定在上面几条，而不是限流。

### 2.4 批准后每次探测又弹一次

`approvePendingRequest` 应当**同时**置 `enabled:true` + 加 allowlist + 删除队列项。
若只加 allowlist 不加 enabled，probe 会返回 `authorized:true, enabled:false`，
宿主显示「turned off」，且下次探测仍可能重新记录（取决实现）。

---

## 3. 工具面异常

### 3.1 状态 `connected` 但工具数为 0

| 根因 | 判断 | 修复 |
| --- | --- | --- |
| 提供方只注册了读工具且 `allowWrites` 影响注册 | 工具数应为 3 | 属预期 |
| `tools/list` 抛错但被吞 | 看宿主/提供方控制台 | 修工具注册 |
| 工具名规范化为空 → 全部 `tool` 撞名被去重 | 检查提供方工具名 | 用 `snake_case` 唯一名 |
| 提供方 SDK 版本不兼容 MCP spec | `initialize` 成功但 `listTools` 失败 | 对齐 SDK 版本，真机验证 |

工具数超过 `MAX_TOOLS = 64` 时**静默截断**（无警告）。看到「少了几个」先数一下。

### 3.2 工具名不是预期的

宿主规则见 `references/host-integration.md` §4.4：

- 小写、非法字符变 `_`、namespace 截 16、tool 截 40；
- namespace 命中保留集合（`browser page file network devtools webmcp ext`）→ 回退 `ext_<id8>`；
- namespace 不以字母开头 / 为空 → 同样回退。

所以 `Page Tools!` + `Find Element` 得到 `page_tools_find_element`，
而不是 `PageTools_findElement`。这是契约，不是 bug。

### 3.3 工具消失后又自己回来

MV3 提供方 SW 空闲被回收 → Port 断开 → `needsReconnect=true`，缓存工具**保留**，
下一次调用自动重连。属预期，不要改成「断开即清空」。

若**不**自动恢复，检查：

1. `transport.isClosed` 是否被正确置位（`handleDisconnect` → `onDisconnect` + `onclose`）；
2. `createMCPClient` 之后是否重新链了 `transport.onclose`（SDK 会覆盖）；
3. 重连时是否还在用 `initialInitializeResult`（不能用，提供方每 Port 新建 server）。

### 3.4 调用报 `The extension provider is not connected.` / `Could not reconnect …`

重连期间的 probe 失败了（提供方被关、被移除 allowlist、未就绪）。
看向上抛出的 `this.error`，它通常是 §1/§2 的某条文案。

### 3.5 工具名冲突警告

```
[MCP] Tool "userscripts_list" from ext:… collides with ext:…; keeping the first registration.
```

两个提供方暴露了同一 namespace + 同名工具，或与内置工具撞名。
first-wins（按注册顺序：内置 → HTTP → WebMCP → 扩展）。修复：改 namespace。

---

## 4. 设置不生效

| 现象 | 根因 | 修复 |
| --- | --- | --- |
| 刚添加就消失 | ID 非法或重复被 `normalizeExtensionProviders()` 丢弃 | 用 `isExtensionId` 校验；重复 ID 静默忽略 |
| 超过第 16 个不生效 | `slice(0, 16)` | 属预期 |
| 关掉开关工具还在模型里 | 下一次工具面刷新才生效（模型消息已构建） | 新一轮对话即消失 |
| 会话中途关掉 `allowWrites` 仍能看到写工具 | 提供方只在建会话时注册写工具，宿主缓存工具面 | 调用会失败；重连后隐藏 |
| 改了 options 侧栏没变 | 侧栏在 `chrome.storage.onChanged` 上同步 | 确认走 `storage.setMcpSettings()`（会 normalize），别直接 `chrome.storage.local.set` |
| 旧备份导入后多出一个字段 | 旧字段未在 normalize 中剔除 | 在 `normalizeMcpSettings` 里删除并补测试 |
| 直接读 settings 的下游拿到 `undefined` | 新字段未进 `DEFAULT_MCP_SETTINGS`/normalize | 两处都补 |

---

## 5. 能连上但行为不对

| 现象 | 根因 |
| --- | --- |
| 模型忽略了 `readOnlyHint` | 宿主不消费 annotations；门禁在提供方 |
| 写操作静默成功（review 未生效） | `reviewWrites` 只在 `create/install` 的落盘参数里；`edit/update` 不改变启用状态 |
| 第 31 次写失败 | 限流 30 次/60s，按 `sender.id` |
| 审计里看不到源码 | 设计如此：只存参数 SHA-256 |
| 两个标签页各弹一次审批 | 多宿主上下文各自 `authorize`；pending 队列按 `sender.id` 合并；`openOptionsTab` 是单例，第二个只会聚焦同一页 |
| options 页与侧栏状态不同 | 每个 trusted context 独立 registry，预期行为 |

---

## 6. 已知缺口与不一致（改之前先读）

| 项 | 现状 | 影响 |
| --- | --- | --- |
| `annotations` | 未透传到 AI SDK tool | 只能作元数据 |
| `ChromePortTransport.onDisconnect` | 已定义但宿主未使用（实际用 `isClosed` 判活） | 语义重复，清理时别误删三层判据 |
| `getExtensionProvider()` | 已实现但未从 `lib/mcp/index.ts` 导出 | 调试时需直接 import 模块 |
| `PROBE_TIMEOUT_MS` | 硬编码 1500ms | 冷启动慢的提供方偶发超时 |
| `MAX_TOOLS` 截断 | 静默 | 工具「莫名少了」没有任何日志 |
| 工具面刷新 | 只在 connect/disconnect 时 | 提供方新增工具后需手动重连或等懒重连 |
| `label` | 类型支持，UI 无编辑入口 | 只能显示自报名 |

---

## 7. 快速归零法

怀疑是缓存/旧数据问题时：

```js
// Lumo 侧栏控制台
const s = await chrome.storage.local.get('mcpSettings');
console.log(JSON.stringify(s.mcpSettings.extensionProviders, null, 2));
// 清空提供方列表（保留其他 MCP 设置）
const next = { ...s.mcpSettings, extensionProviders: [] };
await chrome.storage.local.set({ mcpSettings: next });
```

```js
// 提供方 SW 控制台
const a = await chrome.storage.local.get(['agentSettings', 'agentPendingRequests']);
console.log(a);
```

然后重新添加 + 重新审批，走一遍 `references/development.md` §5 的手工联调。
