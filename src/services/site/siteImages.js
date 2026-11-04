// siteImages.js — the website images the owner can replace (dashboard Owner → Website → Images):
// the slots, the upload check + re-encode, the store (table site_images, schema v10) and the
// in-memory copy the site serves from.
//
// A slot is an image the site already uses at a fixed public path (/img/<file>); an uploaded
// image is served at that same path, else the file in static/img. Images live in the database
// because Replit's disk is wiped on every redeploy. The server-cat pictures (/img/cat) are data,
// not slots.
//
// Upload rules: PNG, JPEG or WebP judged by the first bytes, at most 2 MB, at most 4000×4000
// (read from the header before decoding, so a small file cannot unpack into a huge bitmap).
// Every upload is decoded and RE-ENCODED (WebP for the screenshots, PNG for the share image and
// the logo), so metadata (EXIF, location) and anything hidden in the file is dropped. The result
// always has the slot's exact size (the pages and the share tags state it): the image is
// centre-cropped to the slot's shape and scaled. More than 10% off the shape, or smaller than the
// slot, is allowed with a warning; the owner can reset to the default at any time.

import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { query as dbQuery } from '../enforcement/db.js';
import { pgConfig } from '../../config/database/postgres.js';
import { logger } from '../../utils/logger.js';
import { InputError } from '../dashboard/forms.js';
import { sniffImage } from '../dashboard/multipart.js';

export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const IMAGE_MAX_SIDE = 4000;
export const ASPECT_TOLERANCE = 0.10;
export const SLOT_CACHE_CONTROL = 'public, max-age=300';
const ACCEPTED = new Set(['image/png', 'image/jpeg', 'image/webp']);
const STATIC_DIR = new URL('./static/img/', import.meta.url);

const slot = (name, file, label, where, width, height, mime) => Object.freeze({
    slot: name, file, label, where, width, height, mime, path: `/img/${file}`, filePath: fileURLToPath(new URL(file, STATIC_DIR)),
});

/** The replaceable images, in the order the editor lists them. */
export const SITE_IMAGE_SLOTS = Object.freeze([
    slot('screen-overview-dark', 'screen-overview-dark.webp', 'Dashboard screenshot: overview (dark)', 'Front page, "The dashboard" section', 1280, 800, 'image/webp'),
    slot('screen-overview-light', 'screen-overview-light.webp', 'Dashboard screenshot: overview (light)', 'Served at its path; no page shows it today', 1280, 800, 'image/webp'),
    slot('screen-cases-dark', 'screen-cases-dark.webp', 'Dashboard screenshot: cases (dark)', 'Docs: "Using the dashboard"', 1280, 800, 'image/webp'),
    slot('screen-cases-light', 'screen-cases-light.webp', 'Dashboard screenshot: cases (light)', 'Served at its path; no page shows it today', 1280, 800, 'image/webp'),
    slot('og', 'og.png', 'Share image', 'Link previews (Discord, social media) of every page', 1200, 630, 'image/png'),
    slot('logo', 'logo.png', 'Logo and browser-tab icon', 'Top bar of the site, favicon, dashboard sidebar', 64, 64, 'image/png'),
]);
const BY_SLOT = new Map(SITE_IMAGE_SLOTS.map((s) => [s.slot, s]));
const BY_FILE = new Map(SITE_IMAGE_SLOTS.map((s) => [s.file, s]));

export const slotDef = (name) => BY_SLOT.get(String(name)) || null;
export const slotByFile = (file) => BY_FILE.get(String(file)) || null;

// ── Header sizes (before any decoding) ───────────────────────────────────

