// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { McpServerState } from '@/lib/mcp/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { ServerExpandedContent } = await import('@/entrypoints/options/mcp/ServerCardParts');

afterEach(cleanup);

function state(overrides: Partial<McpServerState['info']> = {}): McpServerState {
  return {
    info: {
      id: 'exa',
      name: 'Exa',
      description: '',
      transport: 'http-stream',
      builtin: false,
      enabled: true,
      ...overrides,
    },
    status: 'connected',
    tools: [],
  };
}

const config = {
  id: 'exa',
  name: 'Exa',
  description: '',
  transport: 'http-stream' as const,
  url: 'https://mcp.exa.ai/mcp',
  enabled: true,
};

describe('MCP server card', () => {
  it('reports the negotiated protocol revision next to the endpoint', () => {
    render(<ServerExpandedContent state={state({ protocolVersion: '2025-11-25' })} config={config} />);

    expect(screen.getByText('https://mcp.exa.ai/mcp')).toBeTruthy();
    expect(screen.getByText('2025-11-25')).toBeTruthy();
  });

  it('stays silent about the revision before one is negotiated', () => {
    render(<ServerExpandedContent state={state()} config={config} />);

    expect(screen.getByText('https://mcp.exa.ai/mcp')).toBeTruthy();
    // An em dash or a placeholder would read as a value; absence is the truth.
    expect(screen.queryByText(/^\d{4}-\d{2}-\d{2}$/)).toBeNull();
  });
});
