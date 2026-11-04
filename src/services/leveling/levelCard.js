// levelCard.js — the level-up / rank image card (PNG) drawn with @napi-rs/canvas.
// Shows the avatar, the member's name, the level, a progress bar to the next level and the
// server name. The font is bundled (assets/fonts/Inter-Bold.ttf, SIL OFL 1.1) and registered
// once. The avatar comes from Discord's CDN only, with a timeout and a size cap; on any avatar
// problem a placeholder circle is drawn. Callers use tryLevelCard(), which never throws and
// returns null when the card can't be made (busy, font or render error), so the caller falls
// back to the text line. At most MAX_CONCURRENT cards are made at once. The canvas library
// is imported on first use, so a broken native binary only disables the card.

import { fileURLToPath } from 'node:url';
import { logger } from '../../utils/logger.js';
import { EMBED_COLOURS, parseHexColour } from '../botMessageService.js';

export const CARD_WIDTH = 800;
export const CARD_HEIGHT = 240;
export const MAX_CONCURRENT = 2;
export const AVATAR_TIMEOUT_MS = 1500;
export const AVATAR_MAX_BYTES = 512 * 1024;
export const CARD_FILE_NAME = 'level-card.png';
export const DEFAULT_CARD_ACCENT = EMBED_COLOURS[0][2];
const AVATAR_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
const FONT = 'MewvoCardInter';
const FONT_PATH = fileURLToPath(new URL('../../../assets/fonts/Inter-Bold.ttf', import.meta.url));
const MAX_LEVEL = 1000;

const COLOURS = { bg: '#1E1F24', panel: '#2A2C33', track: '#3A3D46', text: '#FFFFFF', muted: '#B5BAC1' };

let canvasModule = null;
let fontReady = null;

/**
 * The canvas library, loaded on first use: if its native binary can't load on this machine,
 * only the card is lost (null), never the modules that import this file.
 */
async function loadCanvas() {
    canvasModule ??= import('@napi-rs/canvas').catch((error) => {
        logger.warn(`Level card library could not be loaded: ${error.message}`);
        return null;
    });
    return canvasModule;
}

/** Loads the canvas library and registers the bundled font once; later calls reuse the result. */
export async function ensureCardFont() {
    const lib = await loadCanvas();
    if (!lib) return null;
    if (fontReady === null) {
        try {
            fontReady = lib.GlobalFonts.registerFromPath(FONT_PATH, FONT) !== null;
        } catch {
            fontReady = false;
        }
        if (!fontReady) logger.warn(`Level card font could not be loaded from ${FONT_PATH}`);
    }
    return fontReady ? lib : null;
}

/** A stored accent ('#RRGGBB') → '#RRGGBB'; anything else → Mewvo blue. */
export function cardAccentOf(value) {
    const n = parseHexColour(value);
    return n === null ? DEFAULT_CARD_ACCENT : `#${n.toString(16).padStart(6, '0').toUpperCase()}`;
}

// Emoji, joiners, variation selectors and control characters: the bundled font has no glyphs
// for them, so they would draw as boxes.
const UNDRAWABLE = new RegExp('[\\p{Extended_Pictographic}\\p{Regional_Indicator}\\u{1F3FB}-\\u{1F3FF}\\u200B-\\u200F\\u2028-\\u202E\\u2060-\\u206F\\uFE00-\\uFE0F\\u{E0000}-\\u{E007F}\\p{Cc}]', 'gu');

// Scripts the bundled Inter font covers (Latin, Greek, Cyrillic, combining marks) plus common
// punctuation, digits and currency signs. Anything else (CJK, Arabic, Hangul, Devanagari,
// symbols like ★) has no glyph and would draw as a "NO GLYPH" box, so it is left out.
const NOT_IN_FONT = new RegExp('[^\\p{Script=Latin}\\p{Script=Greek}\\p{Script=Cyrillic}\\p{Script=Inherited}\\u0020-\\u007E\\u00A0-\\u00BF\\u00D7\\u00F7\\u2010-\\u205E\\u20A0-\\u20BF\\s]|[\\uFF00-\\uFFEF]', 'gu');

