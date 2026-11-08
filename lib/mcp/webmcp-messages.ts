/**
 * WebMCP messaging protocol between content script and background service worker.
 *
 * Content script (MAIN world) discovers tools via document.modelContext,
 * then reports them to the background via chrome.runtime.sendMessage.
 * Background maintains the authoritative tab→tools state in session storage.
 */

import type { WebMcpToolInfo } from './types';

// ============================================================================
// Content Script → Background messages
// ============================================================================

/**
 * Report the full list of tools available on the current page.
 * Sent on initial discovery and whenever the toolset changes.
 */
export interface WebMcpToolsReportMessage {
  type: 'webmcp:tools-report';
  tools: WebMcpToolInfo[];
  pageTitle: string;
  pageUrl: string;
}

/**
 * Notify background that the content script is alive and monitoring.
 * Used as a heartbeat / initial handshake.
 */
export interface WebMcpHeartbeatMessage {
  type: 'webmcp:heartbeat';
  hasModelContext: boolean;
  pageTitle: string;
  pageUrl: string;
}

/**
 * Content script is being unloaded (page navigation / close).
 */
export interface WebMcpUnloadMessage {
  type: 'webmcp:unload';
}

export type WebMcpContentMessage =
  | WebMcpToolsReportMessage
  | WebMcpHeartbeatMessage
  | WebMcpUnloadMessage;

/**
 * Narrow an untrusted `window.postMessage` payload to a content→background
 * message.
 *
 * The MAIN world is the page's own world, so anything on the page can post a
 * `webmcp:`-prefixed message. Relaying it unchecked would let a page drive
 * `chrome.runtime.sendMessage` with arbitrary payloads, and would let a
 * malformed `type` reach `startsWith` on a non-string.
 */
export function isWebMcpContentMessage(
  value: unknown,
): value is WebMcpContentMessage {
  if (!value || typeof value !== 'object') return false;
  const type = (value as { type?: unknown }).type;
  if (typeof type !== 'string') return false;
  return (
    type === 'webmcp:tools-report' ||
    type === 'webmcp:heartbeat' ||
    type === 'webmcp:unload'
  );
}

// ============================================================================
// Background → Content Script messages
// ============================================================================

/**
 * Request the content script to re-report its current tool list.
 */
export interface WebMcpRequestToolsMessage {
  type: 'webmcp:request-tools';
}

/**
 * Request the content script to execute a specific tool.
 *
 * `timeoutMs` is the budget the extension computed for this call (see
 * `webmcp-timeout.ts`); the bridge uses it instead of a fixed timeout so a
 * long-running page tool can be granted the time its caller asked for.
 */
export interface WebMcpExecuteToolMessage {
  type: 'webmcp:execute-tool';
  toolName: string;
  args: string; // JSON stringified arguments
  executionId: string;
  timeoutMs?: number;
}

export type WebMcpBackgroundMessage =
  | WebMcpRequestToolsMessage
  | WebMcpExecuteToolMessage;

// ============================================================================
// Background → Content Script response for tool execution
// ============================================================================

export interface WebMcpExecuteToolResponse {
  success: boolean;
  result?: string; // JSON stringified result
  error?: string;
}

// ============================================================================
// Session storage key for WebMCP tab states
// ============================================================================

export const WEBMCP_SESSION_KEY = 'webmcp:tabStates';
