// Enforcement batch G2 against the local test database (npm run test:db):
// case evidence (mod_case_evidence) and the panel's evidence hand-off.
// Skipped unless POSTGRES_URL points at localhost: never run against Neon.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.POSTGRES_URL || '';
const isLocal = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url) || /^postgres(ql)?:\/\/(localhost|127\.0\.0\.1)/.test(url);
const skip = isLocal ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';

let pgDb, db, enforcementConfig;
const runId = String(Date.now()).slice(-9);
const guildId = `7${runId}00000002`;
const user = (n) => `6${runId}${String(n).padStart(8, '0')}`;
let codeSeq = 0;
const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
const code = () => {
    let n = Number(runId) * 100 + 50 + (codeSeq += 1);
    let out = '';
    for (let i = 0; i < 7; i += 1) { out += ALPHA[n % ALPHA.length]; n = Math.floor(n / ALPHA.length); }
    return out;
};
const codes = [];
const mod = { id: user(90), username: 'mod' };

async function insertCase(fields = {}) {
    const row = {
        guild_id: guildId, case_code: code(), target_user_id: user(1), target_username: 'target',
        moderator_id: mod.id, moderator_username: mod.username, type: 'warn', name: null, reason: 'r',
        prebuilt_or_custom: 'custom', ...fields,
    };
    row.name ??= `${row.case_code}-name`;
    codes.push(row.case_code);
    const keys = Object.keys(row);
    const { rows } = await pgDb.pool.query(
        `INSERT INTO mod_cases (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
        keys.map((k) => row[k])
    );
    return rows[0];
}

/** A fake Discord channel holding messages by id; send() stores a new one with a fresh CDN URL. */
function fakeChannel(id, messages = new Map()) {
    let seq = 0;
    const channel = {
        id,
        isTextBased: () => true,
        sent: [],
        messages: {
            fetch: async (messageId) => {
                const message = messages.get(messageId);
                if (!message) throw new Error('Unknown Message');
                return message;
            },
        },
        send: async (payload) => {
            seq += 1;
            const messageId = `${id.slice(0, -3)}${String(seq).padStart(3, '0')}`;
            const files = payload.files || [];
            const message = {
                id: messageId,
                attachments: { first: () => (files[0] ? { url: `https://cdn.example/${messageId}/${files[0].name}?ex=1` } : undefined) },
                deleted: false,
                delete: async () => { message.deleted = true; messages.delete(messageId); },
            };
            messages.set(messageId, message);
            channel.sent.push({ payload, message });
            return message;
        },
    };
    return channel;
}

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    ({ db } = await import('../../src/utils/database/wrapper.js'));
    ({ enforcementConfig } = await import('../../src/config/enforcement.js'));
    await db.initialize();
    assert.equal(db.getConnectionType(), 'postgresql');
});

after(async () => {
    if (skip) return;
    await pgDb.pool.query('DELETE FROM mod_case_evidence WHERE case_code = ANY($1)', [codes]).catch(() => {});
    await pgDb.pool.query('DELETE FROM mod_cases WHERE case_code = ANY($1)', [codes]);
    await pgDb.disconnect();
});

test('evidence: add, list in order, remove; unknown case and bad input are refused', { skip }, async () => {
    const { addEvidence, listEvidence, removeEvidence } = await import('../../src/services/enforcement/evidenceService.js');
    const record = await insertCase();

    const a = await addEvidence(record.case_code, {
        url: 'https://discord.com/channels/1/2/3', sourceMessageUrl: 'https://discord.com/channels/1/2/3',
        excerpt: `kit: ${'z'.repeat(800)}`, note: 'first', addedBy: mod,
    });
    assert.equal(a.kind, 'link');
    assert.ok(a.excerpt.length <= 500, 'excerpt capped');
    assert.equal(a.added_by, mod.id);
    const b = await addEvidence(record.case_code, { url: 'https://imgur.com/x', addedBy: { id: user(91), username: 'other' } });

    assert.deepEqual((await listEvidence(record.case_code)).map((row) => row.id), [a.id, b.id]);
    assert.equal((await removeEvidence(record.case_code, a.id)).id, a.id);
    assert.equal(await removeEvidence(record.case_code, a.id), null, 'already gone');
    const other = await insertCase();
    assert.equal(await removeEvidence(other.case_code, b.id), null, 'id of another case');
    assert.deepEqual((await listEvidence(record.case_code)).map((row) => row.id), [b.id]);

    await assert.rejects(addEvidence('zzzzzzz', { url: 'https://x.y', addedBy: mod }), /No case/);
    await assert.rejects(addEvidence(record.case_code, { kind: 'video', url: 'https://x.y', addedBy: mod }), /Unknown evidence kind/);
    await assert.rejects(addEvidence(record.case_code, { kind: 'link', addedBy: mod }), /needs a URL/);
    await assert.rejects(addEvidence(record.case_code, { kind: 'image', addedBy: mod }), /stored message/);
    await assert.rejects(addEvidence(record.case_code, { url: 'https://x.y' }), /who added/);
});