/** The text we can draw: no emoji, control characters or letters the font lacks, single spaces, trimmed. */
export function drawableText(value, fallback = '') {
    const cleaned = String(value ?? '').replace(UNDRAWABLE, '').replace(NOT_IN_FONT, '').replace(/\s+/g, ' ').trim();
    return cleaned || fallback;
}

function fitText(ctx, value, maxWidth) {
    if (ctx.measureText(value).width <= maxWidth) return value;
    const chars = Array.from(value);
    let lo = 0;
    let hi = chars.length;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (ctx.measureText(`${chars.slice(0, mid).join('').trimEnd()}...`).width <= maxWidth) lo = mid;
        else hi = mid - 1;
    }
    return `${chars.slice(0, lo).join('').trimEnd()}...`;
}

function roundRect(ctx, x, y, w, h, r) {
    const radius = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
}

async function decodeAvatar(loadImage, avatar) {
    if (!avatar || !Buffer.isBuffer(avatar) || avatar.length === 0 || avatar.length > AVATAR_MAX_BYTES) return null;
    try {
        return await loadImage(avatar);
    } catch {
        return null;
    }
}

/**
 * Draws the card and returns PNG bytes. Throws on a font or render failure (use tryLevelCard
 * in bot code). `avatar` is image bytes or null (placeholder circle). `altName` is used
 * when no character of `name` can be drawn.
 */
