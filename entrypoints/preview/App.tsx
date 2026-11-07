import { useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Download,
  X,
  Copy,
  Check,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Code,
  Eye,
  ExternalLink,
  Save,
} from 'lucide-react';
import { Streamdown } from 'streamdown';
import { code } from '@streamdown/code';
import { cjk } from '@streamdown/cjk';
import { cn } from '@/lib/utils';
import { ThemeInit } from '@/lib/theme';
import { AppDirection } from '@/components/direction-provider';
import { FontSizeInit } from '@/lib/font-size';
import { useEvent } from '@/lib/event-bus';
import { splitMarkdownFrontmatter } from '@/lib/markdown-frontmatter';
import { selectAllRootProps, useSelectAllScope } from '@/lib/use-select-all-scope';
import { CodeEditor } from './EditorView';
import { CsvPreview } from './CsvPreview';
import { FrontmatterCard } from './FrontmatterCard';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  fileStorage,
  type FileMetadata,
  getPreviewCategory,
  getLanguageFromMime,
  isLikelyTextContent,
  isTempPath,
} from '@/lib/mcp';

type ViewMode = 'rendered' | 'source';

/**
 * MIME types that render as something richer than their own source.
 *
 * These are the only files that get the rendered/source toggle; for everything
 * else the editor *is* the preview.
 */
function hasRenderedView(mimeType: string): boolean {
  return (
    mimeType === 'text/markdown' ||
    mimeType === 'text/html' ||
    mimeType === 'text/csv' ||
    mimeType === 'text/tab-separated-values'
  );
}

