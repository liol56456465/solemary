// applicationReviewService: the review /app-admin review and the dashboard share —
// status (pending only), DM, log message, role on approval — with a Map-backed fake
// key-value store and fake Discord objects (no database, no Discord).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getApplicationKey } from '../src/utils/database/keys.js';
import { reviewApplicationAndNotify } from '../src/services/applicationReviewService.js';

const GUILD = '100000000000000001';
const USER = '300000000000000004';
const ROLE = '600000000000000001';
const LOG = '500000000000000001';
const ID = '1700000000000-abc';

function world({ status = 'pending', dmFails = false, roleFails = false } = {}) {
    const data = new Map([[getApplicationKey(GUILD, ID), {
        id: ID, guildId: GUILD, userId: USER, username: 'member', roleId: ROLE, roleName: 'Helper', status,
        createdAt: new Date().toISOString(), answers: [{ question: 'Why?', answer: 'Cats' }], logChannelId: LOG, logMessageId: '700000000000000001',
    }]]);
    const sent = [];
    const edits = [];
    const rolesAdded = [];
    const client = {
        db: {
            get: async (key, fallback = null) => (data.has(key) ? structuredClone(data.get(key)) : fallback),
            set: async (key, value) => { data.set(key, structuredClone(value)); return true; },
            list: async (prefix) => [...data.keys()].filter((k) => k.startsWith(prefix)),
            delete: async (key) => data.delete(key),
        },
        users: { fetch: async () => ({ send: async (payload) => { if (dmFails) throw new Error('Cannot send messages to this user'); sent.push(payload); } }) },
    };
    const logMessage = { embeds: [{ title: 'Application', fields: [{ name: 'Status', value: 'In Progress' }, { name: 'User', value: 'member' }] }], edit: async (payload) => { edits.push(payload); } };
    const guild = {
        id: GUILD, name: 'Main',
        channels: { cache: new Map([[LOG, { messages: { fetch: async () => logMessage } }]]) },
        members: { fetch: async () => ({ roles: { add: async (roleId) => { if (roleFails) throw new Error('Missing Permissions'); rolesAdded.push(roleId); } } }) },
    };
    return { data, client, guild, sent, edits, rolesAdded };
}

test('approve: status saved with reviewer and note, applicant DMed, log message status updated, role given', async () => {
    const w = world();
    const result = await reviewApplicationAndNotify(w.client, w.guild, ID, { action: 'approve', reason: '  Welcome aboard ', reviewerId: '200000000000000002' });
    assert.equal(result.status, 'approved');
    assert.equal(result.reason, 'Welcome aboard');
    assert.equal(result.dmDelivered, true);
    assert.equal(result.logUpdated, true);
    assert.equal(result.roleAdded, true);
    const saved = w.data.get(getApplicationKey(GUILD, ID));
    assert.equal(saved.status, 'approved');
    assert.equal(saved.reviewer, '200000000000000002');
    assert.equal(saved.reviewMessage, 'Welcome aboard');
    assert.match(w.sent[0].embeds[0].data.description, /has been \*\*approved\*\*[\s\S]*Welcome aboard/);
    assert.deepEqual(w.edits[0].components, []);
    assert.equal(w.edits[0].embeds[0].data.fields[0].name, 'Status');
    assert.match(w.edits[0].embeds[0].data.fields[0].value, /Accepted/);
    assert.deepEqual(w.rolesAdded, [ROLE]);
});

test('deny: no role; an empty note becomes "No reason provided."; a failed DM or role is reported, not thrown', async () => {
    const w = world({ dmFails: true });
    const result = await reviewApplicationAndNotify(w.client, w.guild, ID, { action: 'deny', reason: '', reviewerId: '200000000000000002' });
    assert.equal(result.status, 'denied');
    assert.equal(result.reason, 'No reason provided.');
    assert.equal(result.dmDelivered, false);
    assert.equal(result.roleAdded, null);
    assert.deepEqual(w.rolesAdded, []);
    const r = world({ roleFails: true });
    assert.equal((await reviewApplicationAndNotify(r.client, r.guild, ID, { action: 'approve', reviewerId: '1' })).roleAdded, false);
    assert.equal(r.data.get(getApplicationKey(GUILD, ID)).status, 'approved');
});

test('refusals change nothing: unknown application, already reviewed, bad action', async () => {
    const w = world({ status: 'denied' });
    await assert.rejects(reviewApplicationAndNotify(w.client, w.guild, 'nope-1', { action: 'approve', reviewerId: '1' }), (e) => /not found/i.test(e.userMessage));
    await assert.rejects(reviewApplicationAndNotify(w.client, w.guild, ID, { action: 'approve', reviewerId: '1' }), (e) => /already been reviewed/.test(e.userMessage));
    const p = world();
    await assert.rejects(reviewApplicationAndNotify(p.client, p.guild, ID, { action: 'promote', reviewerId: '1' }), (e) => /approve or deny/.test(e.userMessage));
    assert.equal(w.data.get(getApplicationKey(GUILD, ID)).status, 'denied');
    assert.equal(p.data.get(getApplicationKey(GUILD, ID)).status, 'pending');
    assert.deepEqual([...w.sent, ...p.sent, ...w.rolesAdded, ...p.rolesAdded], []);
});