test('evidence: at most 25 per case; deleting the case removes its evidence', { skip }, async () => {
    const { addEvidence, listEvidence, MAX_EVIDENCE_PER_CASE } = await import('../../src/services/enforcement/evidenceService.js');
    const record = await insertCase();
    await Promise.all(Array.from({ length: MAX_EVIDENCE_PER_CASE }, (_, i) => addEvidence(record.case_code, { url: `https://x.y/${i}`, addedBy: mod })));
    await assert.rejects(addEvidence(record.case_code, { url: 'https://x.y/over', addedBy: mod }), /already has 25/);
    assert.equal((await listEvidence(record.case_code)).length, MAX_EVIDENCE_PER_CASE);

    await pgDb.pool.query('DELETE FROM mod_cases WHERE case_code = $1', [record.case_code]);
    assert.equal((await listEvidence(record.case_code)).length, 0, 'ON DELETE CASCADE');
});

test('captureLinks: excerpts for readable messages in this guild only', { skip }, async () => {
    const { captureLinks, parseEvidenceUrls } = await import('../../src/services/enforcement/evidenceService.js');
    const channelId = `${runId}111111111`;
    const messages = new Map([[`${runId}222222222`, { author: { username: 'kit' }, content: 'rude words', attachments: { size: 0 }, embeds: [] }]]);
    const channel = fakeChannel(channelId, messages);
    const guild = { id: guildId, channels: { cache: new Map([[channelId, channel]]), fetch: async () => null } };

    const text = [
        `https://discord.com/channels/${guildId}/${channelId}/${runId}222222222`, // readable
        `https://discord.com/channels/${guildId}/${channelId}/${runId}333333333`, // deleted
        `https://discord.com/channels/1${guildId.slice(1)}/${channelId}/${runId}222222222`, // other server
        `https://discord.com/channels/${guildId}/${channelId}/${runId}444444444`, // prefetched
        'https://imgur.com/abc',
    ].join('\n');
    const entries = parseEvidenceUrls(text);
    const prefetched = new Map([[entries[3].url, 'kit: already captured']]);
    const out = await captureLinks(guild, entries, { prefetched });
    assert.deepEqual(out.map((item) => item.excerpt), ['kit: rude words', null, null, 'kit: already captured', null]);
    assert.equal(out[1].sourceMessageUrl, entries[1].url, 'unreadable message links keep their source URL');
    assert.equal(out[4].sourceMessageUrl, null, 'plain links have no source message');
});

