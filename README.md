# Lumo

AI-powered browser sidebar assistant — a Chrome extension that brings a full-featured AI agent directly into your browser.

Lumo connects to third-party LLM APIs and provides deep browser integration through the Model Context Protocol (MCP), enabling the AI to interact with tabs, pages, network, DevTools, and more.

## Installation

### Chrome Web Store (stable)

**[Install Lumo from the Chrome Web Store](https://chromewebstore.google.com/detail/lumo/cgfnadidpooocnkalljpdmelmaponefa)**

This is the easiest way to install and it auto-updates. Note that **the Chrome Web Store version lags behind the code in this repository** — each release has to pass Google's review, so recently merged features and fixes are usually not in it yet.

### Latest build from GitHub Actions (up to date)

Every push to `main` is built by the [Build & Upload Extension](../../actions/workflows/build.yml) workflow, which publishes the packed extension as an artifact:

1. Open the [latest successful workflow run](../../actions/workflows/build.yml?query=is%3Asuccess).
2. Download the `lumo-chrome-mv3` artifact from the run's **Artifacts** section (requires being signed in to GitHub).
3. Unzip it — GitHub wraps artifacts in a zip, and inside you get the unpacked extension directory.
4. Go to `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the unzipped directory.

Caveats of this route: it does **not** auto-update (repeat the steps to upgrade), Chrome will show a "disable developer mode extensions" warning on startup, artifacts expire after GitHub's retention period, and it installs as a separate extension from the Web Store version. Builds from `main` are unreleased code and may be unstable.

You can also [build from source](#getting-started) yourself.

## Features

### AI Chat Sidebar
- Stream-based conversations with multi-model support
- Image input for vision-capable models
- Multi-turn tool-calling agent loop (AI autonomously uses browser tools)
- Conversation history with search and management
- Streaming Markdown rendering with code highlighting and math support
- Stop generation / retry on failure

### Built-in MCP Servers (Browser Tools)

| Server | Capabilities |
|--------|-------------|
| **Browser Core** | Tabs, windows, bookmarks, history, cookies, downloads, navigation |
| **Page Interaction** | DOM reading/querying, clicking, form filling, screenshots, JS execution |
| **Network Monitor** | Request capture, URL blocking/redirecting, header modification |
| **DevTools Advanced** | CDP-based input simulation, accessibility tree, full-page screenshots, device/network emulation |
| **File Manager** | Read, write, patch, and preview files stored in the extension (IndexedDB) |

### Agent Skills

A skill is a directory under `skills/` holding a `SKILL.md` with YAML frontmatter,
following the [Agent Skills specification](https://agentskills.io/specification):

```markdown
---
name: pdf-tools
description: Extract text and tables from PDFs. Use when reading or converting one.
---

Read `references/formats.md` before converting a document.
```

- Only the index — name, description and path — is added to the system prompt. The
  instructions are read on demand with `file_read`, so a skill costs a few dozen
  tokens until it is actually used.
- `/skill:pdf-tools extract report.pdf` loads a skill explicitly, for the cases
  where the model does not route to it on its own.
- **Settings → Files → Skills** is the management view: every installed skill with
  its routing description, `/skill:<name>` trigger, license, file count, and the
  validation diagnostics that explain why a skill does not load — plus delete for
  the whole skill.
- Skills are imported from a `.zip`, a folder, a drop, or a **GitHub repository
  URL**. A repository is listed first — one API request for its tree, then only the
  manifests, so the review can show descriptions and sizes before anything is
  downloaded — and only the skills you pick have their files fetched. If that
  listing is blocked, rate limited or too large to list, the whole archive is
  downloaded instead; only when both paths fail is the import reported as failed.
  Every import is reviewed before anything is written: the package's skills are
  listed with the same metadata the Skills tab shows, new ones arrive selected,
  already-installed ones are listed but unchecked (ticking one is how an update
  happens), and manifests that cannot load are shown with the reason. **Files** is the
  document view: upload, search, preview, download, and drop a folder to import
  its files. Nested directories are preserved, an archive holding several skills
  installs all of them, and every `SKILL.md` inside becomes one skill. Files under
  `skills/` are kept when the file manager is cleared.

### External MCP Server Support
- Connect to remote MCP servers via **HTTP Streamable** or **SSE** transport
- Add/remove/enable/disable servers from the settings UI
- Real-time connection status (connecting, connected, sign-in needed, error)
- Auto-discovery of tools provided by external servers
- **OAuth 2.1 authorization** per the MCP authorization spec: protected-resource
  metadata discovery, dynamic client registration, authorization code + PKCE,
  and rotating refresh tokens. A connection never starts the browser flow by
  itself — it sends the stored token, refreshes once when the server rejects it,
  and otherwise waits for the user to sign in from the server card. Credentials
  are bound to the server and its URL, and are never part of a config export.
  Servers that authenticate with a static secret keep working through the
  `Authorization` header field — a manual header always takes precedence over the
  automatic flow.

### Programmatic Tools (experimental)

Settings → Execution → Experimental → **Programmatic tools** replaces the flat MCP tool
list with four tools:

| Tool | Purpose |
|------|---------|
| `file_read` | Read a file; images come back as images |
| `file_write` | Create or replace a file |
| `file_edit` | Patch a file in place |
| `sh` | Run a bash-like script |

`sh` is one execution surface for everything the other servers expose. It
supports pipes, redirections, variables, functions, loops and globs, plus `grep`,
`sed`, `awk`, `jq`, `find`, `xargs`, `curl`, `node`, `tar`, `zip`/`unzip`,
`yq` and `iconv`.

```bash
# Every MCP server — built-in, external, WebMCP and extension providers — is a
# shell command. Discover a schema before calling it.
mcp list
mcp tools browser
mcp describe page-interact.page_snapshot
mcp call page-interact.page_snapshot '{}' --json | jq -r '.content[0].text' | head -20

# `--output` writes image bytes whenever the path names an image (or the
# result is image-only), so a screenshot tool that also returns a caption
# still produces a real PNG. `--quiet` keeps the payload out of stdout.
mcp call page-interact.page_screenshot '{"scope":"viewport"}' --output tmp/shot.png --quiet
ls -l tmp/shot.png

# Batched calls: one JSON request per line, run in parallel.
printf '%s\n' '{"target":"browser.browser_tabs","params":{}}' | mcp batch
```

- **One filesystem.** The shell's `/` is the same IndexedDB store the file tools
  and the Files view use, so `echo hi > notes.md` and `file_read notes.md` name
  the same file. `skills/` is writable like any other directory.
- **Locale.** `TZ` is set from the browser's time zone, so `date` and date
  arithmetic match the user's clock instead of UTC.
- **Full network.** `curl` and JavaScript `fetch` use the extension's host fetch
  with no allow-list, matching what an MCP server can already reach.
- **JavaScript.** `node -e '<script>'` runs in QuickJS/WASM with top-level
  `await` (also in `-p` expressions and ES module syntax), Node-shaped timers,
  `Buffer`, `AbortController`/`AbortSignal`, `Headers`/`Response`,
  `TextEncoder`/`TextDecoder` (including `gbk`/`big5`/`shift_jis` decoding and
  `fatal`/BOM rules), `crypto` hashes and HMACs, `zlib`, `stream`,
  `structuredClone`, `tools.<server>.<tool>()` (images it returns are written
  to `tmp/` and attached to the shell result, exactly like `mcp call`), `mcp.*`,
  the asynchronous `fs`
  and unrestricted `fetch`. `require` resolves builtins (`path`, `os`, `util`,
  `events`, `fs`, `fs/promises`, `crypto`, `buffer`, `child_process`, `url`,
  `timers`, `zlib`, `stream`, `readline`, `querystring`, `string_decoder`,
  `perf_hooks`, `module`, `assert`) plus relative `.js`/`.json` files from the
  VFS. `module`, `exports`, `__filename` and `__dirname` exist in the entry
  script, and `import`/`export` syntax is downgraded to the CommonJS shims.
- **Locales.** QuickJS ships without ICU, so `Intl` (and `toLocaleString`,
  `localeCompare`) is delegated to the extension's own ICU through the bridge:
  dates, numbers, currencies, collation and plural rules match the browser
  instead of falling back to engine defaults.
- **Shell from JavaScript.** `child_process.exec` runs a command in the same
  interpreter and captures stdout/stderr/exit code:

  ```js
  const { stdout } = await exec('mcp call browser.browser_tabs');
  exec('exit 3', (error, stdout, stderr) => console.log(error?.code));
  ```

  `execFile`/`spawn` quote their argv and call `exec`, with `stdout`/`stderr`
  exposed as event streams. `execSync` and `fs.*Sync` cannot exist on a
  WASM-bridged VFS; they fail with a message naming the `await` replacement.
  Likewise there is no `node_modules` resolution, no socket-level `http`/`net`,
  no Python and no SQLite. `Intl` is not in the engine, but the shim above
  provides it.
- **Bounded output.** stdout/stderr are capped at 2000 lines / 50 KB for the
  model; anything longer is written to `tmp/` and the path is reported. That
  path is clickable in the tool card, because the spill file is hidden from the
  file library.
- **Scratch files stay scratch.** `tmp/` is readable from both the shell and
  `file_read`, but it is hidden from the Files page, the preview's file list,
  `@` mentions and backups, and entries older than seven days are pruned at
  startup together with their now-empty directory records.
- **Lazy runtime.** The interpreter (just-bash + QuickJS) is a separate chunk
  loaded on the first `sh` call, so turning the mode off costs nothing at
  startup. Scripts run in the side panel itself: a CPU-bound loop can block the
  UI, and an infinite loop never yields the thread back — not even to the
  turn's abort signal. Pass `timeoutMs` for anything that might not finish.
- **Isolated scripts.** Guest code cannot reach `chrome.*`; it only gets the
  bridge the shell exposes. Network access is unrestricted by design, so review
  destructive commands the same way you would review a tool call.

There is no configurable structural budget: the interpreter's command/loop/
output counters are deliberately unbounded, QuickJS has no fixed memory ceiling
(it grows until the browser heap does), and the only bound on the script itself
is the `timeoutMs` the model passes. Each individual MCP call has its own
120-second gateway ceiling. There is no separate VFS quota either: the shell
writes to the same file library as the file tools, and the browser's IndexedDB
quota is the real limit.

Turning the switch off restores the previous per-tool MCP list exactly; history
from both modes stays readable.

### Multi-Provider Model Support
- OpenAI-compatible API (Chat Completions)
- OpenAI Responses API
- Anthropic Claude API
- Any OpenAI-compatible gateway (e.g. OpenRouter, Azure, local proxies)

### Settings & Customization
- Model & provider configuration
- Custom system prompts
- Light / Dark theme
- Internationalization (English & Chinese)
- File manager for AI-generated files, with a separate Skills view for installed
  capabilities (metadata, diagnostics, import, delete)
- Chat debug inspector

## Tech Stack

| Category | Technologies |
|----------|-------------|
| Framework | [WXT](https://wxt.dev) (Chrome Extension MV3) |
| UI | React 19, Tailwind CSS 4, shadcn/ui, Radix UI |
| AI | [Vercel AI SDK](https://ai-sdk.dev) (`ai`, `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/mcp`) |
| Animation | Motion (Framer Motion) |
| i18n | i18next + react-i18next |
| State | Zustand, Chrome Storage API |
| Markdown | Streamdown (streaming markdown renderer) |
| Build | Vite 7, TypeScript 5.9 |
| Shell (experimental) | just-bash, QuickJS (WASM) |

## Getting Started

### Prerequisites

- Node.js >= 18
- npm

### Install

```bash
npm install
```

### Development

```bash
npm run dev
```

This starts WXT in development mode with hot reload. Load the extension from `.output/chrome-mv3` in Chrome (`chrome://extensions` → Developer mode → Load unpacked).

### Build

```bash
npm run build
```

Production build output goes to `.output/chrome-mv3`.

### Package for Distribution

```bash
npm run zip
```

### Type Check

```bash
npm run compile
```

## Project Structure

```
├── entrypoints/
│   ├── sidepanel/       # Main chat UI (sidebar)
│   ├── options/         # Settings pages (hash-routed)
│   ├── preview/         # File preview page
│   ├── background.ts    # Service worker
│   └── content.ts       # Content script
├── components/
│   ├── ai-elements/     # AI conversation rendering components
│   ├── chat/            # Chat-specific components
│   └── ui/              # shadcn base components
├── lib/
│   ├── mcp/             # MCP servers and registry
│   ├── tools/           # Tool gateway and conversion catalogue (mode-agnostic)
│   ├── shell/           # Programmatic mode: VFS, sh tool, mcp/node commands
│   ├── ai.ts            # AI SDK integration layer
│   ├── theme.ts         # Theme management
│   └── system-prompt.ts # System prompt configuration
├── store/               # Storage and state hooks
├── i18n/                # Internationalization (en, zh)
├── types/               # Shared TypeScript types
└── assets/              # Global styles and static assets
```

## Browser Support

- Chrome / Chromium-based browsers (MV3)
- Firefox support available via `npm run dev:firefox` / `npm run build:firefox`

## License

[MIT](LICENSE) © mscststs