export default function App() {
  const { t } = useTranslation();
  const [metadata, setMetadata] = useState<FileMetadata | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [allFiles, setAllFiles] = useState<FileMetadata[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(100);
  const [viewMode, setViewMode] = useState<ViewMode>('rendered');
  const [copied, setCopied] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [isDark, setIsDark] = useState(() =>
    document.documentElement.classList.contains('dark'),
  );

  // Track dark mode changes
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains('dark'));
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    return () => observer.disconnect();
  }, []);

  // Ctrl/Cmd+A selects the previewed content only, never the toolbar or gutter.
  useSelectAllScope();

  const [fileNameOverride, setFileNameOverride] = useState<string | null>(null);

  const fileName = useMemo(() => {
    if (fileNameOverride) return fileNameOverride;
    const params = new URLSearchParams(window.location.search);
    return params.get('file');
  }, [fileNameOverride]);

  /**
   * The blob URL currently handed to the <img>, tracked outside React state.
   *
   * Reloading has to revoke the previous URL, and the cleanup closure cannot read
   * it from state: it would capture whatever value existed when the effect ran,
   * so every reload after the first would leak a blob. A ref always holds the
   * live value.
   */
  const objectUrlRef = useRef<string | null>(null);

  const setObjectUrlSafely = useCallback((url: string | null) => {
    if (objectUrlRef.current && objectUrlRef.current !== url) {
      URL.revokeObjectURL(objectUrlRef.current);
    }
    objectUrlRef.current = url;
    setObjectUrl(url);
  }, []);

  /**
   * Load (or reload) the file.
   *
   * `silent` distinguishes a reload driven by a `files:changed` event from the
   * initial mount. A reload keeps the current content on screen instead of
   * flashing the loading state, because an agent editing a file writes
   * repeatedly and a spinner between every write makes the preview unreadable.
   */
  const loadFile = useCallback(
    async (silent = false) => {
      if (!fileName) {
        setError('No file specified');
        setLoading(false);
        return;
      }

      if (!silent) setLoading(true);

      try {
        const meta = await fileStorage.getMetadata(fileName);
        if (!meta) {
          // Covers the file being deleted while open: drop the stale content
          // rather than keep rendering a file that no longer exists.
          setError(t('options.preview.fileNotFound'));
          setMetadata(null);
          setContent(null);
          setObjectUrlSafely(null);
          return;
        }

        setMetadata(meta);
        let category = getPreviewCategory(meta.mimeType);

        // Fallback for legacy files stored as octet-stream: sniff content
        if (category === 'unsupported') {
          const blob = await fileStorage.readFileAsBlob(fileName);
          if (blob && await isLikelyTextContent(blob)) {
            category = 'text';
            // Update metadata locally so the UI reflects text/plain
            meta.mimeType = 'text/plain';
            setMetadata({ ...meta });
          }
        }

        if (category === 'image') {
          const url = await fileStorage.getObjectUrl(fileName);
          setObjectUrlSafely(url);
          setContent(null);
          setError(null);
        } else if (category === 'text') {
          const text = await fileStorage.readFileAsText(fileName);
          setContent(text);
          setObjectUrlSafely(null);
          setError(null);
        } else {
          setError(t('options.preview.unsupported'));
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [fileName, t, setObjectUrlSafely],
  );

  /**
   * Refresh the switcher's file list.
   *
   * Scratch artefacts under `tmp/` are not documents, so they stay out of the
   * list — except the tab's own file, which may be a spilled shell output opened
   * from a tool card. Without that exception the dropdown would not name what
   * the tab is currently showing.
   */
  const refreshFileList = useCallback(async () => {
    try {
      const list = await fileStorage.listFiles({ includeTemp: false });
      if (fileName && isTempPath(fileName) && !list.some((file) => file.name === fileName)) {
        const current = await fileStorage.getMetadata(fileName);
        if (current) list.unshift(current);
      }
      setAllFiles(list);
    } catch {
      // Keep the previous list rather than blanking the switcher on a read error.
    }
  }, [fileName]);

  useEffect(() => {
    void loadFile();
  }, [loadFile]);

  useEffect(() => {
    void refreshFileList();
  }, [refreshFileList]);

  // Revoke the outstanding blob URL on unmount only. Reloads revoke their own
  // predecessor via `setObjectUrlSafely`.
  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  /**
   * Live updates. The MCP file tools run in the side panel, so a write reaches
   * this tab as a `files:changed` broadcast rather than any DOM or storage event.
   */
  useEvent('files:changed', ({ names }) => {
    // Refresh file list for the switcher
    void refreshFileList();
    if (!fileName || !names.includes(fileName)) return;
    void loadFile(true);
  });

  const handleSwitchFile = (name: string) => {
    if (name === fileName) return;
    const url = new URL(window.location.href);
    url.searchParams.set('file', name);
    window.history.replaceState(null, '', url.toString());
    // Update the fileName-derived state and reload the file
    setDirty(false);
    editorContentRef.current = null;
    // A different file opens the way that file type is meant to be read. The
    // fallback below forces `source` for types without a rendered view, so a
    // file that has one is never stuck behind a previous file's source mode.
    setViewMode('rendered');
    setFileNameOverride(name);
  };

  const handleDownload = async () => {
    if (!fileName) return;
    const blob = await fileStorage.readFileAsBlob(fileName);
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleClose = () => {
    window.close();
  };

  // --- Editor save logic ---
  const editorContentRef = useRef<string | null>(null);

  const handleEditorChange = useCallback((newContent: string) => {
    editorContentRef.current = newContent;
    setDirty(newContent !== content);
  }, [content]);

  const handleSave = useCallback(async (directContent?: string) => {
    const saveContent = directContent ?? editorContentRef.current;
    if (!fileName || saveContent == null) return;
    setSaving(true);
    try {
      await fileStorage.writeFile(fileName, saveContent);
      setContent(saveContent);
      setDirty(false);
    } finally {
      setSaving(false);
    }
  }, [fileName]);

  const handleCopy = async () => {
    if (content == null) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard may be unavailable in some contexts; ignore.
    }
  };

  const handleZoomIn = () => setZoom((z) => Math.min(z + 25, 300));
  const handleZoomOut = () => setZoom((z) => Math.max(z - 25, 25));
  const handleZoomReset = () => setZoom(100);

  const category = metadata ? getPreviewCategory(metadata.mimeType) : null;
  const showModeSwitch = metadata ? hasRenderedView(metadata.mimeType) : false;

  // If the new file doesn't support mode switching, fall back:
  // - non-markdown/html files have no "rendered" view → force 'source'
  // - markdown/html always have both, so keep current mode
  useEffect(() => {
    if (metadata && !showModeSwitch && viewMode === 'rendered') {
      setViewMode('source');
    }
  }, [metadata, showModeSwitch, viewMode]);

  return (
    <AppDirection>
    <div className="flex flex-col h-screen w-full bg-background">
      <ThemeInit />
      <FontSizeInit />

      {/* Top Toolbar - 32px height */}
      {/*
        Chrome, not content: excluded from text selection so a drag-select or
        select-all over the file never picks up its name and MIME type.
      */}
      <header className="h-8 shrink-0 flex items-center justify-between px-3 border-b border-border bg-card select-none">
        <div className="flex items-center gap-1 min-w-0">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex items-center min-w-0 h-6 rounded px-1.5 hover:bg-accent transition-colors">
                <span className="text-xs font-medium text-foreground truncate max-w-[300px]">
                  {fileName || t('options.preview.title')}
                </span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" sideOffset={4} className="max-h-64 overflow-y-auto">
              {allFiles.map((file) => (
                <DropdownMenuItem
                  key={file.name}
                  onClick={() => handleSwitchFile(file.name)}
                  className={cn(file.name === fileName && 'bg-accent')}
                >
                  <span className="truncate">{file.name}</span>
                  <span className="ms-auto ps-3 text-[10px] text-muted-foreground shrink-0">
                    {file.mimeType.split('/')[1]}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {metadata && (
            <span className="text-xs text-muted-foreground ms-1 shrink-0">
              {metadata.mimeType}
            </span>
          )}
          {/* Unsaved indicator + save button */}
          {dirty && (
            <button
              onClick={() => handleSave()}
              disabled={saving}
              className="flex items-center gap-1 h-5 rounded px-1.5 ms-2 text-xs font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors disabled:opacity-50"
            >
              <Save className="h-3 w-3" />
              <span>{saving ? t('common.saving') : t('options.preview.unsaved')}</span>
            </button>
          )}
        </div>

        <div className="flex items-center gap-1">
          {/* Mode switch for markdown/html */}
          {showModeSwitch && (
            <button
              onClick={() => setViewMode((m) => (m === 'rendered' ? 'source' : 'rendered'))}
              className="flex items-center gap-1 h-6 rounded px-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              title={t('options.preview.switchMode')}
            >
              {viewMode === 'rendered' ? (
                <>
                  <Code className="h-3 w-3" />
                  <span className="hidden sm:inline">{t('options.preview.source')}</span>
                </>
              ) : (
                <>
                  <Eye className="h-3 w-3" />
                  <span className="hidden sm:inline">{t('options.preview.rendered')}</span>
                </>
              )}
            </button>
          )}

          {/* Open with external playground (HTML only) */}
          {metadata?.mimeType === 'text/html' && content !== null && (
            <OpenWithMenu content={content} />
          )}

          {/* Zoom controls */}
          {category === 'image' && (
            <>
              <ToolbarButton onClick={handleZoomOut} title={t('options.preview.zoomOut')}>
                <ZoomOut className="h-3.5 w-3.5" />
              </ToolbarButton>
              <span className="text-xs text-muted-foreground min-w-[36px] text-center">
                {zoom}%
              </span>
              <ToolbarButton onClick={handleZoomIn} title={t('options.preview.zoomIn')}>
                <ZoomIn className="h-3.5 w-3.5" />
              </ToolbarButton>
              <ToolbarButton onClick={handleZoomReset} title={t('options.preview.resetZoom')}>
                <RotateCcw className="h-3.5 w-3.5" />
              </ToolbarButton>
            </>
          )}

          {/* Copy source (text/code files) */}
          {content !== null && (
            <ToolbarButton onClick={handleCopy} title={t('options.preview.copy')}>
              {copied ? (
                <Check className="h-3.5 w-3.5 text-green-500" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </ToolbarButton>
          )}

          {/* Download */}
          <ToolbarButton onClick={handleDownload} title={t('options.preview.download')}>
            <Download className="h-3.5 w-3.5" />
          </ToolbarButton>

          {/* Close */}
          <ToolbarButton onClick={handleClose} title={t('options.preview.close')}>
            <X className="h-3.5 w-3.5" />
          </ToolbarButton>
        </div>
      </header>

      {/* Preview Content Area */}
      <main className="flex-1 overflow-auto bg-background">
        {loading && (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            {t('common.loading')}
          </div>
        )}

        {error && (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            {error}
          </div>
        )}

        {!loading && !error && category === 'image' && objectUrl && (
          <ImagePreview src={objectUrl} zoom={zoom} />
        )}

        {!loading && !error && category === 'text' && content !== null && metadata && (
          <TextPreview
            content={content}
            path={fileName ?? ''}
            mimeType={metadata.mimeType}
            viewMode={viewMode}
            isDark={isDark}
            onSave={handleSave}
            onChange={handleEditorChange}
          />
        )}
      </main>
    </div>
    </AppDirection>
  );
}

/**
 * Image preview with zoom support.
 */
function ImagePreview({ src, zoom }: { src: string; zoom: number }) {
  return (
    <div className="flex items-center justify-center min-h-full p-4 bg-[repeating-conic-gradient(#80808015_0%_25%,transparent_0%_50%)] bg-[length:16px_16px]">
      <img
        src={src}
        alt="Preview"
        className="max-w-none transition-transform duration-150"
        style={{ width: `${zoom}%`, height: 'auto' }}
      />
    </div>
  );
}

/**
 * Text preview with support for:
 * - Markdown (rendered via Streamdown or source view)
 * - HTML (rendered in iframe or source view)
 * - Code files (editable via CodeMirror)
 * - Plain text
 */
function TextPreview({
  content,
  path,
  mimeType,
  viewMode,
  isDark,
  onSave,
  onChange,
}: {
  content: string;
  /** Storage path of the file being previewed. */
  path: string;
  mimeType: string;
  viewMode: ViewMode;
  isDark: boolean;
  onSave: (content: string) => void;
  onChange: (content: string) => void;
}) {
  // Parsed on every edit, so memoised on the content it parses. The source view
  // keeps the raw file including the frontmatter; only the rendered view splits
  // it, because that is the view where the block used to turn into a heading.
  const markdown = useMemo(
    () => (mimeType === 'text/markdown' ? splitMarkdownFrontmatter(content) : null),
    [content, mimeType],
  );

  // Markdown — both rendered + editor always mounted, toggled via opacity
  if (mimeType === 'text/markdown' && markdown) {
    return (
      <div className="relative h-full">
        <div
          className={cn(
            'absolute inset-0 overflow-auto transition-opacity duration-75',
            viewMode === 'rendered' ? 'opacity-100' : 'opacity-0 pointer-events-none',
          )}
        >
          <div className="p-6 max-w-3xl mx-auto break-words" {...selectAllRootProps}>
            {markdown.data && <FrontmatterCard data={markdown.data} path={path} />}
            {/* `sd-message-response` styles are tuned for chat-width prose; the
                card above keeps its own scale by staying outside it. */}
            <div className="sd-message-response">
              <Streamdown plugins={{ code, cjk }}>{markdown.body}</Streamdown>
            </div>
          </div>
        </div>
        <div
          className={cn(
            'absolute inset-0 transition-opacity duration-75',
            viewMode === 'source' ? 'opacity-100' : 'opacity-0 pointer-events-none',
          )}
        >
          <CodeEditor
            content={content}
            language="markdown"
            isDark={isDark}
            onSave={onSave}
            onChange={onChange}
          />
        </div>
      </div>
    );
  }

  // HTML — both rendered + editor always mounted
  if (mimeType === 'text/html') {
    return (
      <div className="relative h-full">
        <div
          className={cn(
            'absolute inset-0 transition-opacity duration-75',
            viewMode === 'rendered' ? 'opacity-100' : 'opacity-0 pointer-events-none',
          )}
        >
          <HtmlPreview content={content} />
        </div>
        <div
          className={cn(
            'absolute inset-0 transition-opacity duration-75',
            viewMode === 'source' ? 'opacity-100' : 'opacity-0 pointer-events-none',
          )}
        >
          <CodeEditor
            content={content}
            language="html"
            isDark={isDark}
            onSave={onSave}
            onChange={onChange}
          />
        </div>
      </div>
    );
  }

  // CSV/TSV — table view + source editor, same pattern as markdown and HTML. The
  // table is the readable form of a data file; the source is where it is edited
  // (and what `Ctrl/Cmd+S` saves from).
  if (mimeType === 'text/csv' || mimeType === 'text/tab-separated-values') {
    return (
      <div className="relative h-full">
        <div
          className={cn(
            'absolute inset-0 transition-opacity duration-75',
            viewMode === 'rendered' ? 'opacity-100' : 'opacity-0 pointer-events-none',
          )}
        >
          <CsvPreview content={content} />
        </div>
        <div
          className={cn(
            'absolute inset-0 transition-opacity duration-75',
            viewMode === 'source' ? 'opacity-100' : 'opacity-0 pointer-events-none',
          )}
        >
          <CodeEditor
            content={content}
            language=""
            isDark={isDark}
            onSave={onSave}
            onChange={onChange}
          />
        </div>
      </div>
    );
  }

  // Code files - editable (single mode, no toggle)
  const language = getLanguageFromMime(mimeType);
  if (language) {
    return (
      <CodeEditor
        content={content}
        language={language}
        isDark={isDark}
        onSave={onSave}
        onChange={onChange}
      />
    );
  }

  // Plain text / others - editable
  return (
    <CodeEditor
      content={content}
      language=""
      isDark={isDark}
      onSave={onSave}
      onChange={onChange}
    />
  );
}

/**
 * HTML rendered preview using a manifest-declared sandbox page.
 *
 * Chrome Extension MV3 enforces strict CSP on extension pages. The manifest
 * sandbox page has a relaxed CSP (allowing inline scripts, eval, and external
 * CDN resources). We embed sandbox.html as an iframe, then postMessage the
 * HTML content to it. Inside sandbox.html, a nested iframe renders the user
 * HTML via srcdoc, keeping the message listener alive for live updates.
 *
 * Limitations: WebGL is unavailable (Chrome restricts it on opaque origins).
 */
function HtmlPreview({ content }: { content: string }) {
  const { t } = useTranslation();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const readyRef = useRef(false);

  const contentRef = useRef(content);
  contentRef.current = content;

  const post = useCallback(() => {
    iframeRef.current?.contentWindow?.postMessage({ html: contentRef.current }, '*');
  }, []);

  // Handshake: wait for sandbox-ready, then post content.
  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      if (e.data?.type !== 'sandbox-ready') return;
      readyRef.current = true;
      post();
    };
    window.addEventListener('message', handleMessage);

    const iframe = iframeRef.current;
    const handleLoad = () => {
      // Fallback in case ready signal arrived before listener was attached.
      window.setTimeout(post, 50);
    };
    iframe?.addEventListener('load', handleLoad);

    return () => {
      window.removeEventListener('message', handleMessage);
      iframe?.removeEventListener('load', handleLoad);
    };
  }, [post]);

  // Re-post on content change for live preview updates.
  useEffect(() => {
    if (!readyRef.current) return;
    post();
  }, [content, post]);

  const sandboxUrl = chrome.runtime.getURL('/sandbox.html');

  return (
    <iframe
      ref={iframeRef}
      src={sandboxUrl}
      className="w-full h-full border-none bg-background"
      title={t('options.preview.sandboxTitle')}
    />
  );
}

// ---------------------------------------------------------------------------
// Open With Menu — external playground services
// ---------------------------------------------------------------------------

interface PlaygroundService {
  id: string;
  name: string;
  /** Open the user's HTML content in this service. */
  open: (html: string) => void;
}

/**
 * List of supported external playgrounds that can receive raw HTML.
 * Each uses a hidden form POST to pre-fill the editor.
 */
const PLAYGROUND_SERVICES: PlaygroundService[] = [
  {
    id: 'codepen',
    name: 'CodePen',
    open(html: string) {
      // CodePen accepts JSON via a hidden form POST.
      // https://blog.codepen.io/documentation/prefill/
      const data = JSON.stringify({ html });
      postForm('https://codepen.io/pen/define', { data });
    },
  },
  {
    id: 'jsfiddle',
    name: 'JSFiddle',
    open(html: string) {
      // JSFiddle POST API
      // https://docs.jsfiddle.net/api/display-a-fiddle-from-post
      postForm('https://jsfiddle.net/api/post/library/pure/', { html });
    },
  },
  {
    id: 'stackblitz',
    name: 'StackBlitz',
    open(html: string) {
      // StackBlitz POST API
      // https://developer.stackblitz.com/docs/platform/post-api
      postForm('https://stackblitz.com/run', {
        'project[files][index.html]': html,
        'project[template]': 'html',
        'project[title]': 'Preview',
      });
    },
  },
];

/** Submit a hidden form POST to open a URL in a new tab. */
function postForm(action: string, fields: Record<string, string>) {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = action;
  form.target = '_blank';
  form.style.display = 'none';

  for (const [name, value] of Object.entries(fields)) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }

  document.body.appendChild(form);
  form.submit();
  document.body.removeChild(form);
}

function OpenWithMenu({ content }: { content: string }) {
  const { t } = useTranslation();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="flex items-center gap-1 h-6 rounded px-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          title={t('options.preview.openWith')}
        >
          <ExternalLink className="h-3 w-3" />
          <span className="hidden sm:inline">{t('options.preview.openWith')}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={4}>
        {PLAYGROUND_SERVICES.map((svc) => (
          <DropdownMenuItem key={svc.id} onClick={() => svc.open(content)}>
            {svc.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Compact, uniformly-sized icon button for the preview toolbar.
 */
function ToolbarButton({
  onClick,
  title,
  children,
  className,
}: {
  onClick: () => void;
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        'flex items-center justify-center h-6 w-6 shrink-0 rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
        className,
      )}
    >
      {children}
    </button>
  );
}