test('image evidence: re-hosted in the evidence channel, shown with a fresh URL, rolled back on failure', { skip }, async () => {
    const { addImageEvidence, evidenceDisplay, listEvidence } = await import('../../src/services/enforcement/evidenceService.js');
    const record = await insertCase();
    const channelId = `${runId}555555555`;
    const store = fakeChannel(channelId);
    const mainGuild = { id: enforcementConfig.mainGuildId || 'main', channels: { cache: new Map([[channelId, store]]), fetch: async () => null } };
    const client = {
        guilds: { cache: new Map([[mainGuild.id, mainGuild]]) },
        channels: { cache: new Map([[channelId, store]]), fetch: async () => null },
    };
    const saved = { main: enforcementConfig.mainGuildId, evidence: enforcementConfig.evidenceChannelId };
    enforcementConfig.mainGuildId = mainGuild.id;
    enforcementConfig.evidenceChannelId = channelId;
    try {
        await assert.rejects(addImageEvidence(client, record.case_code, { contentType: 'application/pdf', url: 'https://cdn/x.pdf', name: 'x.pdf' }, { addedBy: mod }), /must be an image/);

        const row = await addImageEvidence(client, record.case_code,
            { contentType: 'image/png', url: 'https://cdn.discordapp.com/attachments/old.png', name: 'shot.png' }, { note: 'dm screenshot', addedBy: mod });
        assert.equal(row.kind, 'image');
        assert.equal(row.store_channel_id, channelId);
        assert.equal(row.note, 'dm screenshot');
        assert.equal(store.sent.length, 1);
        assert.match(store.sent[0].payload.content, new RegExp(`case \`${record.case_code}\``));
        assert.equal(store.sent[0].payload.files[0].attachment, 'https://cdn.discordapp.com/attachments/old.png');

        const display = await evidenceDisplay(client, record.case_code);
        assert.equal(display.field.name, 'Evidence (1)');
        assert.match(display.imageUrl, new RegExp(`^https://cdn\\.example/${row.store_message_id}/shot\\.png`));
        assert.match(display.field.value, /\[image\]\(https:\/\/cdn\.example/);

        // Without a client the stored message is linked instead.
        const noClient = await evidenceDisplay(null, record.case_code);
        assert.equal(noClient.imageUrl, null);
        assert.match(noClient.field.value, /\[stored\]\(https:\/\/discord\.com\/channels\//);

        // A case that does not exist: the uploaded copy is deleted again.
        await assert.rejects(addImageEvidence(client, 'zzzzzzz', { contentType: 'image/png', url: 'https://cdn/y.png', name: 'y.png' }, { addedBy: mod }), /No case/);
        assert.equal(store.sent[1].message.deleted, true);
        assert.equal((await listEvidence(record.case_code)).length, 1);
    } finally {
        enforcementConfig.mainGuildId = saved.main;
        enforcementConfig.evidenceChannelId = saved.evidence;
    }
});

test('panel: evidence captured in the form is attached to the new case after Confirm', { skip }, async () => {
    const { attachFlowEvidence } = await import('../../src/handlers/enforcementPanel.js');
    const { listEvidence } = await import('../../src/services/enforcement/evidenceService.js');
    const record = await insertCase();
    const flow = {
        evidence: [
            { url: 'https://discord.com/channels/1/2/3', sourceMessageUrl: 'https://discord.com/channels/1/2/3', excerpt: 'kit: hi' },
            { url: 'https://imgur.com/a', sourceMessageUrl: null, excerpt: null },
        ],
    };
    const notes = await attachFlowEvidence(flow, record, mod);
    assert.deepEqual(notes, ['Evidence attached: 2 links.']);
    const rows = await listEvidence(record.case_code);
    assert.deepEqual(rows.map((row) => [row.url, row.excerpt, row.added_by]), [
        ['https://discord.com/channels/1/2/3', 'kit: hi', mod.id],
        ['https://imgur.com/a', null, mod.id],
    ]);

    // No record (e.g. unban) or no evidence: nothing happens. A failure is only a note.
    assert.deepEqual(await attachFlowEvidence(flow, null, mod), []);
    assert.deepEqual(await attachFlowEvidence({}, record, mod), []);
    const failed = await attachFlowEvidence({ evidence: [{ url: 'https://x.y' }] }, { case_code: 'zzzzzzz' }, mod);
    assert.match(failed[0], /was not saved: No case/);
});

test('record view and appeal dossier show the evidence', { skip }, async () => {
    const { addEvidence } = await import('../../src/services/enforcement/evidenceService.js');
    const { buildRecordEmbed } = await import('../../src/handlers/backgroundView.js');
    const { buildCaseDossier } = await import('../../src/services/enforcement/appealService.js');
    const record = await insertCase({ target_user_id: user(5) });
    await addEvidence(record.case_code, { url: 'https://discord.com/channels/1/2/3', excerpt: 'kit: evidence text', addedBy: mod });

    const embed = (await buildRecordEmbed(record)).toJSON();
    const field = embed.fields.find((f) => f.name === 'Evidence (1)');
    assert.ok(field, 'record view has the evidence field');
    assert.match(field.value, /kit: evidence text/);

    const [first] = await buildCaseDossier(record);
    assert.match(first.toJSON().fields.find((f) => f.name === 'Evidence (1)').value, /kit: evidence text/);
});
