// Raid timeline recording (services/automod/incidentTimeline.js and the hooks in raidService,
// automodService, joinGate): event validation (no content, 200 characters, ids only), the
// 2,000-event bound and dropped count, the 90-day purge, recording that never throws, the
// page data built minute by minute, and a lockdown that records its steps and still runs
// when every timeline write fails.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.MAIN_GUILD_ID ??= '100000000000000001';
const GUILD = process.env.MAIN_GUILD_ID;

const timeline = await import('../../src/services/automod/incidentTimeline.js');
const {
    EVENT_KINDS, MAX_EVENTS_PER_INCIDENT, RETENTION_DAYS, addTimelineEvent, bucketMinutes, buildTimeline, cleanDetail, closeTimeline,
    createTimelineStore, formatSpan, normalizeEvent, openTimeline, purgeIncidentTimelines, setTimelineStoreForTest,
} = timeline;
const raid = await import('../../src/services/automod/raidService.js');
const { actOn, resetAutomodState, setAutomodDepsForTest } = await import('../../src/services/automod/automodService.js');
const { normalizeSettings } = await import('../../src/services/automod/automodSettings.js');
const { gateCheckLabels } = await import('../../src/services/automod/joinGate.js');
const { automodConfig } = await import('../../src/config/automod.js');
const { db } = await import('../../src/utils/database/wrapper.js');
const { MemoryStorage } = await import('../../src/utils/memoryStorage.js');

const DAY = 86_400_000;
const T0 = Date.parse('2026-11-03T14:00:00Z');
const id = (n) => `3000000000000000${String(n).padStart(2, '0')}`;

afterEach(() => {
    setTimelineStoreForTest();
    setAutomodDepsForTest();
    resetAutomodState();
});

// ── validation ────────────────────────────────────────────────────────────

test('events: only recorded kinds, ids must be snowflakes, detail is one short line', () => {
    assert.equal(normalizeEvent({ kind: 'join' }), null, 'joins come from member_events, never written here');
    assert.equal(normalizeEvent({ kind: 'message', detail: 'x' }), null);
    assert.equal(normalizeEvent(null), null);
    const row = normalizeEvent({ kind: 'automod', targetId: id(1), actorId: 'not-an-id', detail: 'Spam:\n\u0007 message  deleted', at: T0 }, T0);
    assert.deepEqual(row, { at: new Date(T0), kind: 'automod', actorId: null, targetId: id(1), detail: 'Spam: message deleted' });
    assert.equal(cleanDetail('x'.repeat(500)).length, 200);
    assert.equal(cleanDetail('   '), null);
    assert.equal(normalizeEvent({ kind: 'panic', at: 'garbage' }, T0).at.getTime(), T0, 'a bad time falls back to now');
    for (const kind of Object.keys(EVENT_KINDS)) assert.ok(['steps', 'actions', 'joins', 'leaves'].includes(EVENT_KINDS[kind].group), kind);
});

test('join gate labels carry the check names only, never the member\'s name', () => {
    const hits = [
        { check: 'links', reason: 'link in their name ("discord.gg/spam")' },
        { check: 'botname', reason: 'generated-looking username ("bob12345")' },
        { check: 'links', reason: 'again' },
    ];
    const text = gateCheckLabels(hits);
    assert.equal(text, 'Link or invite in their name; Generated-looking username');
    assert.ok(!text.includes('spam') && !text.includes('bob'));
});

// ── the store: bound, purge, guild scope ──────────────────────────────────

