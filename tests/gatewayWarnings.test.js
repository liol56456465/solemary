import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskTokens } from '../src/utils/maskTokens.js';
import { logger } from '../src/utils/logger.js';
import shardError from '../src/events/shardError.js';
import warn from '../src/events/warn.js';

// Built at runtime so no token-shaped literal sits in the repo (gitleaks).
const fakeToken = ['A'.repeat(24), 'B'.repeat(6), 'C'.repeat(27)].join('.');

test('maskTokens: token-shaped strings and Bot/Bearer values are masked; normal text stays', () => {
    assert.equal(maskTokens(`bad ${fakeToken} here`), 'bad [token] here');
    assert.equal(maskTokens('Authorization: Bot abcdefghijklmnop'), 'Authorization: Bot [token]');
    assert.equal(maskTokens('Connection reset by peer'), 'Connection reset by peer');
});

test('shardError and warn listeners log a warning without the token', () => {
    assert.equal(shardError.name, 'shardError');
    assert.equal(warn.name, 'warn');
    const lines = [];
    const orig = logger.warn;
    logger.warn = (m) => lines.push(m);
    try {
        shardError.execute(new Error(`socket closed ${fakeToken}`), 0);
        warn.execute(`heartbeat late ${fakeToken}`);
    } finally {
        logger.warn = orig;
    }
    assert.equal(lines.length, 2);
    assert.ok(lines.every((m) => !m.includes(fakeToken) && m.includes('[token]')));
    assert.match(lines[0], /shard 0/);
});
