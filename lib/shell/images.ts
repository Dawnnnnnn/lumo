/**
 * Move tool-produced images out of the JSON bridge and into the shared VFS.
 *
 * A screenshot is megabytes of base64. Both shell invocations that can receive
 * one — `mcp call` and `await tools.<server>.<tool>()` inside `node` — must write
 * it to `tmp/` and replace the payload with a path, or a single call doubles the
 * size of every bridge payload it crosses. Keeping the policy here (rather than
 * once per command) is also what makes the two surfaces agree on the filename,
 * on which formats are attached to the model, and on what the model sees.
 */

import { bytesFromBase64 } from '@/lib/encoding';
import { IMAGE_EXTENSIONS, isVisionImageType } from '@/lib/mcp/image-types';
import { isImagePart, isTextPart, type ToolContentPart } from '@/lib/tools/gateway';
import { TMP_DIR } from './vfs';

/** Minimal filesystem surface the spill needs, so the helper stays testable. */
export interface ImageFileSystem {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
  writeFile(path: string, content: Uint8Array): Promise<unknown>;
}

export interface ShellAttachment {
  /** VFS path, e.g. `/tmp/mcp-1710000000-0.png`. */
  path: string;
  mimeType: string;
  /** Base64 payload, for model-visible image parts. */
  data: string;
}

/** An image already written to `tmp/`, in content order. */
export interface SpilledImage {
  path: string;
  mimeType: string;
  data: string;
  /** Whether it can be sent to the model as an image block. */
  attached: boolean;
}

/**
 * Monotonic suffix for image names.
 *
 * `Date.now()` alone collides when a script fans out into several tools in the
 * same millisecond; the second write would then silently replace the first image
 * and both results would point at the same path.
 */
let imageCounter = 0;

function imageExtension(mimeType: string): string {
  return (
    IMAGE_EXTENSIONS[mimeType] ?? mimeType.split('/')[1]?.replace(/[^a-z0-9]/gi, '')
  ) || 'img';
}

export async function materializeToolImages(
  fs: ImageFileSystem,
  content: ToolContentPart[],
  { attach }: { attach: boolean },
): Promise<{ content: ToolContentPart[]; images: SpilledImage[]; attachments: ShellAttachment[] }> {
  const images: SpilledImage[] = [];
  const next: ToolContentPart[] = [];

  for (const part of content) {
    if (!isImagePart(part) || typeof part.data !== 'string') {
      next.push(part);
      continue;
    }

    const mimeType = part.mimeType || 'image/png';
    imageCounter += 1;
    const name = `mcp-${Date.now()}-${imageCounter}.${imageExtension(mimeType)}`;
    const path = `/${TMP_DIR}/${name}`;
    try {
      await fs.mkdir(`/${TMP_DIR}`, { recursive: true });
      // A missing `tmp/` is recoverable; an image the model never sees is not.
      await fs.writeFile(path, bytesFromBase64(part.data));
    } catch {
      // Writing failed (quota, torn-down context): keep the inline payload so
      // the image is not silently lost from the result.
      next.push(part);
      continue;
    }

    const attached = isVisionImageType(mimeType);
    images.push({ path, mimeType, data: part.data, attached });
    next.push({ type: 'image', path, mimeType });
  }

  return {
    content: next,
    images,
    attachments: attach
      ? images
          .filter((image) => image.attached)
          .map(({ path, mimeType, data }) => ({ path, mimeType, data }))
      : [],
  };
}

/** Text of a normalized result, with image parts rendered as their VFS path. */
export function textOfContent(content: ToolContentPart[]): string {
  const parts: string[] = [];
  for (const part of content) {
    if (isTextPart(part)) parts.push(part.text);
    else if (isImagePart(part) && typeof part.path === 'string') parts.push(`[image] ${part.path}`);
  }
  return parts.join('\n');
}