/** A fake query that behaves like the SQL: the CTE inserts only while event_count < max. */
function fakeDb() {
    const incidents = new Map();
    const events = [];
    const calls = [];
    let next = 1;
    const query = async (text, params) => {
        calls.push({ text, params });
        if (text.startsWith('INSERT INTO incident_timelines')) {
            const row = { id: String(next++), guild_id: params[0], trigger_kind: params[1], started_at: params[2], ended_at: null, event_count: 0, dropped_events: 0 };
            incidents.set(row.id, row);
            return { rows: [{ id: row.id }], rowCount: 1 };
        }
        if (text.includes('WITH slot AS')) {
            const row = incidents.get(String(params[0]));
            if (!row || row.event_count >= params[1]) return { rows: [], rowCount: 0 };
            row.event_count += 1;
            events.push({ incident_id: row.id, at: params[2], kind: params[3], actor_id: params[4], target_id: params[5], detail: params[6] });
            return { rows: [], rowCount: 1 };
        }
        if (text.includes('dropped_events = dropped_events + 1')) {
            const row = incidents.get(String(params[0]));
            if (row) row.dropped_events += 1;
            return { rows: [], rowCount: row ? 1 : 0 };
        }
        if (text.startsWith('UPDATE incident_timelines SET ended_at')) {
            const row = incidents.get(String(params[0]));
            if (!row || row.ended_at) return { rowCount: 0 };
            row.ended_at = params[1];
            row.ended_by = params[2];
            return { rowCount: 1 };
        }
        if (text.startsWith('DELETE FROM incident_timelines')) return { rowCount: 2 };
        if (text.includes('FROM incident_timelines WHERE id = $1 AND guild_id = $2')) {
            const row = incidents.get(String(params[0]));
            return { rows: row && row.guild_id === params[1] ? [row] : [] };
        }
        return { rows: [], rowCount: 0 };
    };
    return { query, incidents, events, calls };
}

test('bound: at most maxEvents per incident, the rest only counted; the bound is in the INSERT statement', async () => {
    const fake = fakeDb();
    const store = createTimelineStore({ query: fake.query, maxEvents: 3 });
    const incidentId = await store.open({ guildId: GUILD, startedAt: new Date(T0) });
    const results = [];
    for (let i = 0; i < 5; i += 1) results.push(await store.addEvent(incidentId, { kind: 'automod', targetId: id(i), detail: `hit ${i}` }));
    assert.deepEqual(results, ['stored', 'stored', 'stored', 'dropped', 'dropped']);
    assert.equal(fake.events.length, 3);
    assert.equal(fake.incidents.get(incidentId).dropped_events, 2);
    const insert = fake.calls.find((c) => c.text.includes('WITH slot AS'));
    assert.match(insert.text, /event_count < \$2/);
    assert.match(insert.text, /INSERT INTO incident_events/);
    assert.equal(insert.params[1], 3);
    assert.equal(await store.addEvent(incidentId, { kind: 'join' }), 'invalid');
    assert.equal(MAX_EVENTS_PER_INCIDENT, 2000);
    await assert.rejects(store.open({ guildId: GUILD, trigger: 'nope' }), /Unknown incident trigger/);
});

test('close sets the end once; get never returns another guild\'s incident and refuses odd ids without a query', async () => {
    const fake = fakeDb();
    const store = createTimelineStore({ query: fake.query });
    const incidentId = await store.open({ guildId: GUILD });
    assert.equal(await store.close(incidentId, { endedBy: id(9) }), true);
    assert.equal(await store.close(incidentId, { endedBy: id(8) }), false);
    assert.equal(fake.incidents.get(incidentId).ended_by, id(9));
    assert.ok(await store.get(GUILD, incidentId));
    assert.equal(await store.get('999999999999999999', incidentId), null);
    const before = fake.calls.length;
    assert.equal(await store.get(GUILD, '1; DROP TABLE x'), null);
    assert.equal(await store.get(GUILD, '9'.repeat(30)), null);
    assert.equal(fake.calls.length, before, 'no query for a bad id');
});

test('retention: incidents that ended (or started, never closed) more than 90 days ago are deleted', async () => {
    const fake = fakeDb();
    setTimelineStoreForTest(createTimelineStore({ query: fake.query }));
    assert.equal(await purgeIncidentTimelines(T0), 2);
    const call = fake.calls.at(-1);
    assert.match(call.text, /DELETE FROM incident_timelines WHERE COALESCE\(ended_at, started_at\) < \$1/);
    assert.equal(call.params[0].getTime(), T0 - RETENTION_DAYS * DAY);
    assert.equal(RETENTION_DAYS, 90);
    // A database error reaches the cron wrapper (runSafeTask logs it); nothing is hidden.
    setTimelineStoreForTest({ purge: async () => { throw new Error('db down'); } });
    await assert.rejects(purgeIncidentTimelines(T0), /db down/);
});

