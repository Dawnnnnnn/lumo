import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown,
  FileArchive,
  FolderUp,
  GitBranch,
  Loader2,
  Search,
  Upload,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { fileStorage, type FileMetadata } from '@/lib/mcp';
import { hasOsFiles, importFileEntries, importTextFiles } from '@/lib/file-import';
import { useSidePanelPresence } from '@/lib/side-panel-presence';
import { useEvent } from '@/lib/event-bus';
import { listConversationMeta, type ConversationMeta } from '@/lib/conversation-store';
import { downloadAsZip } from '@/lib/zip-download';
import { openFilePreview } from '@/lib/file-preview-tab';
import {
  directoryEntriesFromFiles,
  directoryPackageSource,
  inspectSkillPackages,
  installSkillCandidates,
  isEmptyDrop,
  readDroppedFiles,
  zipPackageSource,
  type SkillCandidate,
  type SkillInspection,
  type SkillPackageSource,
} from '@/lib/skills/import';
import { baseName } from '@/lib/mcp/file-storage';
import { buildSkillRows, skillManifestPath, type SkillRow } from '@/lib/skills/rows';
import { SKILL_FILE_NAME } from '@/lib/skills/constants';
import { useSkillIndex } from '@/store/useSkills';
import { SettingsHeader } from '../components/SettingsHeader';
import { FileListView } from './FileListView';
import { GitHubImportDialog } from './GitHubImportDialog';
import { SkillImportDialog } from './SkillImportDialog';
import { SkillListView } from './SkillListView';

/** Views of the same library: the user's documents, and what Lumo can do. */
type FilesTab = 'files' | 'skills';

const TAB_HASH: Record<FilesTab, string> = {
  files: 'files',
  skills: 'files/skills',
};

/**
 * `webkitdirectory` opens the folder picker instead of the file picker.
 *
 * It only means anything on `input[type=file]`, and React declares no attribute
 * for it, so it is applied through a spread rather than a JSX prop.
 */
const DIRECTORY_PICKER_ATTRIBUTE = {
  webkitdirectory: '',
} as unknown as React.InputHTMLAttributes<HTMLInputElement>;

/** What the last import or upload did, stated for a few seconds. */
type Notice =
  | { kind: 'installed'; count: number }
  | { kind: 'skipped'; count: number }
  | { kind: 'failed' }
  | { kind: 'noManifest' }
  | { kind: 'uploaded'; count: number }
  | { kind: 'uploadRejected' };

function readTabFromHash(): FilesTab {
  return window.location.hash.replace('#', '').split('/')[1] === 'skills' ? 'skills' : 'files';
}

/**
 * The tab is part of the URL.
 *
 * Skill management is a place another surface can send the user to ("this skill
 * did not load"), and a refresh has to land back on the view that was open. Both
 * are the same requirement: the hash carries it.
 */
