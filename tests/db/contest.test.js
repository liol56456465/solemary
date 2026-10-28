// "Contest this" against the local test database: one contest per case (KV with TTL)
// and restoring a contested message on undo. Skipped unless POSTGRES_URL is localhost.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const url = process.env.POSTGRES_URL || '';
const isLocal = isLocalDatabaseUrl(url);
const skip = isLocal ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';

let pgDb, db, contest, registry, reviewCards;
const runId = String(Date.now()).slice(-9);
const caseCode = `c${runId.slice(-5)}`.replace(/[01ilo]/g, 'x').slice(0, 6);
const guildId = `8${runId}00000002`;

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    ({ db } = await import('../../src/utils/database/wrapper.js'));
    await db.initialize();
    contest = await import('../../src/services/automod/automodContest.js');
    registry = await import('../../src/services/automod/reviewRegistry.js');
    reviewCards = await import('../../src/services/automod/reviewCards.js');
});

after(async () => {
    if (skip) return;
    await db.delete(contest.contestKey(caseCode)).catch(() => {});
    await pgDb.disconnect();
});

const record = { case_code: caseCode, guild_id: guildId, target_user_id: '111', reason_key: 'automod:spam', type: 'warn', reason: 'Automod: Spam' };
const noGuildClient = { guilds: { cache: new Map() } };

test('one contest per case, stored with the reason', { skip }, async () => {
    const first = await contest.recordContest(noGuildClient, record, '111', '  I was quoting the rules  ');
    assert.equal(first.ok, true);
    assert.equal(first.marked, 'none', 'no review channel in the fake client');
    const stored = await contest.getContest(caseCode);
    assert.equal(stored.reason, 'I was quoting the rules');
    assert.equal(stored.userId, '111');
    const second = await contest.recordContest(noGuildClient, record, '111', 'again');
    assert.equal(second.ok, false);
    assert.match(second.message, /already contested/);
});

test('undoing a contested case restores the message without mentions', { skip }, async () => {
    registry.resetReviewRegistry();
    const entry = reviewCards.entryFrom({
        guild: { id: guildId, client: {} }, rule: 'spam', evidence: 'spammed', targetUser: { id: '111', username: 'alice' },
        channelId: '222', content: 'hello @everyone', step: { type: 'warn' }, result: { record: { case_code: caseCode } },
    });
    registry.registerCard(Object.assign(entry, { messageId: 'card1' }));
    const sent = [];
    const channel = { id: '222', isTextBased: () => true, send: async (payload) => { sent.push(payload); return {}; } };
    const client = { guilds: { cache: new Map([[guildId, { channels: { cache: new Map([['222', channel]]) } }]]) } };
    const note = await contest.restoreIfContested(client, record);
    assert.match(note, /restored in <#222>/);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].allowedMentions, { parse: [] });
    assert.match(sent[0].content, /Restored message from <@111>/);
    assert.match(sent[0].content, /> hello @everyone/);

    // Not contested: nothing restored.
    const other = { ...record, case_code: 'zzzzzz' };
    assert.equal(await contest.restoreIfContested(client, other), null);
});
