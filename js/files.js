// LIFE/OS — pictures added to a task's page, kept on this device in IndexedDB (database
// "lifeos-files", store "images": { id, blob, type, width, height, createdAt }). They never
// sync: the page's text names them (js/files.logic.js) and only this device can show them.
// Settings → Delete all my data removes the database with everything else (deleteAllFiles).

import { uid } from './ui.js';
import { fitWithin, isImageType, MAX_SIDE, IMAGE_ID } from './files.logic.js';

export const FILES_DB = 'lifeos-files';
const STORE = 'images';
const QUALITY = 0.85;

let dbPromise = null;
// id -> object URL, so a page that redraws shows a picture again without reading it again
const urls = new Map();

function openDb() {
  if (!globalThis.indexedDB) return Promise.reject(new Error('This browser can’t keep pictures.'));
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(FILES_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const db = req.result;
      // Delete all my data (here or in another window) needs the database closed
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error ?? new Error('Pictures can’t be opened.'));
    };
  });
  return dbPromise;
}

async function run(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error ?? new Error('Pictures can’t be saved.'));
    tx.onabort = () => reject(tx.error ?? new Error('Pictures can’t be saved.'));
  });
}

/** Encode a canvas (or OffscreenCanvas) as WebP, else JPEG where WebP can't be made. */
async function encode(canvas, type) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality: QUALITY });
  return new Promise((resolve) => canvas.toBlob(resolve, type, QUALITY));
}

/**
 * A picture file shrunk to MAX_SIDE on its longest side and re-encoded (photos straight off a
 * phone are 3–12 MB; kept like this they are a few hundred KB). -> { blob, width, height }
 */
async function shrink(file) {
  const bmp = await createImageBitmap(file);
  try {
    const { width, height } = fitWithin(bmp.width, bmp.height, MAX_SIDE);
    // Small enough already, in a format every browser shows: keep the file as it is
    if (width === bmp.width && (file.type === 'image/jpeg' || file.type === 'image/webp' || file.type === 'image/png') && file.size < 600_000) {
      return { blob: file, width, height };
    }
    const canvas = globalThis.OffscreenCanvas ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, width, height);
    let blob = await encode(canvas, 'image/webp');
    if (!blob || blob.type !== 'image/webp') blob = await encode(canvas, 'image/jpeg');
    if (!blob) throw new Error('That picture can’t be read here.');
    return { blob, width, height };
  } finally {
    bmp.close?.();
  }
}

/** Keep picture `file` on this device. -> { id, width, height } (rejects with a sentence to show) */
export async function saveImage(file) {
  if (!file || !isImageType(file.type)) throw new Error('Only pictures can go in here (PNG, JPEG, WebP, GIF).');
  let shrunk;
  try {
    shrunk = await shrink(file);
  } catch {
    throw new Error('That picture can’t be read here.');
  }
  const id = uid().replace(/[^A-Za-z0-9_-]/g, '');
  const record = { id, blob: shrunk.blob, type: shrunk.blob.type || file.type, width: shrunk.width, height: shrunk.height, createdAt: Date.now() };
  try {
    await run('readwrite', (s) => s.put(record));
  } catch {
    throw new Error('There is no room left on this device for the picture.');
  }
  return { id, width: shrunk.width, height: shrunk.height };
}

/** An object URL for picture `id`, or null when this device doesn't have it. */
export async function imageUrl(id) {
  if (!IMAGE_ID.test(String(id ?? ''))) return null;
  if (urls.has(id)) return urls.get(id);
  let record = null;
  try {
    record = await run('readonly', (s) => s.get(id));
  } catch {
    return null;
  }
  if (!record?.blob) return null;
  const url = URL.createObjectURL(record.blob);
  urls.set(id, url);
  return url;
}

/** Settings → Delete all my data: the whole picture database goes. Never rejects. */
export async function deleteAllFiles() {
  urls.forEach((url) => URL.revokeObjectURL(url));
  urls.clear();
  try {
    (await dbPromise)?.close();
  } catch {}
  dbPromise = null;
  if (!globalThis.indexedDB) return;
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(FILES_DB);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}
