/**
 * WebMCP tools expose a caller-controlled execution budget.
 *
 * A page tool's schema belongs to the page, so the extension cannot simply add
 * a parameter: the page would either reject it or receive an unknown argument.
 * The rule these tests pin is therefore twofold — add `timeoutMs` only when the
 * page declares no budget of its own, and strip ours again before forwarding,
 * while the page's own `timeout`/`timeoutMs` is passed through untouched and
 * doubles as the budget.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnyTool } from '@/lib/mcp/types';
import { WebMcpServer } from '@/lib/mcp/webmcp-server';
import { WEBMCP_DEFAULT_TIMEOUT_MS } from '@/lib/mcp/webmcp-timeout';
import type { WebMcpTabState } from '@/lib/mcp/types';

const TAB_ID = 7;
const SESSION_KEY = 'webmcp:tabStates';

/** Reach the JSON Schema out of the AI SDK's `jsonSchema()` wrapper. */
function schemaOf(tool: AnyTool): { properties?: Record<string, unknown> } {
  const raw = tool.inputSchema as { jsonSchema?: unknown; schema?: unknown };
  return (raw.jsonSchema ?? raw.schema ?? raw) as { properties?: Record<string, unknown> };
}

let sent: Array<{ tabId: number; message: Record<string, unknown> }>;
let tabStates: WebMcpTabState[];

beforeEach(() => {
  sent = [];
  tabStates = [];
  (globalThis as any).chrome = {
    storage: {
      session: {
        get: vi.fn(async () => ({ [SESSION_KEY]: tabStates })),
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    tabs: {
      sendMessage: vi.fn((tabId: number, message: Record<string, unknown>) => {
        sent.push({ tabId, message });
        return Promise.resolve({ success: true, result: '{"content":[]}' });
      }),
    },
  };
});

afterEach(() => {
  delete (globalThis as any).chrome;
});

async function toolsFor(
  toolName: string,
  inputSchema: Record<string, unknown>,
): Promise<Record<string, AnyTool>> {
  tabStates = [
    {
      tabId: TAB_ID,
      title: 'Admin',
      url: 'https://example.test/admin',
      lastUpdated: Date.now(),
      tools: [{ name: toolName, description: 'Export data', inputSchema }],
    },
  ];
  const server = new WebMcpServer();
  await server.refreshTabStates();
  return server.getAITools();
}

describe('WebMCP schema and budget', () => {
  it('adds a timeout field when the page declares none, and strips it before forwarding', async () => {
    const tools = await toolsFor('export', { type: 'object', properties: {} });
    const tool = tools[`webmcp_tab${TAB_ID}_export`]!;

    expect(schemaOf(tool).properties).toHaveProperty('timeoutMs');

    await tool.execute!({ timeoutMs: 90_000 }, {} as never);

    expect(sent[0]).toMatchObject({
      tabId: TAB_ID,
      message: {
        type: 'webmcp:execute-tool',
        toolName: 'export',
        args: '{}',
        timeoutMs: 90_000,
      },
    });
  });

  it("forwards a page-owned timeout untouched and uses it as the budget", async () => {
    const tools = await toolsFor('export', {
      type: 'object',
      properties: { timeout: { type: 'number' } },
    });
    const tool = tools[`webmcp_tab${TAB_ID}_export`]!;

    const properties = schemaOf(tool).properties ?? {};
    expect(properties).toHaveProperty('timeout');
    expect(properties).not.toHaveProperty('timeoutMs');

    await tool.execute!({ timeout: 60_000 }, {} as never);

    expect(sent[0]).toMatchObject({
      message: {
        args: JSON.stringify({ timeout: 60_000 }),
        timeoutMs: 60_000,
      },
    });
  });

  it('falls back to the default budget when no argument names one', async () => {
    const tools = await toolsFor('export', { type: 'object', properties: {} });
    const tool = tools[`webmcp_tab${TAB_ID}_export`]!;

    await tool.execute!({}, {} as never);

    expect(sent[0]!.message.timeoutMs).toBe(WEBMCP_DEFAULT_TIMEOUT_MS);
  });
});