/** { width, height } from a PNG / JPEG / WebP header, or null when it cannot be read. */
export function imageDimensions(data, type) {
    try {
        if (type === 'image/png') {
            if (data.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
            return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
        }
        if (type === 'image/webp') {
            const chunk = data.subarray(12, 16).toString('latin1');
            if (chunk === 'VP8 ') return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
            if (chunk === 'VP8L') {
                const bits = data.readUInt32LE(21);
                return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
            }
            if (chunk === 'VP8X') return { width: 1 + data.readUIntLE(24, 3), height: 1 + data.readUIntLE(27, 3) };
            return null;
        }
        if (type === 'image/jpeg') {
            let i = 2;
            while (i + 9 < data.length) {
                if (data[i] !== 0xff) return null;
                const marker = data[i + 1];
                if (marker === 0xff) { i += 1; continue; }
                if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
                if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
                    return { width: data.readUInt16BE(i + 7), height: data.readUInt16BE(i + 5) };
                }
                i += 2 + data.readUInt16BE(i + 2);
            }
            return null;
        }
    } catch {
        return null;
    }
    return null;
}

let canvasModule = null;
const loadCanvas = () => (canvasModule ??= import('@napi-rs/canvas'));

/**
 * Checks and re-encodes an upload for a slot. Returns { bytes, mime, width, height, sha256,
 * warnings, source: { type, width, height } }. Throws InputError for anything refused.
 */
export async function prepareSiteImage(def, data, { canvas = loadCanvas } = {}) {
    if (!def) throw new InputError('Unknown image.');
    if (!Buffer.isBuffer(data) || !data.length) throw new InputError('Choose an image file to upload.');
    if (data.length > IMAGE_MAX_BYTES) throw new InputError('The image is larger than 2 MB.');
    const kind = sniffImage(data);
    if (!kind || !ACCEPTED.has(kind.type)) throw new InputError('Only PNG, JPEG or WebP images are accepted.');
    const size = imageDimensions(data, kind.type);
    if (!size || !size.width || !size.height) throw new InputError('The image could not be read (damaged file?).');
    if (size.width > IMAGE_MAX_SIDE || size.height > IMAGE_MAX_SIDE) throw new InputError(`The image is too large: at most ${IMAGE_MAX_SIDE}×${IMAGE_MAX_SIDE} pixels (this one is ${size.width}×${size.height}).`);
    const { createCanvas, loadImage } = await canvas();
    let image;
    try {
        image = await loadImage(data);
    } catch {
        throw new InputError('The image could not be read (damaged file?).');
    }
    const w = image.width;
    const h = image.height;
    if (!w || !h || w > IMAGE_MAX_SIDE || h > IMAGE_MAX_SIDE) throw new InputError('The image could not be read (damaged file?).');
    const warnings = [];
    const target = def.width / def.height;
    const ratio = w / h;
    if (Math.abs(ratio / target - 1) > ASPECT_TOLERANCE) {
        warnings.push(`The image is ${w}×${h}; this slot is ${def.width}×${def.height}, so the edges were cropped to fit. Upload an image in that shape to avoid cropping.`);
    }
    if (w < def.width || h < def.height) warnings.push(`The image is smaller than ${def.width}×${def.height}; it was enlarged and may look blurry.`);
    // Centre crop to the slot's shape, then scale to its exact size.
    let sw = w;
    let sh = h;
    if (ratio > target) sw = Math.round(h * target);
    else sh = Math.round(w / target);
    const sx = Math.floor((w - sw) / 2);
    const sy = Math.floor((h - sh) / 2);
    const out = createCanvas(def.width, def.height);
    const ctx = out.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, sx, sy, sw, sh, 0, 0, def.width, def.height);
    const bytes = Buffer.from(def.mime === 'image/webp' ? await out.encode('webp', 88) : await out.encode('png'));
    if (bytes.length > IMAGE_MAX_BYTES) throw new InputError('After converting, the image is still larger than 2 MB. Use a simpler image.');
    return {
        bytes, mime: def.mime, width: def.width, height: def.height, sha256: createHash('sha256').update(bytes).digest('hex'),
        warnings, source: { type: kind.type, width: w, height: h },
    };
}

// ── Store ────────────────────────────────────────────────────────────────

const META = 'slot, mime, width, height, sha256, updated_by, updated_at';

