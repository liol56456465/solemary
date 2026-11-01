// Mewvo accounts, the pure parts (src/services/accounts/accountCore.js): validation, scrypt,
// TOTP against the RFC 6238 / RFC 4226 vectors, recovery codes, the 2FA secret at rest and
// the bonus limits (6 months of Pro = 183 days). Accounts have no email.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    LETTERS, PRO_BONUS_DAYS, PRO_BONUS_LABEL, PRO_BONUS_LIMIT, LETTER_CLAIM_LIMIT, base32Decode, base32Encode, bonusFor, checkAge,
    createRecoveryCodes, createTotpSecret, decryptSecret, encryptSecret, hashPassword, hashRecoveryCode, hotp, normalizeLetter,
    normalizeRecoveryCode, otpauthUri, totp, totpEncryptionKey, validatePassword, validateUsername, verifyAgainstDummy,
    verifyPassword, verifyTotp,
} from '../src/services/accounts/accountCore.js';
import * as core from '../src/services/accounts/accountCore.js';

const LOW = { N: 1024, r: 8, p: 1 };

test('username: 2-30 of a-z 0-9 _, lowercased, not all underscores, reserved names refused', () => {
    assert.deepEqual(validateUsername('  Cool_Cat9 '), { ok: true, value: 'cool_cat9' });
    assert.equal(validateUsername('ab').ok, true);
    assert.equal(validateUsername('a'.repeat(30)).ok, true);
    for (const bad of ['a', '', 'a'.repeat(31), 'with space', 'dash-name', 'émile', 'name!', '__', '_____', 'ADMIN', 'mewvo', 'support', 'root', 'help']) {
        assert.equal(validateUsername(bad).ok, false, bad);
    }
    assert.match(validateUsername('admin').error, /reserved/);
});

test('1-letter names: only a-z and 0-9, one character', () => {
    assert.equal(normalizeLetter('Q'), 'q');
    assert.equal(normalizeLetter('7'), '7');
    for (const bad of ['', '_', 'ab', '!', 'é']) assert.equal(normalizeLetter(bad), null, bad);
    assert.equal(LETTERS.length, 36);
});

test('password: 10 to 200 characters, kept as typed', () => {
    assert.equal(validatePassword('123456789').ok, false);
    assert.equal(validatePassword(' 123456789').ok, true);
    assert.equal(validatePassword('x'.repeat(200)).ok, true);
    assert.equal(validatePassword('x'.repeat(201)).ok, false);
    assert.equal(validatePassword(undefined).ok, false);
});

test('age: 13 or older on today\'s UTC date; the birthday itself counts', () => {
    const now = new Date('2026-11-01T12:00:00Z');
    assert.equal(checkAge('2013-11-01', now).ok, true, 'turns 13 today');
    assert.equal(checkAge('2013-11-02', now).ok, false, 'turns 13 tomorrow');
    assert.match(checkAge('2013-11-02', now).error, /at least 13/);
    assert.equal(checkAge('1990-02-28', now).ok, true);
    for (const bad of ['', '2013-02-30', '13/11/2000', '2030-01-01', '1800-01-01', 'yesterday']) assert.equal(checkAge(bad, now).ok, false, bad);
    // Just after midnight UTC on the 13th birthday.
    assert.equal(checkAge('2010-03-05', new Date('2023-03-05T00:00:01Z')).ok, true);
    assert.equal(checkAge('2010-03-05', new Date('2023-03-04T23:59:59Z')).ok, false);
});

test('scrypt: random salt, params stored, verify with the right password only', async () => {
    const a = await hashPassword('correct horse battery', LOW);
    const b = await hashPassword('correct horse battery', LOW);
    assert.notEqual(a, b, 'random salt');
    assert.match(a, /^scrypt\$1024\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/);
    assert.equal(await verifyPassword('correct horse battery', a), true);
    assert.equal(await verifyPassword('correct horse batterY', a), false);
    assert.equal(await verifyPassword('', a), false);
    assert.equal(await verifyPassword('x', 'garbage'), false);
    assert.equal(await verifyPassword('x', 'scrypt$99999999$8$1$aaaa$bbbb'), false, 'refuses absurd params');
    assert.equal(await verifyAgainstDummy('anything', LOW), false);
    const strong = await hashPassword('default cost works', undefined);
    assert.match(strong, /^scrypt\$32768\$8\$1\$/);
    assert.equal(await verifyPassword('default cost works', strong), true);
});

test('HOTP: the RFC 4226 test vectors', () => {
    const secret = Buffer.from('12345678901234567890');
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expected.forEach((code, counter) => assert.equal(hotp(secret, counter), code, `counter ${counter}`));
});

