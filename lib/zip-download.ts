/**
 * Zip download utility.
 *
 * Bundles multiple files (from IndexedDB) into a zip archive and triggers
 * a browser download via chrome.downloads or fallback <a> element.
 */
import { zipSync, strToU8 } from 'fflate';
import { fileStorage } from '@/lib/mcp/file-storage';

export interface ZipFileEntry {
  /** Full file name (used as path inside the zip) */
  name: string;
  /** Optional: override the path inside zip (strip prefix, etc.) */
  zipPath?: string;
}

/**
 * Save a Blob through the browser's download machinery.
 *
 * UI pages get an `<a download>` rather than `chrome.downloads`: the anchor works
 * without the `downloads` permission and keeps the blob URL in the page that
 * created it. A service worker has no `document`, so it falls back to
 * `chrome.downloads.download`.
 */
export async function downloadBlob(blob: Blob, filename: string): Promise<void> {
  const url = URL.createObjectURL(blob);

  if (typeof document !== 'undefined') {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } else {
    await chrome.downloads.download({ url, filename, saveAs: false });
  }

  // Revoke after delay to allow download to start.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/**
 * Bundle multiple files from extension storage into a zip and trigger download.
 *
 * @param files - List of file entries to include
 * @param zipName - Name of the output zip file (e.g. "folder.zip")
 * @returns Object with success status and details
 */
export async function downloadAsZip(
  files: ZipFileEntry[],
  zipName: string,
): Promise<{ success: boolean; totalFiles: number; failedFiles: string[] }> {
  const zipData: Record<string, Uint8Array> = {};
  const failedFiles: string[] = [];

  for (const entry of files) {
    const blob = await fileStorage.readFileAsBlob(entry.name);
    if (!blob) {
      failedFiles.push(entry.name);
      continue;
    }

    const arrayBuffer = await blob.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuffer);
    const pathInZip = entry.zipPath ?? entry.name;
    zipData[pathInZip] = uint8;
  }

  if (Object.keys(zipData).length === 0) {
    return { success: false, totalFiles: 0, failedFiles };
  }

  // Create zip synchronously (fflate's zipSync is fast for reasonable file sizes)
  const zipped = zipSync(zipData, { level: 6 });
  await downloadBlob(new Blob([zipped], { type: 'application/zip' }), zipName);

  return {
    success: true,
    totalFiles: Object.keys(zipData).length,
    failedFiles,
  };
}

/**
 * Create a zip Blob from file entries (without triggering download).
 * Useful for MCP tools that need more control over the download process.
 */
export async function createZipBlob(
  files: ZipFileEntry[],
): Promise<{ blob: Blob; includedFiles: string[]; failedFiles: string[] }> {
  const zipData: Record<string, Uint8Array> = {};
  const includedFiles: string[] = [];
  const failedFiles: string[] = [];

  for (const entry of files) {
    const blob = await fileStorage.readFileAsBlob(entry.name);
    if (!blob) {
      failedFiles.push(entry.name);
      continue;
    }

    const arrayBuffer = await blob.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuffer);
    const pathInZip = entry.zipPath ?? entry.name;
    zipData[pathInZip] = uint8;
    includedFiles.push(entry.name);
  }

  const zipped = zipSync(zipData, { level: 6 });
  const blob = new Blob([zipped], { type: 'application/zip' });

  return { blob, includedFiles, failedFiles };
}
