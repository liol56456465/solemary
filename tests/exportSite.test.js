// scripts/export-site.js: in the static copy, links to the bot's own pages go to the app's address,
// everything else stays relative, and the "not public yet" robots meta is dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowIndexing, pointAppLinksAt } from '../scripts/export-site.js';

test('bot pages link to the app; site pages, anchors and assets stay relative', () => {
    const input = '<a href="/dashboard">D</a><a href="/leaderboard?page=2">L</a><a href="/status">S</a><a href="/rules#rule-3">R</a>'
        + '<a href="/me">M</a><a href="/transparency">T</a><a href="/features">F</a><a href="/docs/appeals">A</a>'
        + '<a href="/statuses">X</a><img src="/img/logo.png"><a href="#main">skip</a>';
    const out = pointAppLinksAt(input, 'https://app.mewvo.com');
    for (const p of ['/dashboard"', '/leaderboard?page=2"', '/status"', '/rules#rule-3"', '/me"', '/transparency"']) {
        assert.ok(out.includes(`href="https://app.mewvo.com${p}`), p);
    }
    for (const p of ['href="/features"', 'href="/docs/appeals"', 'href="/statuses"', 'src="/img/logo.png"', 'href="#main"']) {
        assert.ok(out.includes(p), p);
    }
});

test('the noindex meta is removed, nothing else', () => {
    assert.equal(allowIndexing('<head><meta name="robots" content="noindex, nofollow"><title>x</title></head>'), '<head><title>x</title></head>');
});
