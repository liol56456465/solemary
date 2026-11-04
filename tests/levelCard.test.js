// Level-up / rank image card: rendering (PNG for normal and edge inputs), the avatar fetch
// limits, the concurrency bound, and the text fallbacks in the level-up send.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import {
    AVATAR_MAX_BYTES, CARD_FILE_NAME, DEFAULT_CARD_ACCENT, MAX_CONCURRENT,
    activeCardRenders, cardAccentOf, cardAvatarUrl, drawableText, fetchAvatar, renderLevelCard, tryLevelCard,
} from '../src/services/leveling/levelCard.js';
import { levelUpCardFor, sendLevelUpAnnouncement } from '../src/services/leveling/xpSystem.js';
import { updateLevelingConfig } from '../src/services/leveling/leveling.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isPng = (buf) => Buffer.isBuffer(buf) && buf.length > PNG_MAGIC.length && buf.subarray(0, 8).equals(PNG_MAGIC);

function avatarPng() {
    const canvas = createCanvas(128, 128);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#E67E22';
    ctx.fillRect(0, 0, 128, 128);
    return canvas.toBuffer('image/png');
}

const base = { name: 'Mochi', serverName: 'Test Lounge', level: 5, xp: 120, xpNeeded: 425, accent: '#9B59B6' };

test('renders a PNG for normal and edge inputs', async () => {
    const cases = [
        { ...base, avatar: avatarPng() },
        { ...base, name: 'N'.repeat(32), serverName: 'S'.repeat(100) },
        { ...base, name: '\u{1F600}\u{1F389} Party \u{1F431}‍\u{1F464}', serverName: '\u{1F30D} Server' },
        { ...base, name: '\u{1F600}\u{1F600}', serverName: '' },
        { ...base, level: 0, xp: 0, xpNeeded: 50 },
        { ...base, level: 1000, xp: 0, xpNeeded: 0 },
        { ...base, avatar: null },
        { ...base, avatar: Buffer.from('not an image') },
        { ...base, avatar: Buffer.alloc(AVATAR_MAX_BYTES + 1) },
        { ...base, name: undefined, serverName: undefined, level: -3, xp: Number.NaN, xpNeeded: -1, accent: 'nonsense' },
        { ...base, xp: 10_000, xpNeeded: 425 },
        { ...base, name: 'Ąžuolas Čiurlionis', serverName: 'Lietuva' },
    ];
    for (const input of cases) {
        const png = await renderLevelCard(input);
        assert.ok(isPng(png), `PNG for ${JSON.stringify({ ...input, avatar: input.avatar ? input.avatar.length : null })}`);
    }
});

test('render is fast once the font is loaded (target under 100 ms)', async () => {
    await renderLevelCard(base);
    const start = performance.now();
    const runs = 5;
    for (let i = 0; i < runs; i++) await renderLevelCard({ ...base, avatar: avatarPng() });
    const avg = (performance.now() - start) / runs;
    assert.ok(avg < 100, `average ${avg.toFixed(1)} ms`);
});

test('drawableText drops emoji and control characters, keeps letters, falls back when empty', () => {
    assert.equal(drawableText('\u{1F600} Mochi  \u{1F431}\n'), 'Mochi');
    assert.equal(drawableText('Ąžuolas'), 'Ąžuolas');
    assert.equal(drawableText('\u{1F600}️', 'Member'), 'Member');
    assert.equal(drawableText(null, 'x'), 'x');
});

test('drawableText drops letters the bundled font has no glyph for (no "NO GLYPH" boxes)', () => {
    assert.equal(drawableText('山田太郎', 'Member'), 'Member');
    assert.equal(drawableText('Tiếng Việt مرحبا ★ 김'), 'Tiếng Việt');
    assert.equal(drawableText('Привет Ελλάδα'), 'Привет Ελλάδα');
    assert.equal(drawableText('Ｔａｒｏ', 'x'), 'x', 'fullwidth forms are not in the font');
    assert.equal(drawableText('Zoë (#1) – 5€'), 'Zoë (#1) – 5€');
});

test('the card falls back to altName (username) when no character of the name can be drawn', async () => {
    let input;
    const perms = { has: () => true };
    const cjk = { ...member, displayName: '山田太郎', user: { ...member.user, username: 'yamada' } };
    await levelUpCardFor({ name: 'G' }, cjk, { level: 3, xp: 0 }, { levelUpCard: true }, perms, async (i) => { input = i; return null; });
    assert.equal(input.altName, 'yamada');
    const png = await renderLevelCard({ name: '山田太郎', altName: 'yamada', serverName: 'S', level: 3, xp: 1, xpNeeded: 100 });
    assert.ok(Buffer.isBuffer(png) && png.length > 0);
    const punct = await renderLevelCard({ name: '王-王', altName: 'wang', serverName: 'S', level: 3, xp: 1, xpNeeded: 100 });
    assert.ok(Buffer.isBuffer(punct) && punct.length > 0);
});