test('recording never throws: a failing store gives null / failed / false', async () => {
    const boom = async () => { throw new Error('db down'); };
    setTimelineStoreForTest({ open: boom, addEvent: boom, close: boom, linkReport: boom });
    assert.equal(await openTimeline({ guildId: GUILD }), null);
    assert.equal(await addTimelineEvent('1', { kind: 'panic' }), 'failed');
    assert.equal(await addTimelineEvent(null, { kind: 'panic' }), 'invalid');
    assert.equal(await closeTimeline('1', {}), false);
    assert.equal(await timeline.linkTimelineReport('1', '2'), false);
});

// ── page data ─────────────────────────────────────────────────────────────

const at = (sec) => new Date(T0 + sec * 1000);

function sampleIncident(overrides = {}) {
    return { id: '7', guild_id: GUILD, trigger_kind: 'join_raid', started_at: at(30), ended_at: at(15 * 60), ended_by: id(90), report_id: '4', event_count: 5, dropped_events: 0, ...overrides };
}
const sampleEvents = [
    { id: 1, at: at(30), kind: 'lockdown_start', detail: '10 accounts joined within 60 seconds' },
    { id: 2, at: at(31), kind: 'verification', detail: 'Raised to High' },
    { id: 3, at: at(32), kind: 'panic', detail: 'Paused until 16:00 UTC' },
    { id: 4, at: at(95), kind: 'gate_kick', target_id: id(3), detail: 'New account' },
    { id: 5, at: at(15 * 60), kind: 'lockdown_end', actor_id: id(90), detail: 'Ended by admin' },
];
const sampleSources = {
    members: [
        { id: 1, user_id: id(1), kind: 'join', created_at: at(5) },
        { id: 2, user_id: id(2), kind: 'join', created_at: at(20) },
        { id: 3, user_id: id(5), kind: 'join', created_at: at(70) },
        { id: 4, user_id: id(3), kind: 'leave', created_at: at(96) },
    ],
    cases: [{ id: 9, case_code: 'abc2345', type: 'kick', target_user_id: id(2), target_username: 'spammer', moderator_id: id(99), moderator_username: 'Mewvo', is_auto: true, created_at: at(100) }],
    audit: [{ id: 1, user_id: id(90), username: 'admin', module: 'automod', key: 'lockdown', created_at: at(15 * 60 + 2) }],
    report: { id: 4, joiner_ids: [id(1), id(2)], released_at: null },
    truncated: {},
};

test('timeline: header totals, actions by type, minute groups with counts, raid joiners marked', () => {
    const t = buildTimeline({ incident: sampleIncident(), events: sampleEvents, sources: sampleSources });
    const h = t.header;
    assert.equal(h.status, 'ended');
    assert.equal(h.durationMs, (15 * 60 - 30) * 1000);
    assert.equal(h.trigger, 'Join raid (many accounts joined at once)');
    assert.equal(h.joins, 3);
    assert.equal(h.leaves, 1);
    assert.equal(h.raidJoiners, 2);
    assert.deepEqual(h.actions, { ban: 0, kick: 1, mute: 0, warn: 0, gate_kick: 1, gate_flag: 0, automod: 0, mass_block: 0 });
    assert.equal(h.verification, 'Raised to High');
    assert.equal(h.panic, 'Paused until 16:00 UTC');
    assert.equal(t.total, 11);
    assert.deepEqual(t.minutes.map((m) => new Date(m.start).toISOString().slice(11, 16)), ['14:00', '14:01', '14:15']);
    assert.deepEqual(t.minutes[0].counts, { joins: 2, leaves: 0, actions: 0, steps: 3 });
    assert.deepEqual(t.minutes[1].counts, { joins: 1, leaves: 1, actions: 2, steps: 0 });
    const joins = t.minutes[0].items.filter((i) => i.kind === 'join');
    assert.deepEqual(joins.map((i) => i.detail), ['Raid joiner', 'Raid joiner']);
    const kase = t.minutes[1].items.find((i) => i.kind === 'case');
    assert.equal(kase.detail, 'Kick by automod (raid joiner)');
    assert.equal(kase.actorId, null);
    // Order inside a minute is by time.
    const times = t.minutes[1].items.map((i) => i.at.getTime());
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
    assert.equal(t.chart.bucketMinutes, 1);
    assert.equal(t.chart.buckets.reduce((n, b) => n + b.joins, 0), 3);
    assert.equal(t.chart.buckets.reduce((n, b) => n + b.actions, 0), 2);
});

