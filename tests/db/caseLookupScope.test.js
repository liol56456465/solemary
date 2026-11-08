// B1 "case lookups" against the local test database (npm run test:db): a case, its notes, tags,
// edits, appeals, keep-apart orders and watchlist entries of one server are never read or changed
// from another server, in both directions; the own server (main + support as one) still works.
// Skipped unless POSTGRES_URL points at localhost.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const url = process.env.POSTGRES_URL || '';
const skip = isLocalDatabaseUrl(url) ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';

const runId = String(Date.now()).slice(-9);
const id = (prefix, n) => `${prefix}${runId}${String(n).padStart(8, '0')}`;
const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
let seq = Number(runId) * 11;
const newCode = () => { let out = ''; let x = (seq += 17); for (let i = 0; i < 7; i += 1) { out += ALPHA[x % ALPHA.length]; x = Math.floor(x / ALPHA.length); } return out; };

const OTHER = id('5', 11);
const THIRD = id('5', 12);
const TARGET = id('6', 1);
const PEER = id('6', 2);
const admin = { id: id('6', 90), username: 'mod' };
const client = { user: { id: id('6', 99) }, guilds: { cache: new Map() }, users: { cache: new Map(), fetch: async () => { throw new Error('no user'); } } };

let pgDb, cases, edits, notes, appeals, watch, noContact, search, enforcementConfig, settings;
let MAIN, SUPPORT;
const codes = {};

async function insertCase(guildId, over = {}) {
    const code = newCode();
    await pgDb.pool.query(
        `INSERT INTO mod_cases (guild_id, case_code, target_user_id, target_username, moderator_id, moderator_username, type, name, reason, prebuilt_or_custom, is_test)
         VALUES ($1, $2, $3, 'target', $4, 'mod', 'warn', $5, 'spam', 'prebuilt', $6)`,
        [guildId, code, over.target || TARGET, admin.id, `scope warn ${code}`, over.isTest ?? false],
    );
    return code;
}
async function insertAppeal(code, guildId, status = 'pending') {
    await pgDb.pool.query(`INSERT INTO mod_appeals (kind, case_code, user_id, username, guild_id, status) VALUES ('appeal', $1, $2, 'target', $3, $4)`,
        [code, TARGET, guildId, status]);
}

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    const { db } = await import('../../src/utils/database/wrapper.js');
    await db.initialize();
    ({ enforcementConfig } = await import('../../src/config/enforcement.js'));
    settings = await import('../../src/services/settings/guildSettings.js');
    cases = await import('../../src/services/enforcement/caseService.js');
    edits = await import('../../src/services/enforcement/caseEditService.js');
    notes = (await import('../../src/services/enforcement/caseNotesService.js')).caseNotes;
    appeals = await import('../../src/services/enforcement/appealService.js');
    watch = await import('../../src/services/enforcement/watchlistService.js');
    noContact = await import('../../src/services/enforcement/noContactService.js');
    search = await import('../../src/services/enforcement/caseSearchService.js');
    MAIN = enforcementConfig.mainGuildId;
    SUPPORT = enforcementConfig.supportGuildId;
    assert.ok(MAIN && SUPPORT && MAIN !== SUPPORT, 'test env has both home servers');
    for (const guildId of [OTHER, THIRD]) settings.setSettingsCacheForTests(guildId, {});
    codes.main = await insertCase(MAIN);
    codes.support = await insertCase(SUPPORT);
    codes.other = await insertCase(OTHER);
    codes.third = await insertCase(THIRD);
});

after(async () => {
    if (skip) return;
    for (const guildId of [OTHER, THIRD]) settings.setSettingsCacheForTests(guildId, null);
    const all = Object.values(codes);
    await pgDb.pool.query('DELETE FROM mod_case_notes WHERE case_code = ANY($1::varchar[])', [all]);
    await pgDb.pool.query('DELETE FROM mod_case_edits WHERE case_code = ANY($1::varchar[])', [all]);
    await pgDb.pool.query('DELETE FROM mod_appeals WHERE case_code = ANY($1::varchar[])', [all]);
    await pgDb.pool.query('DELETE FROM mod_cases WHERE case_code = ANY($1::varchar[])', [all]);
    await pgDb.pool.query('DELETE FROM mod_watchlist WHERE user_id = ANY($1::varchar[])', [[TARGET, PEER]]);
    await pgDb.pool.query('DELETE FROM no_contact_orders WHERE user_a = ANY($1::varchar[]) OR user_b = ANY($1::varchar[])', [[TARGET, PEER]]);
    await pgDb.disconnect();
});

