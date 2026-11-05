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
