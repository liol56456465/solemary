// Owner "Erase a case" (privacy/caseErase.js) against the local test database (npm run test:db):
// an active ladder warn is anonymised and still counted (ladder unchanged); any other case is
// deleted with its notes, evidence, edits and appeals; a pending appeal or a ban in force is
// refused with nothing changed; other cases are untouched; a failure rolls everything back.
// Skipped unless POSTGRES_URL points at localhost.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const url = process.env.POSTGRES_URL || '';
const skip = isLocalDatabaseUrl(url) ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';

const runId = String(Date.now()).slice(-9);
const guildId = `5${runId}00000041`;
const target = `6${runId}00000041`;
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const newCode = () => Array.from({ length: 7 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
let pgDb, erase, dbMod, counted;
const codes = [];
const q = (text, params) => pgDb.pool.query(text, params);

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    const { db } = await import('../../src/utils/database/wrapper.js');
    await db.initialize();
    erase = await import('../../src/services/privacy/caseErase.js');
    dbMod = await import('../../src/services/enforcement/db.js');
    counted = (await import('../../src/services/enforcement/caseService.js')).getCountedWarns;
    await q(`INSERT INTO mod_ladder (guild_id, user_id, level, warns_since_level) VALUES ($1, $2, 0, 1)`, [guildId, target]);
});

after(async () => {
    if (skip) return;
    await q('DELETE FROM mod_appeals WHERE case_code = ANY($1)', [codes]).catch(() => {});
    await q('DELETE FROM mod_cases WHERE case_code = ANY($1)', [codes]).catch(() => {});
    await q('DELETE FROM mod_ladder WHERE guild_id = $1', [guildId]).catch(() => {});
    await q('DELETE FROM dashboard_audit WHERE guild_id = $1', [guildId]).catch(() => {});
    await pgDb.disconnect();
});

async function addCase({ type = 'warn', status = 'active', expiresAt = null, isImported = false } = {}) {
    const code = newCode();
    codes.push(code);
    await q(`INSERT INTO mod_cases (guild_id, case_code, target_user_id, target_username, moderator_id, moderator_username, type, name, reason, prebuilt_or_custom, reason_key,
            status, expires_at, is_imported, counts_toward_level, ladder_level_after, revoke_reason, tags)
        VALUES ($1, $2, $3, 'alice', '1', 'mod', $4, $5, 'Posted her address', 'prebuilt', 'doxxing', $6, $7, $8, 0, 0, $9, '{doxx}')`,
    [guildId, code, target, type, `alice ${type} ${code}`, status, expiresAt, isImported, status === 'revoked' ? 'mistake by alice' : null]);
    await q(`INSERT INTO mod_case_notes (case_code, author_id, author_username, text) VALUES ($1, '1', 'mod', 'She lives at 1 Main St')`, [code]);
    await q(`INSERT INTO mod_case_evidence (case_code, kind, url, store_channel_id, store_message_id, excerpt, note, added_by, added_by_username)
        VALUES ($1, 'image', 'https://x', '900000000000000001', '900000000000000002', 'address text', 'n', '1', 'mod'),
               ($1, 'link', 'https://discord.com/channels/1/2/3', NULL, NULL, 'another excerpt', NULL, '1', 'mod')`, [code]);
    await q(`INSERT INTO mod_case_edits (case_code, edited_by, edited_by_username, field, old_value, new_value) VALUES ($1, '1', 'mod', 'reason', 'old private', 'Posted her address')`, [code]);
    await q(`INSERT INTO mod_appeals (kind, case_code, user_id, username, guild_id, body, status, note) VALUES ('appeal', $1, $2, 'alice', $3, '{"why":"private story"}', 'denied', 'staff note')`,
        [code, target, guildId]);
    return code;
}
const rowsOf = async (table, code) => (await q(`SELECT * FROM ${table} WHERE case_code = $1`, [code])).rows;
const options = () => ({ withTransaction: dbMod.withTransaction });

