// accountCore.js — the pure parts of Mewvo accounts on the website (/me/signup …):
// validation, password hashing (scrypt), one-time tokens, TOTP 2FA (RFC 6238), recovery
// codes and the encryption of the 2FA secret. No database, no network.
//
// Never log what goes in or out of these functions (passwords, hashes, tokens, codes, secrets).

import crypto from 'node:crypto';

export const USERNAME_MIN = 2;
export const USERNAME_MAX = 30;
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;
export const EMAIL_MAX = 254;
export const MIN_AGE = 13;
export const RESERVED_USERNAMES = new Set(['admin', 'mewvo', 'support', 'staff', 'moderator', 'owner', 'system', 'discord', 'root', 'help']);
/** The names a 1-letter claim can pick: a-z and 0-9. */
export const LETTERS = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('');

export class AccountError extends Error {
    /** userMessage: plain text that is safe to show on the page. */
    constructor(userMessage, status = 400, code = 'invalid') {
        super(userMessage);
        this.name = 'AccountError';
        this.userMessage = userMessage;
        this.status = status;
        this.code = code;
    }
}

// ── Validation ────────────────────────────────────────────────────────────

/** A sign-up username: { ok, value, error }. 2-30 of a-z 0-9 _, not all underscores, not reserved. */
export function validateUsername(input) {
    const value = String(input ?? '').trim().toLowerCase();
    if (value.length < USERNAME_MIN || value.length > USERNAME_MAX) {
        return { ok: false, error: `The username must be ${USERNAME_MIN} to ${USERNAME_MAX} characters long.` };
    }
    if (!/^[a-z0-9_]+$/.test(value)) return { ok: false, error: 'The username can only use letters (a-z), numbers and underscores.' };
    if (/^_+$/.test(value)) return { ok: false, error: 'The username needs at least one letter or number.' };
    if (RESERVED_USERNAMES.has(value)) return { ok: false, error: 'That username is reserved. Choose another one.' };
    return { ok: true, value };
}

/** A 1-letter name for the early-account claim: a-z or 0-9, or null. */
export function normalizeLetter(input) {
    const value = String(input ?? '').trim().toLowerCase();
    return value.length === 1 && LETTERS.includes(value) ? value : null;
}

/** An email address, lowercased: { ok, value, error }. Basic shape check only. */
export function validateEmail(input) {
    const value = String(input ?? '').trim().toLowerCase();
    if (!value || value.length > EMAIL_MAX) return { ok: false, error: 'Enter a valid email address.' };
    const at = value.lastIndexOf('@');
    const local = value.slice(0, at);
    const domain = value.slice(at + 1);
    if (at < 1 || local.length > 64 || /[\s<>"(),;:\\[\]]/.test(value) || value.indexOf('@') !== at) {
        return { ok: false, error: 'Enter a valid email address.' };
    }
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(domain) || domain.split('.').some((part) => part.startsWith('-') || part.endsWith('-'))) {
        return { ok: false, error: 'Enter a valid email address.' };
    }
    if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return { ok: false, error: 'Enter a valid email address.' };
    return { ok: true, value };
}

/** A new password: { ok, error }. Length only (10-200); the text itself is never changed. */
export function validatePassword(input) {
    const value = typeof input === 'string' ? input : '';
    if (value.length < PASSWORD_MIN) return { ok: false, error: `The password must be at least ${PASSWORD_MIN} characters long.` };
    if (value.length > PASSWORD_MAX) return { ok: false, error: `The password can be at most ${PASSWORD_MAX} characters long.` };
    return { ok: true, value };
}

/**
 * The age check from a date of birth (YYYY-MM-DD, as an <input type="date"> sends it):
 * { ok, error }. 13 or older on today's UTC date. The date itself is never stored.
 */
export function checkAge(input, now = new Date()) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(input ?? '').trim());
    if (!match) return { ok: false, error: 'Enter your date of birth.' };
    const [year, month, day] = match.slice(1).map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
        return { ok: false, error: 'Enter a real date of birth.' };
    }
    const today = { y: now.getUTCFullYear(), m: now.getUTCMonth() + 1, d: now.getUTCDate() };
    if (year < today.y - 130 || date.getTime() > now.getTime()) return { ok: false, error: 'Enter a real date of birth.' };
    let age = today.y - year;
    if (today.m < month || (today.m === month && today.d < day)) age -= 1;
    if (age < MIN_AGE) return { ok: false, error: `You must be at least ${MIN_AGE} years old to create an account.` };
    return { ok: true };
}

// ── Passwords (scrypt) ────────────────────────────────────────────────────