export function createSiteImageStore({ query = dbQuery, table = pgConfig.tables.site_images } = {}) {
    async function listAll() {
        const { rows } = await query(`SELECT ${META}, bytes FROM ${table}`);
        return rows;
    }

    /** Saves (replaces) a slot's image: { row (without bytes), oldSha256 (null = it was the default file) }. */
    async function save({ slot: name, mime, width, height, bytes, sha256, userId }) {
        const { rows: [row] } = await query(
            `WITH old AS (SELECT sha256 FROM ${table} WHERE slot = $1)
             INSERT INTO ${table} (slot, mime, width, height, bytes, sha256, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (slot) DO UPDATE SET mime = EXCLUDED.mime, width = EXCLUDED.width, height = EXCLUDED.height,
                 bytes = EXCLUDED.bytes, sha256 = EXCLUDED.sha256, updated_by = EXCLUDED.updated_by, updated_at = NOW()
             RETURNING ${META}, (SELECT sha256 FROM old) AS old_sha256`,
            [name, mime, width, height, bytes, sha256, String(userId)]);
        if (!row) throw new Error('site_images save returned no row');
        const { old_sha256: oldSha256, ...meta } = row;
        return { row: meta, oldSha256: oldSha256 ?? null };
    }

    /** Back to the default file: { removed, oldSha256 }. */
    async function remove(name) {
        const { rows } = await query(`DELETE FROM ${table} WHERE slot = $1 RETURNING sha256`, [name]);
        return { removed: rows.length > 0, oldSha256: rows[0]?.sha256 ?? null };
    }

    return { listAll, save, remove };
}

export const siteImageStore = createSiteImageStore();

// ── The in-memory copy ───────────────────────────────────────────────────

let images = new Map();
let imagesLoaded = false;

/** False after a failed load at startup: the editor then retries before showing anything. */
export const isSiteImagesLoaded = () => imagesLoaded;

/** The uploaded image of a slot ({ slot, mime, width, height, bytes, sha256, updated_by, updated_at }) or null. */
export const uploadedImage = (name) => images.get(String(name)) || null;

export function setUploadedImage(row) {
    if (!slotDef(row?.slot) || !Buffer.isBuffer(row.bytes)) return;
    images.set(row.slot, { ...row });
}

export function clearUploadedImage(name) {
    images.delete(String(name));
}

/** For tests: forget every uploaded image. */
export function resetUploadedImagesForTest() {
    images = new Map();
    imagesLoaded = true;
}

/** Startup: every uploaded image into memory. A DB error is logged; the site serves the files. */
export async function loadSiteImages(store = siteImageStore) {
    try {
        const rows = await store.listAll();
        const next = new Map();
        for (const row of rows) if (slotDef(row.slot) && Buffer.isBuffer(row.bytes)) next.set(row.slot, { ...row });
        images = next;
        imagesLoaded = true;
        logger.info(`Website images: ${next.size} replaced image(s) loaded`);
        return next.size;
    } catch (error) {
        imagesLoaded = false;
        logger.error(`Website images not loaded (site uses the default files): ${error.message}`);
        return null;
    }
}

// ── Serving ──────────────────────────────────────────────────────────────

/** Sends an uploaded image with its sha256 as ETag (a matching If-None-Match gets 304). */
function sendUploaded(req, res, image) {
    res.set('Cache-Control', SLOT_CACHE_CONTROL);
    res.set('ETag', `"${image.sha256}"`);
    res.status(200).type(image.mime).send(image.bytes);
}

/** Middleware on /img: a slot with an uploaded image is answered from memory; anything else passes on. */
export function serveSlotImage(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const file = String(req.path || '').replace(/^\//, '');
    const def = slotByFile(file);
    const image = def ? uploadedImage(def.slot) : null;
    if (!image) return next();
    return sendUploaded(req, res, image);
}

/** For express.static's setHeaders: slot files are cached 5 minutes (they can be replaced), others a week. */
export function staticImageCacheControl(filePath) {
    const name = String(filePath).split(/[\\/]/).pop();
    return slotByFile(name) ? SLOT_CACHE_CONTROL : 'public, max-age=604800';
}

/** The favicon route: the uploaded logo when there is one, else null (the caller sends the file). */
export function serveUploadedLogo(req, res) {
    const image = uploadedImage('logo');
    if (!image) return false;
    sendUploaded(req, res, image);
    return true;
}
