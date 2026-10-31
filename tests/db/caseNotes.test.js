// Case tags and notes against the local test database: set/clear tags, search by tag, notes
// in order, other server's case refused, used-tags autocomplete.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const url = process.env.POSTGRES_URL || '';
const skip = isLocalDatabaseUrl(url) ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';
let pgDb, notes, search;
const runId = String(Date.now()).slice(-9);
const guild = `3${runId}00000091`;
const code = `t${runId.slice(-5)}`.replace(/[01oil]/g, '9').slice(0, 6);

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    const { db } = await import('../../src/utils/database/wrapper.js');
    await db.initialize();
    notes = (await import('../../src/services/enforcement/caseNotesService.js')).caseNotes;
    search = await import('../../src/services/enforcement/caseSearchService.js');
    await pgDb.pool.query(`INSERT INTO mod_cases (guild_id, case_code, target_user_id, target_username, moderator_id, moderator_username, type, name, reason, prebuilt_or_custom, reason_key)
        VALUES ($1, $2, '2', 'm', '1', 'mod', 'warn', 'm warn 1', 'Spam', 'prebuilt', 'spam')`, [guild, code]);
});
after(async () => {
    if (skip) return;
    await pgDb.pool.query('DELETE FROM mod_case_notes WHERE case_code = $1', [code]);
    await pgDb.pool.query('DELETE FROM mod_cases WHERE case_code = $1', [code]);
    await pgDb.disconnect();
});

test('case notes and tags on the real schema', { skip }, async () => {
    assert.deepEqual((await notes.setTags(guild, code, ['alt', 'scam'])).after, ['alt', 'scam']);
    const { rows } = await search.searchCaseRecords(guild, { tag: 'scam' });
    assert.deepEqual(rows.map((r) => r.case_code), [code]);
    assert.deepEqual((await search.searchCaseRecords(guild, { tag: 'raid' })).rows, []);
    assert.deepEqual(await notes.usedTags(guild, 's'), ['scam']);
    await notes.addNote(guild, code, { id: '1', username: 'Ann' }, 'first');
    await notes.addNote(guild, code, { id: '2', username: 'Bob' }, 'second');
    assert.deepEqual((await notes.listNotes(code)).map((n) => n.text), ['first', 'second']);
    assert.equal(await notes.countNotes(code), 2);
    await assert.rejects(notes.addNote('999', code, { id: '1', username: 'x' }, 'n'), /No case/);
    assert.deepEqual((await notes.setTags(guild, code, [])).after, []);
});