test('erase: an active ladder warn is anonymised, stays counted, ladder unchanged; evidence deleted', { skip }, async () => {
    const code = await addCase();
    const other = await addCase({ type: 'kick' });
    const preview = await erase.previewCaseErase(code.toUpperCase(), { query: dbMod.query });
    assert.equal(preview.mode, 'anonymise');
    assert.deepEqual(preview.counts, { notes: 1, evidence: 2, edits: 1, appeals: 1 });
    const before = (await counted(guildId, target, 0)).map((c) => c.case_code);
    assert.ok(before.includes(code));

    await q(`INSERT INTO dashboard_audit (guild_id, user_id, username, module, key, old, new) VALUES
        ($1, '1', 'mod', 'cases', $2, '"old private"', '"Posted her address"'), ($1, '1', 'mod', 'cases', $3, NULL, '"https://x"'),
        ($1, '1', 'mod', 'cases', $4, NULL, '"untouched"')`, [guildId, `${code}.reason`, `${code}.evidence`, `${other}.reason`]);
    const result = await erase.eraseCase(code, options());
    assert.equal(result.mode, 'anonymise');
    const { rows: audits } = await q('SELECT key, old, new FROM dashboard_audit WHERE guild_id = $1 ORDER BY id', [guildId]);
    assert.deepEqual(audits, [
        { key: `${code}.reason`, old: erase.REMOVED, new: erase.REMOVED },
        { key: `${code}.evidence`, old: null, new: erase.REMOVED },
        { key: `${other}.reason`, old: null, new: 'untouched' },
    ]);
    assert.deepEqual(result.evidenceMessages, [{ channelId: '900000000000000001', messageId: '900000000000000002' }]);

    const [row] = await rowsOf('mod_cases', code);
    assert.equal(row.reason, erase.REMOVED);
    assert.equal(row.name, `Removed on request (${code})`);
    assert.equal(row.reason_key, null);
    assert.deepEqual(row.tags, []);
    assert.equal(row.status, 'active');
    assert.equal(row.counts_toward_level, 0);
    assert.deepEqual((await counted(guildId, target, 0)).map((c) => c.case_code).sort(), before.sort(), 'still counted');
    const { rows: [ladder] } = await q('SELECT level, warns_since_level FROM mod_ladder WHERE guild_id = $1 AND user_id = $2', [guildId, target]);
    assert.deepEqual(ladder, { level: 0, warns_since_level: 1 });
    assert.deepEqual((await rowsOf('mod_case_notes', code)).map((n) => n.text), [erase.REMOVED]);
    assert.deepEqual(await rowsOf('mod_case_evidence', code), []);
    const [edit] = await rowsOf('mod_case_edits', code);
    assert.deepEqual([edit.old_value, edit.new_value], [erase.REMOVED, erase.REMOVED]);
    const [appeal] = await rowsOf('mod_appeals', code);
    assert.deepEqual([appeal.body, appeal.note], [{}, erase.REMOVED]);

    // The other case of the same member is untouched.
    const [kick] = await rowsOf('mod_cases', other);
    assert.equal(kick.reason, 'Posted her address');
    assert.equal((await rowsOf('mod_case_evidence', other)).length, 2);
});

test('erase: any other case (revoked warn, kick, imported warn, expired ban) is deleted with notes, evidence, edits, appeals', { skip }, async () => {
    for (const opts of [{ status: 'revoked' }, { type: 'kick' }, { isImported: true }, { type: 'ban', status: 'expired', expiresAt: new Date(Date.now() - 60000) }]) {
        const code = await addCase(opts);
        assert.equal((await erase.previewCaseErase(code, { query: dbMod.query })).mode, 'delete', JSON.stringify(opts));
        const result = await erase.eraseCase(code, options());
        assert.equal(result.mode, 'delete');
        for (const table of ['mod_cases', 'mod_case_notes', 'mod_case_evidence', 'mod_case_edits', 'mod_appeals']) {
            assert.deepEqual(await rowsOf(table, code), [], `${table} ${JSON.stringify(opts)}`);
        }
    }
});

test('erase: refused while an appeal is pending or a ban is in force; nothing changes', { skip }, async () => {
    const pending = await addCase({ type: 'kick' });
    await q(`UPDATE mod_appeals SET status = 'pending' WHERE case_code = $1`, [pending]);
    const ban = await addCase({ type: 'ban', expiresAt: new Date(Date.now() + 86400000) });
    const unlifted = await addCase({ type: 'mute', expiresAt: new Date(Date.now() - 60000) }); // past its end, not lifted yet
    for (const [code, pattern] of [[pending, /appeal of this case is still pending/], [ban, /still in force/], [unlifted, /still in force/]]) {
        assert.match((await erase.previewCaseErase(code, { query: dbMod.query })).refusal, pattern);
        assert.match((await erase.eraseCase(code, options())).refusal, pattern);
        const [row] = await rowsOf('mod_cases', code);
        assert.equal(row.reason, 'Posted her address');
        assert.equal((await rowsOf('mod_case_evidence', code)).length, 2);
    }
    assert.match((await erase.previewCaseErase('aaaaaaa', { query: dbMod.query })).refusal, /no case/);
    assert.match((await erase.eraseCase('not a code!', options())).refusal, /not a case code/);
});

test('erase: a database error mid-way rolls everything back', { skip }, async () => {
    const code = await addCase({ type: 'kick' });
    const failing = (fn) => dbMod.withTransaction((client) => fn({
        query: (text, params) => (/DELETE FROM mod_cases/.test(text) ? Promise.reject(new Error('boom')) : client.query(text, params)),
    }));
    await assert.rejects(erase.eraseCase(code, { withTransaction: failing }), /boom/);
    assert.equal((await rowsOf('mod_cases', code)).length, 1);
    assert.equal((await rowsOf('mod_case_evidence', code)).length, 2);
    assert.equal((await rowsOf('mod_appeals', code)).length, 1);
    assert.equal((await rowsOf('mod_case_notes', code)).length, 1);
});