test('timeline: running and never-closed incidents; chart stays at most 60 bars', () => {
    const open = sampleIncident({ ended_at: null, ended_by: null });
    const running = buildTimeline({ incident: open, events: sampleEvents.slice(0, 3), sources: {}, active: true, now: T0 + 3 * 3600 * 1000 });
    assert.equal(running.header.status, 'ongoing');
    assert.equal(running.header.raidJoiners, null, 'no report yet');
    assert.ok(running.chart.buckets.length <= 60);
    assert.equal(running.chart.bucketMinutes, 5);
    const unread = buildTimeline({ incident: open, events: sampleEvents.slice(0, 3), sources: {}, active: null });
    assert.equal(unread.header.status, 'unread', 'a failed lockdown read is not shown as a lost end');
    const lost = buildTimeline({ incident: open, events: sampleEvents.slice(0, 3), sources: {}, active: false });
    assert.equal(lost.header.status, 'unknown');
    assert.equal(lost.header.durationMs, 2000, 'ends with the last event');
    assert.equal(bucketMinutes(30 * 60 * 1000), 1);
    assert.equal(bucketMinutes(61 * 60 * 1000), 2);
    assert.equal(bucketMinutes(3 * DAY), 120);
    assert.equal(formatSpan(30 * 1000), 'under a minute');
    assert.equal(formatSpan(65 * 60 * 1000), '1 h 5 min');
    assert.equal(formatSpan(DAY + 60 * 1000), '1 d 1 min');
});

// ── raidService: a lockdown records its steps, and runs without the timeline ─

function memoryDb() {
    db.db = new MemoryStorage();
    db.useFallback = true;
    db.initialized = true;
    db.connectionType = 'memory';
}

function fakeGuild() {
    const calls = [];
    const guild = {
        id: GUILD, name: 'Main', verificationLevel: 1,
        setVerificationLevel: async (level) => { calls.push(['verification', level]); guild.verificationLevel = level; },
        setIncidentActions: async (value) => { calls.push(['incident', value]); },
        members: { me: { permissions: { has: () => true } } },
        fetchOwner: async () => null,
        client: { channels: { fetch: async () => null, cache: new Map() }, guilds: { cache: new Map() }, users: { fetch: async () => null } },
    };
    return { guild, calls };
}

/** A store in memory that records every call. */
function recordingStore() {
    const log = [];
    let next = 40;
    return {
        log,
        open: async (fields) => { log.push(['open', fields]); return String(next++); },
        addEvent: async (incidentId, event) => { log.push(['event', incidentId, event]); return 'stored'; },
        close: async (incidentId, fields) => { log.push(['close', incidentId, fields]); return true; },
        linkReport: async (incidentId, reportId) => { log.push(['link', incidentId, reportId]); return true; },
    };
}

async function raidJoins(guild, count, from = 1) {
    for (let i = 0; i < count; i += 1) await raid.recordJoin({ id: id(from + i), guild });
}

