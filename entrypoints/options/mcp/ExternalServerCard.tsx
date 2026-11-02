import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown,
  ChevronRight,
  KeyRound,
  Loader2,
  PowerOff,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { AUTH_REASON_KEYS } from '@/lib/mcp/server-labels';
import type { McpHttpServerConfig, McpServerState } from '@/lib/mcp/types';
import {
  CardDisclosure,
  ServerExpandedContent,
  ServerIcon,
  StatusBadge,
} from './ServerCardParts';

/**
 * An HTTP/SSE server added by the user: the only card that can be disabled,
 * detached or deleted, so it carries the full action row.
 */
export function ExternalServerCard({
  state,
  config,
  expanded,
  onToggle,
  onReconnect,
  onAuthorize,
  onSignOut,
  onDelete,
  onToggleEnabled,
}: {
  state: McpServerState;
  config?: McpHttpServerConfig;
  expanded: boolean;
  onToggle: () => void;
  onReconnect: () => void;
  onAuthorize: () => void;
  onSignOut: () => void;
  onDelete: () => void;
  onToggleEnabled: (enabled: boolean) => void;
}) {
  const { t } = useTranslation();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // Only an enabled server can be waiting for the user: a disabled one is off
  // by intent, and offering sign-in there would contradict the switch. While the
  // consent window is being prepared the affordance stays, disabled, so the click
  // is visibly acknowledged instead of turning into a silent spinner.
  const authorizing = state.info.enabled && state.status === 'authorizing';
  const needsAuthorization = state.info.enabled && state.status === 'unauthorized';
  // One translated sentence per reason, used for both hover affordances. The
  // raw SDK text stays in the expanded panel, where it can be read as context
  // rather than as the card's only explanation.
  const authReason = state.authError ? t(AUTH_REASON_KEYS[state.authError.reason]) : undefined;

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <div
        className="flex items-center gap-2 p-3 bg-card cursor-pointer hover:bg-accent/50 transition-colors"
        onClick={onToggle}
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 shrink-0" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 rtl:-scale-x-100" />
        )}

        <ServerIcon transport={state.info.transport} />

        <span className="font-medium text-sm flex-1 truncate">{state.info.name}</span>

        <span className="text-xs bg-muted text-muted-foreground px-1.5 py-0.5 rounded shrink-0 uppercase">
          {state.info.transport === 'http-stream' ? 'HTTP' : 'SSE'}
        </span>

        {state.info.enabled ? (
          <StatusBadge status={state.status} title={authReason} />
        ) : (
          <span className="flex items-center gap-1 text-xs text-muted-foreground shrink-0">
            <PowerOff className="h-3 w-3" />
            <span className="hidden sm:inline">{t('options.mcp.disabled')}</span>
          </span>
        )}

        <span className="text-xs text-muted-foreground shrink-0">
          {t('options.mcp.toolCount', { count: state.tools.length })}
        </span>

        <div onClick={(e) => e.stopPropagation()} className="shrink-0">
          <Switch
            checked={state.info.enabled}
            onCheckedChange={(checked) => onToggleEnabled(checked)}
          />
        </div>

        {/* One slot, two meanings: a server that wants a user in the loop turns
            the reconnect affordance into the action that resolves it. Adding a
            second button would leave two controls doing the same thing. */}
        {needsAuthorization || authorizing ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1 px-2 text-xs shrink-0"
            onClick={(e) => {
              e.stopPropagation();
              onAuthorize();
            }}
            disabled={authorizing}
            aria-label={t('options.mcp.signIn')}
            aria-busy={authorizing}
            title={authReason}
          >
            {authorizing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <KeyRound className="h-3.5 w-3.5" />
            )}
            <span className="hidden sm:inline">{t('options.mcp.signIn')}</span>
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={(e) => {
              e.stopPropagation();
              onReconnect();
            }}
            aria-label={t('options.mcp.reconnect')}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        )}

        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 text-destructive hover:text-destructive hover:bg-destructive/10"
          onClick={(e) => {
            e.stopPropagation();
            setConfirmingDelete(true);
          }}
          aria-label={t('options.mcp.removeServer')}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Inline confirmation rather than a nested dialog: the destructive action
          belongs to the row it destroys. */}
      <AnimatePresence>
        {confirmingDelete && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="flex items-center justify-between px-3 py-2 bg-destructive/5 border-t border-border">
              <span className="text-xs text-destructive">{t('options.mcp.removeConfirm')}</span>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-xs"
                  onClick={() => setConfirmingDelete(false)}
                >
                  {t('options.mcp.cancelDelete')}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  className="h-6 text-xs"
                  onClick={() => {
                    onDelete();
                    setConfirmingDelete(false);
                  }}
                >
                  {t('options.mcp.confirmDelete')}
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <CardDisclosure open={expanded}>
        <ServerExpandedContent state={state} config={config} onSignOut={onSignOut} />
      </CardDisclosure>
    </div>
  );
}
