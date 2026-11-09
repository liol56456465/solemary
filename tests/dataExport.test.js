// "Download my data" (src/services/privacy/dataExport.js): every section is read with the
// member's id as the only parameter, columns never include other people's ids, and an
// error means no file at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXPORT_SECTIONS, buildDataExport, exportFileName } from '../src/services/privacy/dataExport.js';
import { pgConfig } from '../src/config/database/postgres.js';

const ME = '200000000000000002';

test('data export: one query per section, own id only, to-do list included', async () => {
    const seen = [];
    const query = async (text, params) => { seen.push({ text, params }); return { rows: [{ ok: true }] }; };
    const keys = { [`todo_${ME}`]: { tasks: [1] }, [`oauth:tokens:${ME}`]: { scope: 'identify guilds.join', tokens: 'SECRET-CIPHERTEXT' } };
    const file = await buildDataExport(ME, { query, readKey: async (key) => keys[key] ?? null, now: () => new Date('2026-10-31T10:00:00Z') });
    assert.equal(seen.length, EXPORT_SECTIONS.length);
    for (const { params } of seen) assert.deepEqual(params, [ME]);
    assert.equal(file.userId, ME);
    assert.equal(file.generatedAt, '2026-10-31T10:00:00.000Z');
    assert.deepEqual(file.todoList, { tasks: [1] });
    assert.equal(file.oauthTokenStored, true);
    assert.ok(!JSON.stringify(file).includes('SECRET-CIPHERTEXT'), 'the token itself is never in the file');
    const none = await buildDataExport(ME, { query, readKey: async () => null });
    assert.equal(none.oauthTokenStored, false);
    for (const [name] of EXPORT_SECTIONS) assert.deepEqual(file[name], [{ ok: true }], name);
});

test('data export: never selects other people\'s ids, note authors, images or the IP hash', () => {
    for (const [name, sql] of EXPORT_SECTIONS) {
        const text = sql(pgConfig.tables);
        const selected = text.slice(text.indexOf('SELECT') + 6, text.indexOf(' FROM '));
        for (const banned of ['moderator_id', 'decided_by,', 'decided_by ', 'redeemed_by', 'created_by', 'given_by,', 'user_a', 'user_b', 'ip_hash', 'note', 'revoke_reason', 'added_by', 'target_user_id', '*',
            'actor_id', 'author_id', 'author_username', 'ended_by', 'released_by', 'joiner_ids', 'claimedBy', 'closedBy', 'participants', 'store_message_id', ' url,', 'e.url', 'data,', 'data ']) {
            assert.ok(!selected.includes(banned), `${name} selects ${banned}`);
        }
        assert.ok(text.includes('$1') && !text.includes('$2'), `${name} uses only the member id`);
    }
});

test('data export: an error means no file; bad ids refused; file name', async () => {
    await assert.rejects(buildDataExport(ME, { query: async () => { throw new Error('db down'); } }), /db down/);
    await assert.rejects(buildDataExport('1 OR 1=1', { query: async () => ({ rows: [] }) }), /bad user id/);
    assert.equal(exportFileName(ME, new Date('2026-10-31T23:00:00Z')), `mewvo-data-${ME}-2026-10-31.json`);
});

test('data export: the new sections cover what the member is entitled to, bounded and redacted', () => {
    const byName = Object.fromEntries(EXPORT_SECTIONS.map(([name, sql]) => [name, sql(pgConfig.tables)]));
    for (const name of ['watchlist', 'noContactOrders', 'raidTimelineEvents', 'raidIncidentsJoined', 'caseNotes', 'tickets', 'giveawayEntries', 'invitesCreated']) {
        assert.ok(byName[name], `${name} section exists`);
        assert.match(byName[name], /LIMIT \d+/, `${name} is bounded`);
    }
    assert.match(byName.watchlist, /'staff' AS who_added/);
    assert.match(byName.noContactOrders, /SELECT guild_id, reason,/);
    assert.match(byName.raidTimelineEvents, /WHERE target_id = \$1/);
    assert.match(byName.raidIncidentsJoined, /joiner_ids \? \$1/);
    assert.match(byName.caseNotes, /c\.target_user_id = \$1/);
    // Evidence: only link excerpts that start with the case target's own username.
    assert.equal(byName.caseEvidenceOwnMessages, undefined, 'evidence is not exported until it stores an author id');
    assert.match(byName.tickets, /data->>'userId' = \$1/);
    assert.match(byName.giveawayEntries, /data->'participants' \? \$1/);
    assert.match(byName.invitesCreated, /inviter_id = \$1/);
});

test('data export: ticket ratings you gave (stars, comment, dates); about you as staff only stars, date and ticket number', () => {
    const sections = Object.fromEntries(EXPORT_SECTIONS.map(([name, sql]) => [name, sql(pgConfig.tables)]));
    assert.match(sections.ticketRatingsGiven, /SELECT guild_id, kind, ticket_number, rating, comment, prompted_at, rated_at, comment_at\s+FROM ticket_ratings WHERE opener_id = \$1/);
    const about = sections.ticketRatingsAboutYou;
    assert.match(about, /WHERE staff_id = \$1 AND rating IS NOT NULL/);
    const selected = about.slice(about.indexOf('SELECT') + 6, about.indexOf(' FROM '));
    for (const hidden of ['comment', 'opener_id', 'closer_id']) assert.ok(!selected.includes(hidden), `about-you leaves out ${hidden}`);
});