function useFilesTab(): readonly [FilesTab, (next: FilesTab) => void] {
  const [tab, setTab] = useState<FilesTab>(readTabFromHash);

  useEffect(() => {
    const sync = () => setTab(readTabFromHash());
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  const select = useCallback((next: FilesTab) => {
    window.location.hash = TAB_HASH[next];
    setTab(next);
  }, []);

  return [tab, select] as const;
}

/**
 * The file library.
 *
 * One page, two views, because they answer different questions about the same
 * storage: **Files** is what Lumo wrote or the user uploaded, **Skills** is what
 * Lumo can *do*. Listing skills as rows in the file table is what this page used
 * to do, and it left the one thing that matters about a skill — whether it
 * loads — with nowhere to appear.
 *
 * Everything that touches the library lives here; the two views are presentation
 * and their own view-local state (search, expansion, confirmation).
 */
export function FilesPage() {
  const { t } = useTranslation();
  const [files, setFiles] = useState<FileMetadata[]>([]);
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  /** What a package offered, held until the user confirms a selection. */
  const [inspection, setInspection] = useState<SkillInspection | null>(null);
  /** True while the confirmed selection is being written. */
  const [isInstalling, setIsInstalling] = useState(false);
  const [githubOpen, setGithubOpen] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [tab, selectTab] = useFilesTab();

  /** One picker per import channel, so neither input has to be reconfigured. */
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const archiveInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const skillIndex = useSkillIndex();
  const skillRows = useMemo(() => buildSkillRows(skillIndex, files), [skillIndex, files]);
  const brokenSkills = skillRows.filter((row) =>
    row.diagnostics.some((diagnostic) => diagnostic.level === 'error'),
  ).length;

  /**
   * Dragging a row into the side panel only works while a panel is open, so the
   * rows stop advertising a gesture that would end nowhere. Presence that cannot
   * be detected leaves them draggable — a failed probe must not cost the feature.
   */
  const canDragToSidePanel = useSidePanelPresence() !== false;

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [fileList, conversationList] = await Promise.all([
        fileStorage.listFiles({ includeTemp: false }),
        // Summaries only — this view needs titles, never message bodies.
        listConversationMeta(),
      ]);
      setFiles(fileList);
      setConversations(conversationList);
    } catch (error) {
      console.error('Failed to load files:', error);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(timer);
  }, [notice]);

  const conversationTitle = useCallback(
    (conversationId?: string): string | null =>
      conversations.find((conversation) => conversation.id === conversationId)?.title || null,
    [conversations],
  );

  /**
   * Live updates from other contexts.
   *
   * The list was loaded once on mount, so a file an agent wrote after this tab
   * was opened never appeared. Reloads are silent: a full-list refresh must not
   * replace the table with a spinner while the user is reading it.
   */
  useEvent('files:changed', () => {
    void refresh(true);
  });

  // `/` focuses search, the way it does in every file tree worth using. Ignored
  // while typing elsewhere, so it never swallows a slash meant for a text field.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable === true;
      if (typing) return;
      event.preventDefault();
      searchInputRef.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  // ─── Library mutations ────────────────────────────────────────────────────

  /**
   * Delete a file, or a whole directory in one transaction.
   *
   * The row disappears immediately and the storage event reconciles the rest of
   * the page (counts, skill index), so a slow disk never leaves a dead row
   * looking clickable.
   */
  const handleDelete = useCallback(async (path: string) => {
    setDeleting(path);
    const prefix = path.endsWith('/') ? path : null;
    try {
      await fileStorage.deletePath(path);
      setFiles((previous) =>
        previous.filter((file) =>
          prefix ? !file.name.startsWith(prefix) : file.name !== path,
        ),
      );
    } catch (error) {
      console.error('Failed to delete:', path, error);
    } finally {
      setDeleting(null);
    }
  }, []);

  const handlePreview = useCallback((name: string) => {
    void openFilePreview(name).catch((error) => {
      console.error('Failed to open file preview:', error);
    });
  }, []);

  const handleDownload = useCallback(async (name: string) => {
    const blob = await fileStorage.readFileAsBlob(name);
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    // The stored path is the identity; the download keeps the bare file name.
    const filename = name.includes('/') ? name.split('/').pop()! : name;
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    // Revoked after a delay so the browser has time to start the download.
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }, []);

  const downloadZip = useCallback(
    async (key: string, prefix: string, zipName: string, members: FileMetadata[]) => {
      setDownloading(key);
      try {
        await downloadAsZip(
          members.map((file) => ({
            name: file.name,
            // Stripped so the archive root is the directory itself, the way
            // every archive of a folder looks.
            zipPath: file.name.startsWith(prefix) ? file.name.slice(prefix.length) : file.name,
          })),
          zipName,
        );
      } catch (error) {
        console.error('Failed to download as zip:', error);
      } finally {
        setDownloading(null);
      }
    },
    [],
  );

  const handleDownloadFolder = useCallback(
    (prefix: string, members: FileMetadata[]) => {
      const name = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
      void downloadZip(prefix, prefix, `${name.replace(/\//g, '_')}.zip`, members);
    },
    [downloadZip],
  );

  const handleDownloadSkill = useCallback(
    (row: SkillRow) => {
      const members = files.filter((file) => file.name.startsWith(row.dir));
      void downloadZip(row.dir, row.dir, `${row.name}.zip`, members);
    },
    [downloadZip, files],
  );

  const handleUpload = useCallback(async (picked: File[]) => {
    if (picked.length === 0) return;
    const written = await importTextFiles(picked);
    setNotice(
      written.length > 0 ? { kind: 'uploaded', count: written.length } : { kind: 'uploadRejected' },
    );
  }, []);

  /**
   * Open the review for what a package (or a repository) offered.
   *
   * Every channel ends here, so the rule holds for all of them: the package is
   * described first, and a selection is confirmed before anything reaches
   * storage. A package with no skill in it has nothing to review, so it reports
   * why instead.
   */
  const acceptInspection = useCallback((result: SkillInspection) => {
    if (result.candidates.length > 0) {
      setInspection(result);
      return;
    }
    console.error('[lumo] Skill package diagnostics:', result.diagnostics);
    setNotice({ kind: result.empty ? 'noManifest' : 'failed' });
  }, []);

  /** Read a local source (archive, folder, drop) and review what it holds. */
  const inspectSkills = useCallback(
    async (sources: SkillPackageSource[]) => {
      if (sources.length === 0) return;
      setIsImporting(true);
      try {
        acceptInspection(await inspectSkillPackages(sources));
      } catch (error) {
        console.error('Failed to read skill package:', error);
        setNotice({ kind: 'failed' });
      } finally {
        setIsImporting(false);
      }
    },
    [acceptInspection],
  );

  /**
   * Write the confirmed selection.
   *
   * `onConflict: 'replace'` is safe precisely because of the review: an
   * already-installed skill could only be selected on purpose, so replacing is
   * what that click asked for. Everything else has nothing to conflict with.
   */
  const installSelection = useCallback(async (selected: SkillCandidate[]) => {
    if (selected.length === 0) {
      setInspection(null);
      return;
    }
    setIsInstalling(true);
    try {
      const result = await installSkillCandidates(selected, { onConflict: 'replace' });
      const failed = result.diagnostics.some((diagnostic) => diagnostic.level === 'error');
      if (result.installed.length > 0) {
        setNotice({ kind: 'installed', count: result.installed.length });
      } else if (failed) {
        setNotice({ kind: 'failed' });
        console.error('[lumo] Skill install diagnostics:', result.diagnostics);
      } else {
        setNotice({ kind: 'skipped', count: result.skipped.length });
      }
    } catch (error) {
      console.error('Failed to install skills:', error);
      setNotice({ kind: 'failed' });
    } finally {
      setIsInstalling(false);
      setInspection(null);
    }
  }, []);

  // ─── Drag and drop ────────────────────────────────────────────────────────

  const handleDragOver = (event: React.DragEvent) => {
    if (!hasOsFiles(event.dataTransfer)) return;
    // Both events are cancelled: the spec accepts either, but only cancelling
    // `dragover` leaves Firefox refusing the drop.
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setIsDragOver(true);
  };

  const handleDragLeave = (event: React.DragEvent) => {
    // Only the pane's own boundary; crossing into a row is not a leave.
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setIsDragOver(false);
  };

  /**
   * A drop may hold documents, skill packages, or both.
   *
   * Directories are read through the entry API so their structure survives;
   * anything containing a `SKILL.md` is installed as a skill, and a directory of
   * ordinary documents keeps its paths instead of collapsing into bare file
   * names. A zip is always a package — refusal would be more surprising than
   * trying to read it.
   */
  const handleDrop = (event: React.DragEvent) => {
    if (!hasOsFiles(event.dataTransfer)) return;
    event.preventDefault();
    setIsDragOver(false);

    const dataTransfer = event.dataTransfer;
    void (async () => {
      const payload = await readDroppedFiles(dataTransfer);
      if (isEmptyDrop(payload)) return;

      const flatManifests = payload.flatFiles
        .filter((file) => file.name === SKILL_FILE_NAME)
        .map((file) => ({ path: file.name, file }));
      const packageEntries = [...payload.entries, ...flatManifests];
      const hasManifest = packageEntries.some(
        (entry) => baseName(entry.path) === SKILL_FILE_NAME,
      );

      const sources: SkillPackageSource[] = [
        ...payload.archives.map((archive) => zipPackageSource(archive, archive.name)),
        ...(hasManifest ? [directoryPackageSource(packageEntries, 'dropped files')] : []),
      ];
      if (sources.length > 0) {
        await inspectSkills(sources);
      }

      // Files the import did not consume. A directory with a manifest is a skill
      // and its files are already installed; anything else is a document.
      const documents = [
        ...(hasManifest
          ? payload.flatFiles.filter((file) => file.name !== SKILL_FILE_NAME)
          : payload.flatFiles),
        ...(hasManifest ? [] : payload.entries),
      ].map((item) =>
        'path' in item ? { name: item.path, file: item.file } : { name: item.name, file: item },
      );
      if (documents.length > 0) {
        void importFileEntries(documents);
      }
    })();
  };

  const noticeText = (() => {
    if (!notice) return null;
    switch (notice.kind) {
      case 'installed':
        return t('skills.import.installed', { count: notice.count });
      case 'skipped':
        return t('skills.import.skipped', { count: notice.count });
      case 'failed':
        return t('skills.import.failed');
      case 'noManifest':
        return t('skills.import.noManifest');
      case 'uploaded':
        return t('options.files.uploaded', { count: notice.count });
      case 'uploadRejected':
        return t('options.files.uploadRejected');
    }
  })();

  const noticeIsError =
    notice?.kind === 'failed' || notice?.kind === 'noManifest' || notice?.kind === 'uploadRejected';

  return (
    <div
      className="min-h-full"
      onDragEnter={handleDragOver}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div
        className={`max-w-2xl rounded-lg ${
          isDragOver ? 'outline-2 outline-dashed outline-offset-4 outline-chat-user/60' : ''
        }`}
      >
        <SettingsHeader
          title={t('options.files.title')}
          description={t('options.files.description')}
        />

        <Tabs value={tab} onValueChange={(value) => selectTab(value as FilesTab)}>
          {/* One toolbar per view: the tabs say what is being browsed, the
              right-hand cluster holds the actions *for that view only*. An
              import control on the files tab would be a second place for the
              same act, which is how a page starts to feel ambiguous. */}
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <TabsList>
              <TabsTrigger value="files">
                {t('options.nav.files')}
                <span className="text-xs tabular-nums text-muted-foreground">{files.length}</span>
              </TabsTrigger>
              <TabsTrigger value="skills">
                {t('options.files.tabs.skills')}
                <span className="text-xs tabular-nums text-muted-foreground">
                  {skillRows.length}
                </span>
              </TabsTrigger>
            </TabsList>

            <div className="ms-auto flex items-center gap-2">
              {tab === 'files' ? (
                <>
                  <div className="relative">
                    <Search className="pointer-events-none absolute inset-y-0 start-3 my-auto h-4 w-4 text-muted-foreground/60" />
                    <Input
                      ref={searchInputRef}
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          setQuery('');
                          event.currentTarget.blur();
                        }
                      }}
                      placeholder={t('options.files.search')}
                      aria-label={t('options.files.search')}
                      className="h-9 w-40 ps-9 pe-8 sm:w-56"
                    />
                    {query !== '' && (
                      <button
                        type="button"
                        onClick={() => setQuery('')}
                        aria-label={t('common.close')}
                        className="absolute inset-y-0 end-2 my-auto flex h-5 w-5 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => uploadInputRef.current?.click()}
                  >
                    <Upload className="h-4 w-4" />
                    <span>{t('options.files.upload')}</span>
                  </Button>
                </>
              ) : (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      disabled={isImporting}
                      title={t('skills.import.button')}
                      aria-busy={isImporting}
                    >
                      {isImporting ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Upload className="h-4 w-4" />
                      )}
                      <span>{t('skills.import.button')}</span>
                      {/* The same affordance the language picker uses: a menu
                          trigger says so without a second label. */}
                      <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    <DropdownMenuItem onSelect={() => archiveInputRef.current?.click()}>
                      <FileArchive />
                      {t('skills.import.fromArchive')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => folderInputRef.current?.click()}>
                      <FolderUp />
                      {t('skills.import.fromFolder')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setGithubOpen(true)}>
                      <GitBranch />
                      {t('skills.import.fromGitHub')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          </div>

          {noticeText && (
            <p
              role="status"
              className={`mb-3 text-xs ${noticeIsError ? 'text-destructive' : 'text-muted-foreground'}`}
            >
              {noticeText}
            </p>
          )}

          <TabsContent value="files">
            <FileListView
              files={files}
              query={query}
              loading={loading}
              canDragToSidePanel={canDragToSidePanel}
              deleting={deleting}
              downloading={downloading}
              conversationTitle={conversationTitle}
              onPreview={handlePreview}
              onDownload={handleDownload}
              onDownloadFolder={handleDownloadFolder}
              onDelete={handleDelete}
            />
          </TabsContent>

          <TabsContent value="skills">
            <SkillListView
              rows={skillRows}
              loading={loading}
              brokenCount={brokenSkills}
              deleting={deleting}
              downloading={downloading}
              onDelete={(row) => void handleDelete(row.dir)}
              onDownload={handleDownloadSkill}
              onOpen={(row) => {
                const manifest = skillManifestPath(row);
                if (manifest) handlePreview(manifest);
              }}
            />
          </TabsContent>
        </Tabs>

        {/* Pickers live outside the views: a tab switch must not reset them. */}
        <input
          ref={uploadInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            const picked = Array.from(event.target.files ?? []);
            // Clear first: picking the same file twice must upload twice.
            event.target.value = '';
            void handleUpload(picked);
          }}
        />
        <input
          ref={archiveInputRef}
          type="file"
          accept=".zip,application/zip"
          multiple
          className="hidden"
          onChange={(event) => {
            const archives = Array.from(event.target.files ?? []);
            event.target.value = '';
            if (archives.length === 0) return;
            void inspectSkills(archives.map((archive) => zipPackageSource(archive, archive.name)));
          }}
        />
        <input
          ref={folderInputRef}
          type="file"
          multiple
          className="hidden"
          {...DIRECTORY_PICKER_ATTRIBUTE}
          onChange={(event) => {
            const picked = directoryEntriesFromFiles(Array.from(event.target.files ?? []));
            event.target.value = '';
            if (picked.length === 0) return;
            // The chosen folder's name is the package root, which is what makes
            // the diagnostic name the folder the user actually picked.
            const label = picked[0]?.path.split('/')[0] || 'folder';
            void inspectSkills([directoryPackageSource(picked, label)]);
          }}
        />

        <GitHubImportDialog
          open={githubOpen}
          onClose={() => setGithubOpen(false)}
          onPrepared={acceptInspection}
        />

        <SkillImportDialog
          inspection={inspection}
          importing={isInstalling}
          onCancel={() => setInspection(null)}
          onConfirm={(selected) => void installSelection(selected)}
        />
      </div>
    </div>
  );
}