export async function renderLevelCard({ name, altName = null, serverName, level, xp, xpNeeded, accent, avatar = null }) {
    const lib = await ensureCardFont();
    if (!lib) throw new Error('Level card library or font is not available');
    const { createCanvas, loadImage } = lib;
    const accentHex = cardAccentOf(accent);
    const lvl = Number.isInteger(level) && level >= 0 ? Math.min(level, MAX_LEVEL) : 0;
    const atMax = lvl >= MAX_LEVEL;
    const need = Number.isFinite(xpNeeded) && xpNeeded > 0 ? Math.floor(xpNeeded) : 0;
    const have = Number.isFinite(xp) && xp > 0 ? Math.floor(xp) : 0;
    const ratio = atMax ? 1 : (need > 0 ? Math.min(1, have / need) : 0);
    // altName (the username) when nothing of the display name can be drawn (e.g. all CJK).
    // (Punctuation alone, e.g. '王-王' → '-', counts as nothing left.)
    const drawnName = drawableText(name);
    const displayName = /[\p{L}\p{N}]/u.test(drawnName) ? drawnName : drawableText(altName, 'Member');
    const guildName = drawableText(serverName, 'This server');

    const canvas = createCanvas(CARD_WIDTH, CARD_HEIGHT);
    const ctx = canvas.getContext('2d');

    roundRect(ctx, 0, 0, CARD_WIDTH, CARD_HEIGHT, 24);
    ctx.fillStyle = COLOURS.bg;
    ctx.fill();
    ctx.save();
    roundRect(ctx, 0, 0, CARD_WIDTH, CARD_HEIGHT, 24);
    ctx.clip();
    ctx.fillStyle = accentHex;
    ctx.fillRect(0, 0, 8, CARD_HEIGHT);
    ctx.restore();

    // Avatar: a circle with an accent ring.
    const cx = 128;
    const cy = CARD_HEIGHT / 2;
    const radius = 76;
    ctx.beginPath();
    ctx.arc(cx, cy, radius + 6, 0, Math.PI * 2);
    ctx.fillStyle = accentHex;
    ctx.fill();
    const image = await decodeAvatar(loadImage, avatar);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    if (image) {
        ctx.drawImage(image, cx - radius, cy - radius, radius * 2, radius * 2);
    } else {
        ctx.fillStyle = COLOURS.panel;
        ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
        ctx.fillStyle = COLOURS.muted;
        ctx.font = `64px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const initial = Array.from(displayName)[0]?.toUpperCase() || '?';
        ctx.fillText(initial, cx, cy + 4);
    }
    ctx.restore();

    const left = 240;
    const right = CARD_WIDTH - 40;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    // Level, top right.
    const levelLabel = 'LEVEL';
    const levelValue = String(lvl);
    ctx.font = `56px ${FONT}`;
    const valueWidth = ctx.measureText(levelValue).width;
    ctx.fillStyle = accentHex;
    ctx.textAlign = 'right';
    ctx.fillText(levelValue, right, 92);
    ctx.font = `20px ${FONT}`;
    ctx.fillStyle = COLOURS.muted;
    ctx.fillText(levelLabel, right - valueWidth - 12, 92);
    const levelBlock = valueWidth + 12 + ctx.measureText(levelLabel).width + 24;
    ctx.textAlign = 'left';

    // Server name and member name.
    ctx.font = `20px ${FONT}`;
    ctx.fillStyle = COLOURS.muted;
    ctx.fillText(fitText(ctx, guildName, right - left - levelBlock), left, 56);
    ctx.font = `38px ${FONT}`;
    ctx.fillStyle = COLOURS.text;
    ctx.fillText(fitText(ctx, displayName, right - left - levelBlock), left, 100);

    // Progress bar.
    const barY = 168;
    const barH = 28;
    const barW = right - left;
    roundRect(ctx, left, barY, barW, barH, barH / 2);
    ctx.fillStyle = COLOURS.track;
    ctx.fill();
    if (ratio > 0) {
        roundRect(ctx, left, barY, Math.max(barH, barW * ratio), barH, barH / 2);
        ctx.fillStyle = accentHex;
        ctx.fill();
    }

    ctx.font = `20px ${FONT}`;
    ctx.fillStyle = COLOURS.muted;
    ctx.fillText(atMax ? 'Highest level reached' : `Next: level ${lvl + 1}`, left, barY - 14);
    ctx.textAlign = 'right';
    ctx.fillStyle = COLOURS.text;
    ctx.fillText(atMax ? 'Max' : `${have.toLocaleString('en-US')} / ${need.toLocaleString('en-US')} XP`, right, barY - 14);

    return canvas.encode('png');
}

/**
 * Fetches avatar bytes from Discord's CDN (https, cdn.discordapp.com or media.discordapp.net
 * only), with a timeout and a size cap. Returns null on any problem; never throws.
 */
export async function fetchAvatar(url, { fetchImpl = globalThis.fetch, timeoutMs = AVATAR_TIMEOUT_MS, maxBytes = AVATAR_MAX_BYTES } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Avatar fetch timed out')), timeoutMs);
    try {
        const parsed = new URL(String(url));
        if (parsed.protocol !== 'https:' || !AVATAR_HOSTS.has(parsed.hostname)) return null;
        const response = await fetchImpl(parsed.href, { redirect: 'error', signal: controller.signal });
        if (!response?.ok || !response.body) return null;
        const declared = Number(response.headers?.get?.('content-length'));
        if (Number.isFinite(declared) && declared > maxBytes) return null;
        const chunks = [];
        let total = 0;
        for await (const chunk of response.body) {
            total += chunk.length;
            if (total > maxBytes) return null;
            chunks.push(Buffer.from(chunk));
        }
        return total > 0 ? Buffer.concat(chunks, total) : null;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
        controller.abort();
    }
}

let active = 0;

/** For tests: how many cards are being made right now. */
export function activeCardRenders() {
    return active;
}

/**
 * Makes a card for a member, or returns null (busy, font missing, render error). Never throws.
 * `avatarUrl` null or a failed fetch draws the placeholder.
 */
export async function tryLevelCard({ avatarUrl = null, fetchImpl, render = renderLevelCard, ...card }) {
    if (active >= MAX_CONCURRENT) return null;
    active += 1;
    try {
        const avatar = avatarUrl ? await fetchAvatar(avatarUrl, { fetchImpl }) : null;
        const png = await render({ ...card, avatar });
        return Buffer.isBuffer(png) && png.length > 0 ? png : null;
    } catch (error) {
        logger.warn(`Level card not made: ${error.message}`);
        return null;
    } finally {
        active -= 1;
    }
}

/** The PNG avatar URL Discord's CDN serves for a user (static even for animated avatars). */
export function cardAvatarUrl(user) {
    try {
        return typeof user?.displayAvatarURL === 'function'
            ? user.displayAvatarURL({ extension: 'png', size: 128, forceStatic: true })
            : null;
    } catch {
        return null;
    }
}
