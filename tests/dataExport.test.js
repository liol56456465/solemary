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
    const file = await buildDataExport(ME, { query, readKey: async (key) => (key === `todo_${ME}` ? { tasks: [1] } : null), now: () => new Date('2026-10-31T10:00:00Z') });
    assert.equal(seen.length, EXPORT_SECTIONS.length);
    for (const { params } of seen) assert.deepEqual(params, [ME]);
    assert.equal(file.userId, ME);
    assert.equal(file.generatedAt, '2026-10-31T10:00:00.000Z');
    assert.deepEqual(file.todoList, { tasks: [1] });
    for (const [name] of EXPORT_SECTIONS) assert.deepEqual(file[name], [{ ok: true }], name);
});

test('data export: never selects other people\'s ids, staff notes, evidence or the IP hash', () => {
    for (const [name, sql] of EXPORT_SECTIONS) {
        const text = sql(pgConfig.tables);
        const selected = text.slice(text.indexOf('SELECT') + 6, text.indexOf(' FROM '));
        for (const banned of ['moderator_id', 'decided_by,', 'decided_by ', 'redeemed_by', 'created_by', 'given_by,', 'user_a', 'user_b', 'ip_hash', 'note', 'revoke_reason', 'added_by', 'target_user_id', '*']) {
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
