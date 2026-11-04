// Privacy fixes: production never logs below info, privacy lines at Verify / in DMs / modmail,
// and no message text in the messageCreate debug line.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveLogLevel } from '../src/utils/logger.js';
import { directVerifyPrivacyNote, oauthVerifyPrivacyNote, privacyFooterText, privacyUrl } from '../src/utils/privacyNotice.js';

test('logger: production clamps debug (and anything more verbose than info) to info, with a warning', () => {
    for (const asked of ['debug', 'DEBUG', 'silly', 'verbose', 'http']) {
        const { level, warning } = resolveLogLevel({ nodeEnv: 'production', logLevel: asked });
        assert.equal(level, 'info', asked);
        assert.match(warning, /not allowed in production/);
    }
    assert.deepEqual(resolveLogLevel({ nodeEnv: 'production', logLevel: 'info' }), { level: 'info', warning: null });
    assert.deepEqual(resolveLogLevel({ nodeEnv: 'production', logLevel: 'warning' }), { level: 'warn', warning: null });
    assert.deepEqual(resolveLogLevel({ nodeEnv: 'production' }), { level: 'info', warning: null });
    assert.equal(resolveLogLevel({ nodeEnv: 'production', logLevel: 'loud' }).level, 'info');
    assert.match(resolveLogLevel({ nodeEnv: 'production', logLevel: 'loud' }).warning, /Invalid LOG_LEVEL/);
});

test('logger: outside production debug stays available', () => {
    assert.deepEqual(resolveLogLevel({ nodeEnv: 'test', logLevel: 'debug' }), { level: 'debug', warning: null });
    assert.deepEqual(resolveLogLevel({ nodeEnv: 'development' }), { level: 'debug', warning: null });
});

test('messageCreate: the debug line has no message text or author tag', () => {
    const source = readFileSync(new URL('../src/events/messageCreate.js', import.meta.url), 'utf8');
    const line = source.split('\n').find((l) => l.includes('Message received'));
    assert.ok(line);
    assert.ok(!line.includes('message.content}'), 'content is not interpolated');
    assert.ok(!line.includes('author.tag'));
    assert.match(line, /length=/);
});

test('privacy links: only with an http(s) PUBLIC_URL', () => {
    assert.equal(privacyUrl({ PUBLIC_URL: 'https://mewvo.example/' }), 'https://mewvo.example/privacy');
    assert.equal(privacyUrl({ PUBLIC_URL: 'https://mewvo.example/sub/path' }), 'https://mewvo.example/privacy');
    assert.equal(privacyUrl({}), null);
    assert.equal(privacyUrl({ PUBLIC_URL: 'javascript:alert(1)' }), null);
    assert.equal(privacyUrl({ PUBLIC_URL: 'https://user:pw@mewvo.example' }), null);
    assert.equal(privacyFooterText({ PUBLIC_URL: 'https://mewvo.example' }), 'Privacy: https://mewvo.example/privacy');
    assert.equal(privacyFooterText({}), null);
});

test('Verify notes: what is stored, link only with PUBLIC_URL', () => {
    const env = { PUBLIC_URL: 'https://mewvo.example' };
    const oauth = oauthVerifyPrivacyNote(env);
    for (const fact of ['Discord ID', 'encrypted login token', 'support server', 'IP address', 'ban evasion', 'Privacy: https://mewvo.example/privacy']) {
        assert.ok(oauth.includes(fact), fact);
    }
    assert.ok(!oauthVerifyPrivacyNote({}).includes('Privacy:'));
    assert.ok(directVerifyPrivacyNote(env).includes('Discord ID'));
    assert.ok(!directVerifyPrivacyNote(env).includes('IP'), 'the direct path stores no IP fingerprint');
});

test('enforcement DMs end with the privacy line when PUBLIC_URL is set and stay within 2000 characters', async () => {
    const { withPrivacyLine } = await import('../src/services/enforcement/dmTemplates.js');
    const env = { PUBLIC_URL: 'https://mewvo.example' };
    assert.equal(withPrivacyLine('**Banned**', env), '**Banned**\n-# Privacy: <https://mewvo.example/privacy>');
    assert.equal(withPrivacyLine('**Banned**', {}), '**Banned**');
    const full = 'x'.repeat(1990);
    assert.equal(withPrivacyLine(full, env), full, 'dropped rather than going over the limit');
});

test('OAuth hold page: the privacy note, escaped, with a link', async () => {
    const { errorPage, privacyNoteHtml } = await import('../src/services/oauthVerification.js');
    const note = privacyNoteHtml({ PUBLIC_URL: 'https://mewvo.example' });
    assert.match(note, /<a href="https:\/\/mewvo\.example\/privacy">Privacy Policy<\/a>/);
    assert.ok(!privacyNoteHtml({}).includes('<a '));
    const page = errorPage('Waiting for approval', 'Thanks!', '#fee75c', { note });
    assert.match(page, /class="note">Verifying stores your Discord ID/);
    assert.ok(!errorPage('Link expired', 'x').includes('class="note"'));
});
