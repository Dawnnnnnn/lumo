import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  Globe,
  Globe2,
  KeyRound,
  Loader2,
  LogOut,
  Puzzle,
  Radio,
  RadioTower,
  Server,
  Wifi,
  WifiOff,
  Wrench,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AUTH_REASON_KEYS, serverDisplayDescription } from '@/lib/mcp/server-labels';
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
export function StatusBadge({ status, title }: { status: string; title?: string }) {
  const { t } = useTranslation();

  // `title` carries the reason behind a pending sign-in, so the explanation is
  // reachable without expanding the card (which is the only other place it
  // lives). Hovering a status is the cheapest possible disclosure.
  const withTitle = (node: ReactNode) => (title ? <span title={title}>{node}</span> : node);

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
    case 'authorizing':
      return withTitle(
        <span className="flex items-center gap-1 text-xs text-yellow-600 dark:text-yellow-400 shrink-0">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span className="hidden sm:inline">{t('options.mcp.authorizing')}</span>
        </span>,
      );
    case 'error':
      return (
        <span className="flex items-center gap-1 text-xs text-destructive shrink-0">
          <AlertCircle className="h-3 w-3" />
          <span className="hidden sm:inline">{t('options.mcp.error')}</span>
        </span>
      );
    // Not an error: the server answered, it just wants a user in the loop. The
    // amber tone (rather than red) is the whole difference the user needs.
    case 'unauthorized':
      return withTitle(
        <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400 shrink-0">
          <KeyRound className="h-3 w-3" />
          <span className="hidden sm:inline">{t('options.mcp.unauthorized')}</span>
        </span>,
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
  onSignOut,
}: {
  state: McpServerState;
  config?: McpHttpServerConfig;
  /** Present for external servers, whose credentials can be revoked. */
  onSignOut?: () => void;
}) {
  const { t } = useTranslation();
  // Signing out is only meaningful while a grant exists — or while the card is
  // waiting for one, where it clears a half-finished attempt.
  const canSignOut = Boolean(onSignOut) && (state.hasCredentials || state.status === 'unauthorized');

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

      {/* Second layer: only visible once the row is open. `unauthorized` is a
          waiting state, so its explanation is quieter than a real error. The
          sentence comes from the reason — the raw SDK text is kept underneath as
          technical context instead of being the thing the user has to read. */}
      {state.authError && (
        <div className="flex items-start gap-2 p-2 rounded-md bg-amber-500/10 text-amber-700 dark:text-amber-400 text-xs">
          <KeyRound className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <div className="min-w-0 space-y-1">
            <p className="break-words">{t(AUTH_REASON_KEYS[state.authError.reason])}</p>
            {state.authError.detail && (
              <p className="break-all font-mono text-[0.6875rem] text-muted-foreground">
                {state.authError.detail}
              </p>
            )}
          </div>
        </div>
      )}

      {canSignOut && (
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-2 text-xs text-muted-foreground"
            onClick={onSignOut}
          >
            <LogOut className="h-3 w-3" />
            {t('options.mcp.signOut')}
          </Button>
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
