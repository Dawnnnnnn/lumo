import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  Globe,
  Globe2,
  Loader2,
  Puzzle,
  Radio,
  RadioTower,
  Server,
  Wifi,
  WifiOff,
  Wrench,
} from 'lucide-react';
import { serverDisplayDescription } from '@/lib/mcp/server-labels';
import type { McpHttpServerConfig, McpServerState, McpToolDefinition } from '@/lib/mcp/types';

/**
 * Building blocks shared by every server card.
 *
 * Extracted so the built-in, external and extension cards stay pixel-identical:
 * the same transport glyph, the same status wording, and one expanded panel that
 * lists the tool surface.
 */

/** Transport glyph. Colour alone distinguishes the four registries. */
export function ServerIcon({ transport }: { transport: string }) {
  switch (transport) {
    case 'builtin':
      return <Globe className="h-4 w-4 shrink-0 text-primary" />;
    case 'http-stream':
      return <Radio className="h-4 w-4 shrink-0 text-blue-500" />;
    case 'sse':
      return <RadioTower className="h-4 w-4 shrink-0 text-orange-500" />;
    case 'webmcp':
      return <Globe2 className="h-4 w-4 shrink-0 text-emerald-500" />;
    case 'extension':
      return <Puzzle className="h-4 w-4 shrink-0 text-violet-500" />;
    default:
      return <Server className="h-4 w-4 shrink-0 text-muted-foreground" />;
  }
}

/**
 * Connection state in one line.
 *
 * The word is hidden on narrow side panels and the icon carries the meaning,
 * which keeps the row from wrapping when the options page is docked.
 */
export function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation();

  switch (status) {
    case 'connected':
      return (
        <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400 shrink-0">
          <Wifi className="h-3 w-3" />
          <span className="hidden sm:inline">{t('options.mcp.connected')}</span>
        </span>
      );
    case 'connecting':
      return (
        <span className="flex items-center gap-1 text-xs text-yellow-600 dark:text-yellow-400 shrink-0">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span className="hidden sm:inline">{t('options.mcp.connecting')}</span>
        </span>
      );
    case 'error':
      return (
        <span className="flex items-center gap-1 text-xs text-destructive shrink-0">
          <AlertCircle className="h-3 w-3" />
          <span className="hidden sm:inline">{t('options.mcp.error')}</span>
        </span>
      );
    default:
      return (
        <span className="flex items-center gap-1 text-xs text-muted-foreground shrink-0">
          <WifiOff className="h-3 w-3" />
          <span className="hidden sm:inline">{t('options.mcp.disconnected')}</span>
        </span>
      );
  }
}

export function ToolItem({ tool }: { tool: McpToolDefinition }) {
  return (
    <div className="flex items-start gap-2 p-2 rounded-md bg-muted/50">
      <Wrench className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-mono truncate">{tool.name}</p>
        <p className="text-xs text-muted-foreground line-clamp-2">{tool.description}</p>
      </div>
    </div>
  );
}

/**
 * Expanded panel body: description, endpoint, last error, tool list.
 *
 * `config` is present only for external servers, whose URL is worth showing;
 * built-ins and extension providers have nothing addressable to display.
 */
export function ServerExpandedContent({
  state,
  config,
}: {
  state: McpServerState;
  config?: McpHttpServerConfig;
}) {
  const { t } = useTranslation();

  return (
    <div className="p-3 pt-0 space-y-2 border-t border-border">
      <div className="text-xs text-muted-foreground mt-2">
        {serverDisplayDescription(t, state.info)}
      </div>

      {config && (
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 text-xs font-mono text-muted-foreground bg-muted/50 px-2 py-1 rounded truncate">
            {config.url}
          </div>
          {/* Which MCP revision was negotiated — a legacy endpoint answers
              `initialize` with 2025-11-25 or older, a modern one declares a
              version per request. Read-only, and absent until connected. */}
          {state.info.protocolVersion && (
            <span className="shrink-0 text-[0.6875rem] font-mono tabular-nums text-muted-foreground/70">
              {state.info.protocolVersion}
            </span>
          )}
        </div>
      )}

      {state.error && (
        <div className="flex items-start gap-2 p-2 rounded-md bg-destructive/10 text-destructive text-xs">
          <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span className="break-all">{state.error}</span>
        </div>
      )}

      {state.tools.length === 0 ? (
        <p className="text-xs text-muted-foreground py-2">{t('options.mcp.noTools')}</p>
      ) : (
        <div className="space-y-1">
          <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground mb-1">
            <Wrench className="h-3 w-3" />
            <span>{t('options.mcp.tools')}</span>
          </div>
          {state.tools.map((tool) => (
            <ToolItem key={tool.name} tool={tool} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Height-animated disclosure shared by every card, so expansion feels the same. */
export function CardDisclosure({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="overflow-hidden"
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
