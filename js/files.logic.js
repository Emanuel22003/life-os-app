// LIFE/OS — pictures in a task's page: the pure part (unit-tested in jsc). js/files.js keeps them.
//
// A picture stays on the device it was added on (the browser's IndexedDB: local storage is far
// too small for pictures, and Sync only carries text). The page's text points at it with
// ![caption](lifeos-img:<id>), so the text syncs like any other and another device can say
// where the picture is instead of showing a broken one.

/** The longest side a picture is kept at: sharp on any screen, a few hundred KB at most. */
export const MAX_SIDE = 1600;

export const IMAGE_SCHEME = 'lifeos-img:';

/** Ids written into a page: what uid() makes, and nothing that could end the markup. */
export const IMAGE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Picture types the browsers LIFE/OS runs in can read. No SVG: it can carry code. */
export const IMAGE_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/bmp']);

export function isImageType(type) {
  return IMAGE_TYPES.includes(String(type ?? '').toLowerCase());
}

/** { width, height } scaled down to fit `max` on its longest side (never up), in whole pixels. */
export function fitWithin(width, height, max = MAX_SIDE) {
  const w = Math.max(1, Math.round(Number(width) || 1));
  const h = Math.max(1, Math.round(Number(height) || 1));
  const scale = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/**
 * A file name as the picture's caption: no extension, nothing that would end the markup, at most
 * 60 characters. A pasted screenshot is called "image.png" by every browser: no caption then.
 */
export function imageCaption(fileName) {
  const base = String(fileName ?? '')
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[[\]()\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .trim();
  return /^image$/i.test(base) ? '' : base;
}

/** The page's markup for picture `id` (null for an id that isn't one). */
export function imageMarkup(id, caption = '') {
  if (!IMAGE_ID.test(String(id ?? ''))) return null;
  return `![${imageCaption(caption)}](${IMAGE_SCHEME}${id})`;
}