test('lockdown: opens an incident after the protective steps, records start, mid-incident and end events, closes it', async () => {
    memoryDb();
    const store = recordingStore();
    setTimelineStoreForTest(store);
    const { guild, calls } = fakeGuild();
    await raidJoins(guild, automodConfig.raidJoins);
    // The protective steps are done and saved when the join returns; the timeline follows outside the lock.
    const saved = await raid.getLockdownState(GUILD);
    assert.equal(saved.raisedVerification, true);
    assert.equal(saved.incidentActions.applied, true);
    assert.deepEqual(calls[0], ['verification', 3]);
    assert.equal(calls[1][0], 'incident');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const state = await raid.getLockdownState(GUILD);
    assert.equal(state.active, true);
    assert.equal(state.timelineId, '40');
    assert.equal(store.log[0][0], 'open');
    const kinds = () => store.log.filter((e) => e[0] === 'event').map((e) => e[2].kind);
    assert.deepEqual(kinds(), ['lockdown_start', 'verification', 'panic']);
    const start = store.log.find((e) => e[0] === 'event' && e[2].kind === 'lockdown_start')[2];
    assert.equal(start.detail, `${automodConfig.raidJoins} accounts joined within ${automodConfig.raidWindowMs / 1000} seconds`);
    assert.match(store.log.find((e) => e[0] === 'event' && e[2].kind === 'panic')[2].detail, /^Paused until \d\d:\d\d UTC$/);

    // Other code adds to the running incident.
    assert.equal(await raid.noteIncidentEvent(GUILD, { kind: 'gate_kick', targetId: id(50), detail: 'New account' }), 'stored');

    assert.equal(await raid.endLockdown(guild, { id: id(90), username: 'admin' }), true);
    assert.deepEqual(kinds(), ['lockdown_start', 'verification', 'panic', 'gate_kick', 'verification', 'panic', 'lockdown_end']);
    const end = store.log.find((e) => e[0] === 'event' && e[2].kind === 'lockdown_end')[2];
    assert.equal(end.actorId, id(90));
    const close = store.log.find((e) => e[0] === 'close');
    assert.equal(close[1], '40');
    assert.equal(close[2].endedBy, id(90));
    // No lockdown: nothing is recorded.
    assert.equal(await raid.noteIncidentEvent(GUILD, { kind: 'automod', targetId: id(1) }), 'inactive');
});

test('lockdown: every timeline write failing changes nothing for the protection', async () => {
    memoryDb();
    const boom = async () => { throw new Error('db down'); };
    setTimelineStoreForTest({ open: boom, addEvent: boom, close: boom, linkReport: boom });
    const { guild, calls } = fakeGuild();
    await raidJoins(guild, automodConfig.raidJoins, 20);
    const state = await raid.getLockdownState(GUILD);
    assert.equal(state.active, true);
    assert.equal(state.timelineId ?? null, null);
    assert.equal(state.raisedVerification, true);
    assert.equal(state.incidentActions.applied, true);
    assert.equal(await raid.noteIncidentEvent(GUILD, { kind: 'automod', targetId: id(1) }), 'inactive', 'no incident to add to');
    assert.equal(await raid.endLockdown(guild, { id: id(90), username: 'admin' }), true);
    assert.deepEqual(calls.at(-2), ['verification', 1], 'verification restored');
    assert.deepEqual(calls.at(-1), ['incident', { invitesDisabledUntil: null, dmsDisabledUntil: null }], 'invites and DMs resumed');
    assert.equal(await raid.getLockdownState(GUILD), null);

    // An incident that opened but whose event writes fail: the lockdown still ends normally.
    setTimelineStoreForTest({ open: async () => '77', addEvent: boom, close: boom, linkReport: boom });
    await raidJoins(guild, automodConfig.raidJoins, 40);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await raid.getLockdownState(GUILD)).timelineId, '77');
    assert.equal(await raid.noteIncidentEvent(GUILD, { kind: 'automod', targetId: id(1) }), 'failed');
    assert.equal(await raid.endLockdown(guild, { id: id(90), username: 'admin' }), true);
    assert.equal(await raid.getLockdownState(GUILD), null);
});

test('attach: an incident opened after its lockdown already ended is closed at once, not left open', async () => {
    memoryDb();
    const store = recordingStore();
    setTimelineStoreForTest(store);
    const result = await raid.attachTimeline(GUILD, {
        joinerCount: 10, raised: false, panic: null,
        timeline: { startedAt: new Date(T0).toISOString(), previous: 3, verifiedAt: new Date(T0), pausedAt: new Date(T0) },
    });
    assert.equal(result, null);
    assert.equal(await raid.getLockdownState(GUILD), null, 'no lockdown was created');
    assert.deepEqual(store.log.filter((e) => e[0] === 'event').map((e) => e[2].kind), ['lockdown_start', 'verification', 'panic']);
    assert.equal(store.log.find((e) => e[0] === 'event' && e[2].kind === 'verification')[2].detail, 'Not changed: already High or higher');
    assert.ok(store.log.some((e) => e[0] === 'close' && e[1] === '40'));
});