test('getCaseByCode on the real schema: other servers null both ways; home servers one; any-server finds all', { skip }, async () => {
    const cross = [[codes.other, MAIN], [codes.other, SUPPORT], [codes.main, OTHER], [codes.support, OTHER], [codes.third, OTHER]];
    for (const [code, caller] of cross) assert.equal(await cases.getCaseByCode(code, caller), null);
    for (const [code, caller] of [[codes.main, MAIN], [codes.support, MAIN], [codes.main, SUPPORT], [codes.other, OTHER]]) {
        assert.equal((await cases.getCaseByCode(code, caller))?.case_code, code);
    }
    for (const code of Object.values(codes)) assert.equal((await cases.getCaseByCodeAnyServer(code))?.case_code, code);
});

test('editCase / voidCase: another server is refused both ways and nothing changes; own server edits', { skip }, async () => {
    for (const [code, caller] of [[codes.other, MAIN], [codes.main, OTHER], [codes.third, OTHER]]) {
        await assert.rejects(edits.editCase(client, { guildId: caller, caseCode: code, editor: admin, reason: 'hijacked' }), /No case with code/);
        await assert.rejects(edits.voidCase(client, { guildId: caller, caseCode: code, admin, reason: 'hijacked' }), /No case with code/);
    }
    const { rows } = await pgDb.pool.query('SELECT reason, voided_at FROM mod_cases WHERE case_code = ANY($1::varchar[])', [[codes.other, codes.main, codes.third]]);
    assert.ok(rows.every((r) => r.reason === 'spam' && r.voided_at === null), 'untouched');
    assert.equal(await edits.countCaseEdits(codes.other), 0);

    const { after: edited } = await edits.editCase(client, { guildId: OTHER, caseCode: codes.other, editor: admin, reason: 'own edit' });
    assert.equal(edited.reason, 'own edit');
    assert.equal(await edits.countCaseEdits(codes.other), 1);
});

test('case notes and tags: another server refused both ways; own server works', { skip }, async () => {
    for (const [code, caller] of [[codes.other, MAIN], [codes.main, OTHER]]) {
        await assert.rejects(notes.addNote(caller, code, admin, 'leak'), /No case with code/);
        await assert.rejects(notes.setTags(caller, code, ['x']), /No case with code/);
    }
    assert.equal(await notes.countNotes(codes.other), 0);
    await notes.addNote(OTHER, codes.other, admin, 'own note');
    assert.deepEqual((await notes.setTags(OTHER, codes.other, ['alt'])).after, ['alt']);
    assert.equal(await notes.countNotes(codes.other), 1);
});

test('appeal statuses, pending appeals and the dossier count: this server\'s appeals only', { skip }, async () => {
    await insertAppeal(codes.main, MAIN);
    await insertAppeal(codes.support, MAIN); // a support-server case is decided in the main server
    await insertAppeal(codes.other, OTHER);
    await insertAppeal(codes.third, THIRD, 'denied');

    const home = await cases.getLatestAppealStatuses(TARGET, MAIN);
    assert.deepEqual([...home.keys()].sort(), [codes.main, codes.support].sort());
    assert.deepEqual([...(await cases.getLatestAppealStatuses(TARGET, SUPPORT)).keys()].sort(), [codes.main, codes.support].sort());
    assert.deepEqual([...(await cases.getLatestAppealStatuses(TARGET, OTHER)).keys()], [codes.other]);

    assert.deepEqual((await cases.listUserAppeals(TARGET, 10, { guildId: OTHER })).map((r) => r.case_code), [codes.other]);
    assert.equal((await cases.listUserAppeals(TARGET, 10)).length, 4, 'the member\'s own list spans servers');

    const pendingOther = (await appeals.listPendingAppeals(50, OTHER)).map((r) => r.case_code);
    assert.deepEqual(pendingOther, [codes.other]);
    const pendingMain = (await appeals.listPendingAppeals(50, MAIN)).map((r) => r.case_code);
    assert.ok(pendingMain.includes(codes.main) && !pendingMain.includes(codes.other) && !pendingMain.includes(codes.third));

    const total = async (code) => {
        const embeds = await appeals.buildCaseDossier(await cases.getCaseByCodeAnyServer(code), { client });
        const history = embeds.at(-1).data.fields.find((f) => f.name === 'Appeals filed in total');
        return Number(history.value);
    };
    assert.equal(await total(codes.other), 1, 'OTHER\'s dossier counts only OTHER\'s appeals');
    assert.equal(await total(codes.main), 2, 'the main server counts both home servers\' appeals');
});