test('cardAccentOf: a stored colour code, else Mewvo blue', () => {
    assert.equal(cardAccentOf('#9b59b6'), '#9B59B6');
    assert.equal(cardAccentOf(null), DEFAULT_CARD_ACCENT);
    assert.equal(cardAccentOf('red'), DEFAULT_CARD_ACCENT);
});

test('cardAvatarUrl asks Discord for a static 128 px PNG', () => {
    let opts;
    assert.equal(cardAvatarUrl({ displayAvatarURL: (o) => { opts = o; return 'https://cdn.discordapp.com/avatars/1/a.png?size=128'; } }), 'https://cdn.discordapp.com/avatars/1/a.png?size=128');
    assert.deepEqual(opts, { extension: 'png', size: 128, forceStatic: true });
    assert.equal(cardAvatarUrl(null), null);
    assert.equal(cardAvatarUrl({ displayAvatarURL: () => { throw new Error('x'); } }), null);
});

test('fetchAvatar: Discord CDN over https only, size cap, timeout, errors give null', async () => {
    const png = avatarPng();
    let calls = 0;
    const ok = async () => { calls += 1; return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } }); };
    assert.ok((await fetchAvatar('https://cdn.discordapp.com/avatars/1/a.png', { fetchImpl: ok })).equals(png));

    for (const url of ['http://cdn.discordapp.com/a.png', 'https://evil.example/a.png', 'https://cdn.discordapp.com.evil.example/a.png', 'not a url', null]) {
        assert.equal(await fetchAvatar(url, { fetchImpl: ok }), null, String(url));
    }
    assert.equal(calls, 1, 'other hosts are never fetched');

    const big = async () => new Response(Buffer.alloc(2048), { status: 200 });
    assert.equal(await fetchAvatar('https://cdn.discordapp.com/a.png', { fetchImpl: big, maxBytes: 1024 }), null, 'streamed size cap');
    const declared = async () => new Response(Buffer.alloc(10), { status: 200, headers: { 'content-length': '999999' } });
    assert.equal(await fetchAvatar('https://cdn.discordapp.com/a.png', { fetchImpl: declared, maxBytes: 1024 }), null, 'declared size cap');
    const notFound = async () => new Response('no', { status: 404 });
    assert.equal(await fetchAvatar('https://cdn.discordapp.com/a.png', { fetchImpl: notFound }), null);
    const throws = async () => { throw new Error('network'); };
    assert.equal(await fetchAvatar('https://cdn.discordapp.com/a.png', { fetchImpl: throws }), null);

    const hangs = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    const start = Date.now();
    assert.equal(await fetchAvatar('https://cdn.discordapp.com/a.png', { fetchImpl: hangs, timeoutMs: 50 }), null);
    assert.ok(Date.now() - start < 1000, 'timeout applies');
});

test('tryLevelCard: a failed avatar draws the placeholder; a render error gives null; at most 2 at once', async () => {
    const failing = async () => { throw new Error('cdn down'); };
    assert.ok(isPng(await tryLevelCard({ ...base, avatarUrl: 'https://cdn.discordapp.com/a.png', fetchImpl: failing })), 'placeholder card');
    assert.equal(await tryLevelCard({ ...base, render: async () => { throw new Error('boom'); } }), null);
    assert.equal(activeCardRenders(), 0, 'slot released after an error');

    const gates = [];
    const slow = () => new Promise((resolve) => gates.push(() => resolve(Buffer.from(PNG_MAGIC.toString('binary') + 'x', 'binary'))));
    const running = Array.from({ length: MAX_CONCURRENT }, () => tryLevelCard({ ...base, render: slow }));
    await new Promise((r) => setImmediate(r));
    assert.equal(activeCardRenders(), MAX_CONCURRENT);
    assert.equal(await tryLevelCard({ ...base, render: slow }), null, 'busy: no card');
    gates.forEach((open) => open());
    const results = await Promise.all(running);
    assert.ok(results.every(Boolean));
    assert.equal(activeCardRenders(), 0);
});

// ── level-up send ─────────────────────────────────────────────────────────

function fakeGuild({ perms = ['SendMessages', 'EmbedLinks', 'AttachFiles'], failCardSend = null } = {}) {
    const sent = [];
    const channel = {
        id: '200000000000000001',
        isTextBased: () => true,
        permissionsFor: () => ({ has: (p) => (Array.isArray(p) ? p : [p]).every((x) => perms.includes(x)) }),
        send: async (payload) => {
            if (failCardSend && payload.files) throw failCardSend;
            sent.push(payload);
            return {};
        },
    };
    const guild = { id: '100000000000000001', name: 'Test Lounge', channels: { cache: new Map([[channel.id, channel]]) }, systemChannel: null, members: { me: {} } };
    return { guild, channel, sent };
}