/** Default cost: N=2^15, r=8, p=1 (32 MiB, roughly 50-150 ms). Stored with the hash. */
export const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1, keyLength: 64 };

function scrypt(password, salt, { N, r, p, keyLength }) {
    return new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, keyLength, { N, r, p, maxmem: 128 * N * r * 2 }, (error, key) => (error ? reject(error) : resolve(key)));
    });
}

/** "scrypt$N$r$p$<salt b64url>$<hash b64url>" with a random 16-byte salt. */
export async function hashPassword(password, params = SCRYPT_PARAMS) {
    const salt = crypto.randomBytes(16);
    const key = await scrypt(String(password), salt, { ...SCRYPT_PARAMS, ...params });
    const { N, r, p } = { ...SCRYPT_PARAMS, ...params };
    return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** True when `password` matches `stored` (constant-time compare). A malformed hash is false. */
export async function verifyPassword(password, stored) {
    const parts = String(stored || '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [N, r, p] = parts.slice(1, 4).map(Number);
    if (![N, r, p].every(Number.isInteger) || N < 2 || N > 2 ** 20 || r < 1 || r > 32 || p < 1 || p > 16) return false;
    const salt = Buffer.from(parts[4], 'base64url');
    const expected = Buffer.from(parts[5], 'base64url');
    if (salt.length < 8 || expected.length < 16) return false;
    const key = await scrypt(String(password ?? ''), salt, { N, r, p, keyLength: expected.length });
    return crypto.timingSafeEqual(key, expected);
}

let dummyHash = null;
/**
 * For an unknown username or email: hash a password anyway against a fixed dummy, so the
 * answer takes about as long as for a real account. Always false.
 */
export async function verifyAgainstDummy(password, params = SCRYPT_PARAMS) {
    if (!dummyHash || !dummyHash.startsWith(`scrypt$${params.N || SCRYPT_PARAMS.N}$`)) dummyHash = await hashPassword(crypto.randomBytes(16).toString('hex'), params);
    await verifyPassword(password, dummyHash);
    return false;
}

// ── One-time tokens (email links) ─────────────────────────────────────────

export const CONFIRM_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

export function sha256Hex(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** { token (for the link, 32 random bytes), hash (the only thing stored) }. */
export function createToken() {
    const token = crypto.randomBytes(32).toString('base64url');
    return { token, hash: sha256Hex(token) };
}

/** A token from a link: base64url of 32 bytes (43 characters), or null. */
export function cleanToken(value) {
    const text = String(value ?? '').trim();
    return /^[A-Za-z0-9_-]{43}$/.test(text) ? text : null;
}

/** Whether a stored token row can be used now: { ok, reason: 'used' | 'expired' | 'purpose' }. Pure. */
export function tokenUsable(row, purpose, now = Date.now()) {
    if (!row) return { ok: false, reason: 'missing' };
    if (purpose && row.purpose !== purpose) return { ok: false, reason: 'purpose' };
    if (row.used_at) return { ok: false, reason: 'used' };
    if (!(new Date(row.expires_at).getTime() > now)) return { ok: false, reason: 'expired' };
    return { ok: true };
}

// ── TOTP (RFC 6238 / RFC 4226) ────────────────────────────────────────────

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_WINDOW = 1;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer) {
    let bits = 0;
    let value = 0;
    let out = '';
    for (const byte of buffer) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += BASE32[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
    return out;
}

export function base32Decode(text) {
    const clean = String(text ?? '').toUpperCase().replace(/[\s=-]/g, '');
    let bits = 0;
    let value = 0;
    const out = [];
    for (const char of clean) {
        const index = BASE32.indexOf(char);
        if (index < 0) throw new Error('not base32');
        value = (value << 5) | index;
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return Buffer.from(out);
}

/** RFC 4226 HOTP. `algorithm` sha1 (Mewvo) or sha256/sha512 (for the RFC 6238 vectors). */
export function hotp(secret, counter, { digits = TOTP_DIGITS, algorithm = 'sha1' } = {}) {
    const message = Buffer.alloc(8);
    message.writeBigUInt64BE(BigInt(counter));
    const digest = crypto.createHmac(algorithm, secret).update(message).digest();
    const offset = digest[digest.length - 1] & 0x0f;
    const binary = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
    return String(binary % 10 ** digits).padStart(digits, '0');
}

export function totpStep(nowMs = Date.now()) {
    return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

export function totp(secret, nowMs = Date.now(), options = {}) {
    return hotp(secret, totpStep(nowMs), options);
}

/**
 * Checks a 6-digit code against the current step ±1. Returns the matched step (so the caller
 * can refuse it next time: replay protection), or null. Steps <= `afterStep` are refused.
 */
export function verifyTotp(secret, code, { now = Date.now(), window = TOTP_WINDOW, afterStep = null } = {}) {
    const clean = String(code ?? '').replace(/\s/g, '');
    if (!/^\d{6}$/.test(clean)) return null;
    const current = totpStep(now);
    let found = null;
    for (let delta = -window; delta <= window; delta += 1) {
        const step = current + delta;
        // Compare every candidate (no early exit), constant-time per compare.
        if (crypto.timingSafeEqual(Buffer.from(hotp(secret, step)), Buffer.from(clean)) && found === null) found = step;
    }
    if (found === null) return null;
    if (afterStep !== null && afterStep !== undefined && found <= Number(afterStep)) return null;
    return found;
}

/** A new 2FA secret: 20 random bytes. */
export function createTotpSecret() {
    return crypto.randomBytes(20);
}

/** The otpauth:// URI an authenticator app understands (typed in or pasted; no QR code). */
export function otpauthUri(secret, accountName, issuer = 'Mewvo') {
    const label = encodeURIComponent(`${issuer}:${accountName}`);
    const params = new URLSearchParams({ secret: base32Encode(secret), issuer, algorithm: 'SHA1', digits: String(TOTP_DIGITS), period: String(TOTP_STEP_SECONDS) });
    return `otpauth://totp/${label}?${params}`;
}

/** Base32 in groups of four, easier to type. */
export function groupedBase32(secret) {
    return base32Encode(secret).match(/.{1,4}/g).join(' ');
}

// ── Recovery codes ────────────────────────────────────────────────────────

export const RECOVERY_CODE_COUNT = 8;
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** 8 codes like "k7mq-2xpt-h9", about 52 bits each. Shown once; only their hashes are stored. */
export function createRecoveryCodes(count = RECOVERY_CODE_COUNT) {
    const codes = [];
    for (let i = 0; i < count; i += 1) {
        let text = '';
        for (let j = 0; j < 10; j += 1) text += RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)];
        codes.push(`${text.slice(0, 4)}-${text.slice(4, 8)}-${text.slice(8)}`);
    }
    return codes;
}

/** Lowercase, without spaces and dashes: what is hashed. */
export function normalizeRecoveryCode(input) {
    const clean = String(input ?? '').toLowerCase().replace(/[\s-]/g, '');
    return /^[a-z0-9]{10}$/.test(clean) ? clean : null;
}

export function hashRecoveryCode(code) {
    const clean = normalizeRecoveryCode(code);
    return clean ? sha256Hex(`mewvo recovery v1:${clean}`) : null;
}

// ── 2FA secret at rest (AES-256-GCM, key from SESSION_SECRET) ─────────────

const TOTP_KEY_LABEL = 'mewvo account totp key v1';

/** 32 raw bytes: HMAC-SHA256(SESSION_SECRET, own label), so it is never the signing key. */
export function totpEncryptionKey(sessionSecret) {
    if (!sessionSecret || String(sessionSecret).length < 32) throw new Error('SESSION_SECRET is too short for the 2FA key');
    return crypto.createHmac('sha256', String(sessionSecret)).update(TOTP_KEY_LABEL).digest();
}

/** "v1.<iv>.<tag>.<ciphertext>" (base64url). */
export function encryptSecret(secret, key) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}

/** The secret bytes, or null when it does not decrypt (wrong key, changed data). */
export function decryptSecret(stored, key) {
    const parts = String(stored || '').split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') return null;
    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64url'), { authTagLength: 16 });
        decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
        return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]);
    } catch {
        return null;
    }
}

// ── Early-account bonuses ─────────────────────────────────────────────────

export const LETTER_CLAIM_LIMIT = 30;
export const PRO_BONUS_LIMIT = 100;
export const PRO_BONUS_DAYS = 30;
export const PRO_BONUS_PLAN = 'pro';

/** What the n-th Discord account to link gets: { pro, letter }. Pure. */
export function bonusFor(linkNumber) {
    const n = Number(linkNumber);
    return { pro: n >= 1 && n <= PRO_BONUS_LIMIT, letter: n >= 1 && n <= LETTER_CLAIM_LIMIT };
}

/** "j***@example.com" for logs. */
export function maskEmail(email) {
    const text = String(email || '');
    const at = text.lastIndexOf('@');
    if (at < 1) return '***';
    return `${text[0]}***${text.slice(at)}`;
}