test('watchlist and keep-apart: end and list only in their own server (both directions)', { skip }, async () => {
    const entry = await watch.addWatch(client, { guildId: OTHER, userId: TARGET, username: 'target', reason: 'scope test', createdBy: admin });
    const homeEntry = await watch.addWatch(client, { guildId: MAIN, userId: PEER, username: 'peer', reason: 'scope test', createdBy: admin });
    assert.equal(await watch.endWatch(client, { guildId: MAIN, id: Number(entry.id), endedBy: admin }), null, 'main → other');
    assert.equal(await watch.endWatch(client, { guildId: OTHER, id: Number(homeEntry.id), endedBy: admin }), null, 'other → main');
    assert.ok(!(await watch.listActiveWatches(MAIN, 200)).some((r) => r.id === entry.id), 'main list never shows OTHER\'s entry');
    assert.ok(!(await watch.listActiveWatches(OTHER, 200)).some((r) => r.id === homeEntry.id), 'OTHER\'s list never shows main\'s entry');
    assert.ok((await watch.endWatch(client, { guildId: OTHER, id: Number(entry.id), endedBy: admin }))?.ended_at, 'own server ends it');
    assert.ok((await watch.endWatch(client, { guildId: MAIN, id: Number(homeEntry.id), endedBy: admin }))?.ended_at);

    const insertOrder = async (guildId) => (await pgDb.pool.query(
        `INSERT INTO no_contact_orders (guild_id, user_a, user_b, until, created_by, reason) VALUES ($1, $2, $3, NOW() + interval '1 day', $4, 'scope') RETURNING id`,
        [guildId, TARGET, PEER, admin.id])).rows[0].id;
    const otherOrder = await insertOrder(OTHER);
    const mainOrder = await insertOrder(MAIN);
    assert.equal(await noContact.endNoContactOrder(client, { guildId: MAIN, id: Number(otherOrder), endedBy: admin }), null, 'main → other');
    assert.equal(await noContact.endNoContactOrder(client, { guildId: OTHER, id: Number(mainOrder), endedBy: admin }), null, 'other → main');
    assert.ok(!(await noContact.listActiveNoContactOrders(MAIN, 200)).some((r) => r.id === otherOrder));
    assert.ok(!(await noContact.listActiveNoContactOrders(OTHER, 200)).some((r) => r.id === mainOrder));
    assert.equal((await noContact.endNoContactOrder(client, { guildId: OTHER, id: Number(otherOrder), endedBy: admin }))?.order?.id, otherOrder, 'own server ends it');
});

test('case search and autocomplete: this server\'s cases only', { skip }, async () => {
    const inOther = (await search.searchCaseRecords(OTHER, { memberId: TARGET })).rows.map((r) => r.case_code);
    assert.deepEqual(inOther, [codes.other]);
    const inMain = (await search.searchCaseRecords(MAIN, { memberId: TARGET })).rows.map((r) => r.case_code);
    assert.ok(inMain.includes(codes.main) && !inMain.includes(codes.other) && !inMain.includes(codes.third));
    assert.deepEqual((await edits.searchCases(OTHER, 'scope warn')).map((r) => r.case_code), [codes.other]);
    assert.ok(!(await edits.searchCases(MAIN, codes.other)).length, 'main autocomplete never offers OTHER\'s code');
});