test('panic detail: plain text for each outcome', () => {
    assert.equal(raid.panicDetail(null), 'Not paused: panic mode is off');
    assert.equal(raid.panicDetail({ applied: true, until: '2026-11-03T16:05:00.000Z' }), 'Paused until 16:05 UTC');
    assert.equal(raid.panicDetail({ applied: false, reason: 'missing Manage Server' }), 'Not paused: the bot needs the Manage Server permission');
});

// ── automod: what it did to a raid joiner goes on the timeline ────────────

test('automod: only what leaves no case is noted (a case is merged from mod_cases); never message content', async () => {
    const calls = [];
    const rec = (name, value) => async (...args) => { calls.push({ name, args }); return typeof value === 'function' ? value(...args) : value; };
    let raidJoiner = true;
    let stepResult = { record: { case_code: 'abc2345' } };
    setAutomodDepsForTest({
        countOffences: rec('countOffences', 0),
        applyStep: rec('applyStep', () => stepResult),
        postReviewCard: rec('postReviewCard', null),
        noteRepeatHit: rec('noteRepeatHit', null),
        deleteQuietly: rec('deleteQuietly', null),
        isRaidJoiner: rec('isRaidJoiner', () => raidJoiner),
        giveSecondChance: rec('giveSecondChance', false),
        giveHeadsUp: rec('giveHeadsUp', false),
        noteIncidentEvent: rec('noteIncidentEvent', 'stored'),
    });
    const message = {
        id: 'm1', content: 'buy now', guildId: GUILD, channelId: 'c1', url: 'https://discord.com/channels/1/2/3',
        guild: { id: GUILD, client: {} }, author: { id: id(7), username: 'raider' },
        mentions: { users: new Map(), roles: new Map() }, attachments: new Map(), client: { user: { id: 'bot' } },
    };
    const member = { joinedTimestamp: Date.now(), permissions: { has: () => false } };
    const noted = () => calls.filter((c) => c.name === 'noteIncidentEvent');
    // A raid joiner kicked: that is a case, so no automod event (no double count).
    await actOn(message, member, { rule: 'spam', mode: 'on' }, normalizeSettings({}));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(noted().length, 0);

    // The kick failed: no case, so it is noted.
    stepResult = { error: new Error('Missing Permissions') };
    resetAutomodState();
    await actOn({ ...message, id: 'm1b' }, member, { rule: 'spam', mode: 'on' }, normalizeSettings({}));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(noted().length, 1);
    const [event] = noted();
    assert.equal(event.args[0], GUILD);
    assert.equal(event.args[1].kind, 'automod');
    assert.equal(event.args[1].targetId, id(7));
    assert.match(event.args[1].detail, /: message deleted, kick of a raid joiner failed$/);
    assert.ok(!event.args[1].detail.includes('buy now'), 'no message content');

    // An ordinary member: a step that worked is a case (nothing noted), a failed one is noted.
    raidJoiner = false;
    stepResult = { record: { case_code: 'abc2346' } };
    calls.length = 0;
    resetAutomodState();
    await actOn({ ...message, id: 'm2' }, member, { rule: 'spam', mode: 'on' }, normalizeSettings({}));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(noted().length, 0);
    stepResult = { error: new Error('Missing Permissions') };
    resetAutomodState();
    await actOn({ ...message, id: 'm2b' }, member, { rule: 'spam', mode: 'on' }, normalizeSettings({}));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(noted().length, 1);
    assert.match(noted()[0].args[1].detail, / failed$/);
    assert.doesNotMatch(noted()[0].args[1].detail, /raid joiner/);

    // A failing recorder never breaks automod.
    setAutomodDepsForTest({
        countOffences: rec('countOffences', 0), applyStep: rec('applyStep', { error: new Error('x') }), postReviewCard: rec('postReviewCard', null),
        deleteQuietly: rec('deleteQuietly', null), isRaidJoiner: rec('isRaidJoiner', true), giveHeadsUp: rec('giveHeadsUp', false),
        noteIncidentEvent: () => { throw new Error('boom'); },
    });
    resetAutomodState();
    assert.equal(await actOn({ ...message, id: 'm3' }, member, { rule: 'spam', mode: 'on' }, normalizeSettings({})), true);
});