const member = {
    displayName: 'Mochi',
    user: { id: '300000000000000001', username: 'mochi', displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png' },
    toString: () => '<@300000000000000001>',
};
const levelData = { level: 3, xp: 10, totalXp: 500 };
const config = (extra = {}) => ({ levelUpChannel: '200000000000000001', levelUpMessage: '{user} is now level {level}.', ...extra });

test('default (card setting missing or off): the text line is sent exactly as before and no card is made', async () => {
    for (const cfg of [config(), config({ levelUpCard: false, cardAccent: '#9B59B6' })]) {
        const { guild, sent } = fakeGuild();
        let made = 0;
        await sendLevelUpAnnouncement(guild, member, levelData, cfg, { makeCard: async () => { made += 1; return Buffer.from('x'); } });
        assert.equal(made, 0);
        assert.deepEqual(sent, [{ content: '<@300000000000000001> is now level 3.', allowedMentions: { parse: ['users'] } }]);
    }
});

test('card on: the PNG is attached to the same message with the same mentions', async () => {
    const { guild, sent } = fakeGuild();
    let input;
    const png = Buffer.concat([PNG_MAGIC, Buffer.from('x')]);
    await sendLevelUpAnnouncement(guild, member, levelData, config({ levelUpCard: true, cardAccent: '#9B59B6' }), { makeCard: async (i) => { input = i; return png; } });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].content, '<@300000000000000001> is now level 3.');
    assert.deepEqual(sent[0].allowedMentions, { parse: ['users'] });
    assert.deepEqual(sent[0].files, [{ attachment: png, name: CARD_FILE_NAME }]);
    assert.equal(input.name, 'Mochi');
    assert.equal(input.serverName, 'Test Lounge');
    assert.equal(input.level, 3);
    assert.equal(input.xpNeeded, 245);
    assert.equal(input.accent, '#9B59B6');
    assert.equal(input.avatarUrl, 'https://cdn.discordapp.com/embed/avatars/0.png');
});

test('card on but no card (busy/error), no Attach Files, or the card send fails: the text line is sent', async () => {
    const textOnly = { content: '<@300000000000000001> is now level 3.', allowedMentions: { parse: ['users'] } };
    const png = Buffer.concat([PNG_MAGIC, Buffer.from('x')]);

    let a = fakeGuild();
    await sendLevelUpAnnouncement(a.guild, member, levelData, config({ levelUpCard: true }), { makeCard: async () => null });
    assert.deepEqual(a.sent, [textOnly], 'no card');

    a = fakeGuild();
    await sendLevelUpAnnouncement(a.guild, member, levelData, config({ levelUpCard: true }), { makeCard: async () => { throw new Error('boom'); } });
    assert.deepEqual(a.sent, [textOnly], 'card maker throws');

    a = fakeGuild({ perms: ['SendMessages', 'EmbedLinks'] });
    let made = 0;
    await sendLevelUpAnnouncement(a.guild, member, levelData, config({ levelUpCard: true }), { makeCard: async () => { made += 1; return png; } });
    assert.equal(made, 0, 'no card rendered without Attach Files');
    assert.deepEqual(a.sent, [textOnly]);

    a = fakeGuild({ failCardSend: Object.assign(new Error('Missing Permissions'), { status: 403, code: 50013 }) });
    await sendLevelUpAnnouncement(a.guild, member, levelData, config({ levelUpCard: true }), { makeCard: async () => png });
    assert.deepEqual(a.sent, [textOnly], 'card send refused by Discord (4xx) falls back');
});

test('card send with a network error or timeout: no second post (the card may have gone through)', async () => {
    const png = Buffer.concat([PNG_MAGIC, Buffer.from('x')]);
    for (const error of [new Error('socket hang up'), Object.assign(new Error('Service Unavailable'), { status: 503 })]) {
        const a = fakeGuild({ failCardSend: error });
        await sendLevelUpAnnouncement(a.guild, member, levelData, config({ levelUpCard: true }), { makeCard: async () => png });
        assert.deepEqual(a.sent, [], error.message);
    }
});

test('levelUpCardFor at max level asks for a full bar (no next level)', async () => {
    let input;
    const perms = { has: () => true };
    await levelUpCardFor({ name: 'G' }, member, { level: 1000, xp: 0 }, { levelUpCard: true }, perms, async (i) => { input = i; return null; });
    assert.equal(input.xpNeeded, 0);
    assert.equal(input.level, 1000);
});

test('leveling config refuses a bad card setting before touching the database', async () => {
    const client = { db: new Proxy({}, { get() { throw new Error('database must not be used'); } }) };
    await assert.rejects(updateLevelingConfig(client, '100000000000000001', { levelUpCard: 'yes' }), /levelUpCard must be true or false/);
    await assert.rejects(updateLevelingConfig(client, '100000000000000001', { cardAccent: 'purple' }), /Invalid card accent/);
});