test('TOTP: the RFC 6238 test vectors (8 digits, SHA-1 / SHA-256 / SHA-512)', () => {
    const sha1 = Buffer.from('12345678901234567890');
    const sha256 = Buffer.from('12345678901234567890123456789012');
    const sha512 = Buffer.from('1234567890123456789012345678901234567890123456789012345678901234');
    const vectors = [
        [59, '94287082', '46119246', '90693936'],
        [1111111109, '07081804', '68084774', '25091201'],
        [1111111111, '14050471', '67062674', '99943326'],
        [1234567890, '89005924', '91819424', '93441116'],
        [2000000000, '69279037', '90698825', '38618901'],
        [20000000000, '65353130', '77737706', '47863826'],
    ];
    for (const [seconds, a, b, c] of vectors) {
        assert.equal(totp(sha1, seconds * 1000, { digits: 8 }), a, `sha1 ${seconds}`);
        assert.equal(totp(sha256, seconds * 1000, { digits: 8, algorithm: 'sha256' }), b, `sha256 ${seconds}`);
        assert.equal(totp(sha512, seconds * 1000, { digits: 8, algorithm: 'sha512' }), c, `sha512 ${seconds}`);
    }
});

test('TOTP verify: 6 digits, ±1 step of 30 s, later steps only (replay)', () => {
    const secret = createTotpSecret();
    assert.equal(secret.length, 20);
    const now = 1_800_000_000_000;
    const step = Math.floor(now / 30000);
    assert.equal(verifyTotp(secret, totp(secret, now), { now }), step);
    assert.equal(verifyTotp(secret, totp(secret, now - 30000), { now }), step - 1);
    assert.equal(verifyTotp(secret, totp(secret, now + 30000), { now }), step + 1);
    assert.equal(verifyTotp(secret, totp(secret, now - 60000), { now }), null, 'two steps old');
    assert.equal(verifyTotp(secret, totp(secret, now), { now, afterStep: step }), null, 'same step twice');
    assert.equal(verifyTotp(secret, ` ${totp(secret, now).slice(0, 3)} ${totp(secret, now).slice(3)} `, { now }), step, 'spaces allowed');
    for (const bad of ['', '12345', '1234567', 'abcdef', null]) assert.equal(verifyTotp(secret, bad, { now }), null);
});

test('Base32 round trip and the otpauth URI', () => {
    const secret = Buffer.from('12345678901234567890');
    assert.equal(base32Encode(secret), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    assert.deepEqual(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq'), secret);
    assert.throws(() => base32Decode('01'), /not base32/);
    const uri = otpauthUri(secret, 'cool_cat');
    assert.equal(uri, 'otpauth://totp/Mewvo%3Acool_cat?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Mewvo&algorithm=SHA1&digits=6&period=30');
});

test('recovery codes: 8 different codes, hashed after normalising, unknown text refused', () => {
    const codes = createRecoveryCodes();
    assert.equal(codes.length, 8);
    assert.equal(new Set(codes).size, 8);
    for (const code of codes) assert.match(code, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{2}$/);
    assert.equal(hashRecoveryCode(codes[0]), hashRecoveryCode(codes[0].toUpperCase().replace(/-/g, ' ')));
    assert.notEqual(hashRecoveryCode(codes[0]), hashRecoveryCode(codes[1]));
    assert.equal(normalizeRecoveryCode('123456'), null, 'an app code is not a recovery code');
    assert.equal(hashRecoveryCode('nope'), null);
});

test('2FA secret at rest: AES-256-GCM with a key from SESSION_SECRET, tampering and wrong keys fail', () => {
    const key = totpEncryptionKey('s'.repeat(40));
    assert.equal(key.length, 32);
    assert.notDeepEqual(key, totpEncryptionKey('t'.repeat(40)));
    assert.throws(() => totpEncryptionKey('short'), /too short/);
    const secret = createTotpSecret();
    const stored = encryptSecret(secret, key);
    assert.ok(!stored.includes(base32Encode(secret)));
    assert.deepEqual(decryptSecret(stored, key), secret);
    assert.notEqual(encryptSecret(secret, key), stored, 'random IV');
    assert.equal(decryptSecret(stored, totpEncryptionKey('t'.repeat(40))), null);
    const parts = stored.split('.');
    parts[3] = Buffer.from('changed!').toString('base64url');
    assert.equal(decryptSecret(parts.join('.'), key), null);
    assert.equal(decryptSecret('garbage', key), null);
});

test('bonus limits: 1-30 letter + Pro, 31-100 Pro, 101 and later nothing', () => {
    assert.equal(LETTER_CLAIM_LIMIT, 30);
    assert.equal(PRO_BONUS_LIMIT, 100);
    assert.deepEqual(bonusFor(1), { pro: true, letter: true });
    assert.deepEqual(bonusFor(30), { pro: true, letter: true });
    assert.deepEqual(bonusFor(31), { pro: true, letter: false });
    assert.deepEqual(bonusFor(100), { pro: true, letter: false });
    assert.deepEqual(bonusFor(101), { pro: false, letter: false });
    assert.deepEqual(bonusFor(0), { pro: false, letter: false });
    // 6 months of Pro: the premium store counts whole days, so 183 (not calendar months).
    assert.equal(PRO_BONUS_DAYS, 183);
    assert.equal(PRO_BONUS_LABEL, '6 months');
});

test('no email in accounts: no email validation, tokens or mail helpers are exported any more', () => {
    for (const name of ['validateEmail', 'maskEmail', 'createToken', 'cleanToken', 'tokenUsable', 'EMAIL_MAX']) assert.equal(core[name], undefined, name);
});
