/**
 * Which image MIME types can be sent to the model as image blocks.
 *
 * Both `file_read` and the shell's `mcp call` decide whether to attach an image
 * or merely report its path, so the list lives here instead of in each caller:
 * a type that one attaches and the other does not would make the same
 * screenshot visible or invisible depending on how it was reached.
 *
 * SVG is deliberately excluded — it is text, so returning its source is more
 * useful than an `image/svg+xml` block, which the provider APIs reject.
 */
export const VISION_IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
]);

export function isVisionImageType(mimeType: string): boolean {
  return VISION_IMAGE_TYPES.has(mimeType);
}

/** File extension for an image MIME type when writing it into the VFS. */
export const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
};
