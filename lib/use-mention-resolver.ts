/**
 * Hook that resolves `@` mention suggestions for the chat composer.
 *
 * Queries browser tabs and stored files asynchronously and caches the results so
 * the suggestion picker can filter them synchronously on every keystroke. The
 * cache is refreshed each time the `@` trigger activates (transitions from no
 * trigger to an active trigger), so the list stays current across separate
 * invocations without constant polling.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { v4 as uuidv4 } from 'uuid';
import { fileStorage, type FileMetadata } from '@/lib/mcp';
import { fileRefContent } from '@/lib/file-drag';
import { buildPageContextAttachment, type PageContext } from '@/lib/page-context';
import { MENTION_PREFIX, type MentionSettings } from '@/lib/mention-commands';
import type { ActiveTrigger } from '@/lib/input-trigger';
import type { SuggestionOption } from '@/lib/use-suggestion-menu';
import type { TextAttachment } from '@/types';

// ---------------------------------------------------------------------------
// Cached data shape
// ---------------------------------------------------------------------------

interface MentionCache {
  tabs: chrome.tabs.Tab[];
  files: FileMetadata[];
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseMentionResolverOptions {
  settings: MentionSettings;
  /** Callback to add an attachment to the input's chip strip. */
  addAttachment: (attachment: TextAttachment) => void;
  /**
   * Whether a `@` trigger is currently active in the input. Used to detect
   * session boundaries: going from inactive → active means the user just typed
   * a fresh `@`, so data should be refetched.
   */
  triggerActive: boolean;
}

/**
 * Returns a `resolve` function compatible with `useSuggestionMenu`. The
 * function filters the cached data synchronously; the cache is refreshed each
 * time the `@` trigger opens (i.e. transitions from inactive to active).
 */
export function useMentionResolver({
  settings,
  addAttachment,
  triggerActive,
}: UseMentionResolverOptions): (trigger: ActiveTrigger) => SuggestionOption[] {
  const { t } = useTranslation();
  const [cache, setCache] = useState<MentionCache>({ tabs: [], files: [] });
  /** Incremented each time a new trigger session starts, to dedupe fetches. */
  const sessionRef = useRef(0);
  const addAttachmentRef = useRef(addAttachment);
  addAttachmentRef.current = addAttachment;

  /**
   * Fetches fresh data for a new trigger session.
   *
   * `session` is compared against `sessionRef` so that a stale fetch landing
   * after the trigger closed (or a newer one opened) does not clobber the cache
   * with outdated data.
   */
  const fetchData = useCallback(
    async (session: number) => {
      const [tabs, files] = await Promise.all([
        settings.tabsEnabled
          ? chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[])
          : Promise.resolve([] as chrome.tabs.Tab[]),
        settings.filesEnabled
          ? fileStorage.listFiles({ includeTemp: false }).catch(() => [] as FileMetadata[])
          : Promise.resolve([] as FileMetadata[]),
      ]);
      // Only apply if this is still the current session.
      if (session === sessionRef.current) {
        // Sort: active tab first, then the rest in original order.
        const sorted = [...tabs].sort((a, b) => {
          if (a.active && !b.active) return -1;
          if (!a.active && b.active) return 1;
          return 0;
        });
        setCache({ tabs: sorted, files });
      }
    },
    [settings.tabsEnabled, settings.filesEnabled],
  );

  // Each time the trigger transitions from inactive → active, bump the session
  // and fetch fresh data. This ensures every new "@" gets up-to-date tabs/files.
  const prevActiveRef = useRef(false);
  useEffect(() => {
    if (triggerActive && !prevActiveRef.current) {
      sessionRef.current += 1;
      void fetchData(sessionRef.current);
    }
    prevActiveRef.current = triggerActive;
  }, [triggerActive, fetchData]);

  const resolve = useCallback(
    (trigger: ActiveTrigger): SuggestionOption[] => {
      if (trigger.char !== MENTION_PREFIX) return [];
      if (!settings.enabled) return [];

      const needle = trigger.query.toLowerCase();
      const results: SuggestionOption[] = [];

      // Tabs
      if (settings.tabsEnabled) {
        for (const tab of cache.tabs) {
          if (!tab.id) continue;
          const title = tab.title ?? '';
          const url = tab.url ?? '';
          if (
            needle &&
            !title.toLowerCase().includes(needle) &&
            !url.toLowerCase().includes(needle)
          ) {
            continue;
          }
          results.push({
            id: `tab:${tab.id}`,
            label: title || url,
            description: url,
            badge: t('mentions.badge.tab'),
            insertText: '',
            apply: (value, active) => {
              const context: PageContext = {
                tabId: tab.id!,
                title: tab.title ?? '',
                url: tab.url ?? '',
              };
              const attachment = buildPageContextAttachment(
                uuidv4(),
                context,
                t('mentions.label.tab'),
              );
              addAttachmentRef.current(attachment);
              // Remove the @token from the input, keep surrounding text.
              const before = value.slice(0, active.start);
              const after = value.slice(active.end);
              const next = before + after;
              return { value: next, caret: before.length };
            },
          });
        }
      }

      // Files
      if (settings.filesEnabled) {
        for (const file of cache.files) {
          if (needle && !file.name.toLowerCase().includes(needle)) continue;
          results.push({
            id: `file:${file.name}`,
            label: file.name,
            description: `${formatBytes(file.size)}`,
            badge: t('mentions.badge.file'),
            insertText: '',
            apply: (value, active) => {
              const attachment: TextAttachment = {
                id: uuidv4(),
                kind: 'file-ref',
                mediaType: 'text/plain',
                content: fileRefContent(file.name),
                preview: file.name,
                label: t('mentions.label.file'),
              };
              addAttachmentRef.current(attachment);
              // Remove the @token from the input, keep surrounding text.
              const before = value.slice(0, active.start);
              const after = value.slice(active.end);
              const next = before + after;
              return { value: next, caret: before.length };
            },
          });
        }
      }

      return results;
    },
    [settings, cache, t],
  );

  return resolve;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
