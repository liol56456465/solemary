import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
    parseMessageLink, parseEvidenceUrls, messageExcerpt, evidenceLines, fitLines, EXCERPT_MAX,
} = await import('../src/services/enforcement/evidenceService.js');

const G = '111111111111111111';
const C = '222222222222222222';
const M = '333333333333333333';

test('parseMessageLink: canonicalises discord, ptb, canary and discordapp links', () => {
    for (const host of ['discord.com', 'ptb.discord.com', 'canary.discord.com', 'discordapp.com']) {
        assert.deepEqual(parseMessageLink(`https://${host}/channels/${G}/${C}/${M}`), {
            guildId: G, channelId: C, messageId: M, url: `https://discord.com/channels/${G}/${C}/${M}`,
        });
    }
    assert.equal(parseMessageLink(`https://discord.com/channels/${G}/${C}`), null, 'channel link is not a message link');
    assert.equal(parseMessageLink('https://example.com/x'), null);
    assert.equal(parseMessageLink(`<https://discord.com/channels/${G}/${C}/${M}>`.slice(1)).messageId, M, 'trailing > is stripped');
});

test('parseEvidenceUrls: all links in order, deduplicated, message links tagged', () => {
    const text = `see https://discord.com/channels/${G}/${C}/${M}, and
https://ptb.discord.com/channels/${G}/${C}/${M}
https://i.imgur.com/abc.png. junk words`;
    const out = parseEvidenceUrls(text);
    assert.equal(out.length, 2);
    assert.equal(out[0].url, `https://discord.com/channels/${G}/${C}/${M}`);
    assert.equal(out[0].message.messageId, M);
    assert.deepEqual(out[1], { url: 'https://i.imgur.com/abc.png', message: null });
    assert.deepEqual(parseEvidenceUrls('no links here'), []);
    assert.deepEqual(parseEvidenceUrls(''), []);
});

test('messageExcerpt: author, content, attachments, capped', () => {
    const msg = { author: { username: 'kit' }, content: 'hello  there', attachments: { size: 2 }, embeds: [] };
    assert.equal(messageExcerpt(msg), 'kit: hello  there [+2 attachments]');
    assert.equal(messageExcerpt({ author: { username: 'kit' }, content: '', attachments: { size: 0 }, embeds: [{}] }), 'kit: [1 embed]');
    assert.equal(messageExcerpt({ author: { username: 'kit' }, content: '' }), 'kit: (no text)');
    const long = messageExcerpt({ author: { username: 'kit' }, content: 'x'.repeat(2000) });
    assert.ok(long.length <= EXCERPT_MAX);
});

test('evidenceLines: links with excerpt and images with fresh or stored link', () => {
    const base = { added_by_username: 'mod', added_at: new Date('2026-01-01T00:00:00Z') };
    const rows = [
        { ...base, id: '1', kind: 'link', url: 'https://discord.com/channels/1/2/3', excerpt: 'kit: bad\nwords', note: null },
        { ...base, id: '2', kind: 'image', store_channel_id: C, store_message_id: M, note: 'screenshot' },
        { ...base, id: '3', kind: 'image', store_channel_id: null, store_message_id: null },
    ];
    const lines = evidenceLines(rows, new Map([['2', 'https://cdn.example/fresh.png']]));
    assert.match(lines[0], /^\*\*#1\*\* 🔗 https:\/\/discord\.com\/channels\/1\/2\/3 "kit: bad words" · mod, <t:/);
    assert.match(lines[1], /\[image\]\(https:\/\/cdn\.example\/fresh\.png\)/);
    assert.match(lines[1], new RegExp(`\\[stored\\]\\(https://discord\\.com/channels/[^/]+/${C}/${M}\\)`));
    assert.match(lines[1], /— screenshot/);
    assert.match(lines[2], /stored message missing/);
});

test('fitLines: stays under the limit and says how many were left out', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i} ${'y'.repeat(80)}`);
    const out = fitLines(lines, 1024);
    assert.ok(out.length <= 1024, `length ${out.length}`);
    assert.match(out, /…and \d+ more$/);
    const shown = out.split('\n').length - 1;
    assert.match(out, new RegExp(`…and ${30 - shown} more$`));
    assert.equal(fitLines(['a', 'b'], 1024), 'a\nb');
    assert.equal(fitLines([], 1024), '');
});
