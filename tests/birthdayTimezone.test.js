import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { isBirthdayOn, readBirthdayTracking, checkBirthdays } from '../src/services/birthdayService.js';
import { canonicalTimeZone, localDateKey, searchTimeZones } from '../src/utils/timezone.js';
import { validateGuildConfigOrThrow } from '../src/utils/schemas.js';

test('time zones are validated and canonicalized with Intl', () => {
    assert.equal(canonicalTimeZone('europe/vilnius'), 'Europe/Vilnius');
    assert.equal(canonicalTimeZone('UTC'), 'UTC');
    assert.equal(canonicalTimeZone('Mars/Olympus_Mons'), null);
    assert.equal(canonicalTimeZone(''), null);
    assert.equal(searchTimeZones('')[0], 'UTC');
    assert.ok(searchTimeZones('new york').includes('America/New_York'));
    assert.throws(() => validateGuildConfigOrThrow({ birthdayTimezone: 'Nowhere/Land' }));
    validateGuildConfigOrThrow({ birthdayTimezone: 'Asia/Tokyo' });
});

test('birthdays use the guild\'s local date, keeping the Feb 29 rule', () => {
    const lateUtc = new Date('2026-10-27T23:30:00Z'); // already Oct 28 in Tokyo
    assert.equal(isBirthdayOn({ month: 10, day: 27 }, lateUtc), true);
    assert.equal(isBirthdayOn({ month: 10, day: 28 }, lateUtc, 'Asia/Tokyo'), true);
    assert.equal(isBirthdayOn({ month: 10, day: 27 }, lateUtc, 'Asia/Tokyo'), false);
    const earlyUtc = new Date('2026-10-28T03:00:00Z'); // still Oct 27 in New York
    assert.equal(isBirthdayOn({ month: 10, day: 27 }, earlyUtc, 'America/New_York'), true);
    // 2027-02-28 local in Los Angeles is 2027-03-01 in UTC.
    assert.equal(isBirthdayOn({ month: 2, day: 29 }, new Date('2027-03-01T05:00:00Z'), 'America/Los_Angeles'), true);
    assert.equal(localDateKey(lateUtc, 'Asia/Tokyo'), '2026-10-28');
});

test('tracking data: legacy { userId: true } maps are read as role holders', () => {
    assert.deepEqual(readBirthdayTracking({ '1': true, '2': false }), { announcedDate: null, roles: { '1': true } });
    assert.deepEqual(readBirthdayTracking(null), { announcedDate: null, roles: {} });
    assert.deepEqual(readBirthdayTracking({ announcedDate: '2026-10-27', roles: { '3': true } }), { announcedDate: '2026-10-27', roles: { '3': true } });
});

function fakeDb(initial) {
    const store = new Map(Object.entries(initial));
    const clone = (v) => (v === undefined ? null : structuredClone(v));
    return {
        store,
        rows: () => null,
        get: async (key, fallback = null) => (store.has(key) ? clone(store.get(key)) : fallback),
        set: async (key, value) => { store.set(key, clone(value)); return true; },
        update: async (key, mutator, fallback = null) => {
            const next = await mutator(store.has(key) ? clone(store.get(key)) : clone(fallback));
            store.set(key, clone(next));
            return next;
        },
    };
}

test('running the birthday check repeatedly announces once per local date', async () => {
    const guildId = '100';
    const sent = [];
    const roleOps = [];
    const member = {
        toString: () => '<@200>',
        user: { tag: 'bday#0001' },
        roles: {
            cache: new Map(),
            add: async (roleId) => roleOps.push(['add', roleId]),
            remove: async (roleId) => roleOps.push(['remove', roleId]),
        },
    };
    const guild = {
        name: 'Test',
        channels: { fetch: async () => ({ send: async (payload) => sent.push(payload) }) },
        members: { fetch: async () => member },
    };
    const db = fakeDb({
        [`guild:${guildId}:config`]: { birthdayChannelId: '300', birthdayRoleId: '400', birthdayTimezone: 'Asia/Tokyo' },
        [`guild:${guildId}:birthdays`]: { '200': { month: 10, day: 28 } },
        [`guild:${guildId}:birthdays:tracking`]: { '999': true }, // legacy format from yesterday
    });
    const client = { db, guilds: { cache: new Map([[guildId, guild]]) } };

    mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-27T16:00:00Z') }); // Oct 28 01:00 in Tokyo
    try {
        await checkBirthdays(client);
        await checkBirthdays(client);
        assert.equal(sent.length, 1, 'announced once');
        assert.deepEqual(db.store.get(`guild:${guildId}:birthdays:tracking`), { announcedDate: '2026-10-28', roles: { '200': true } });
        assert.deepEqual(roleOps, [['add', '400']]);

        // Next local day: the role comes off; no birthday, no announcement.
        mock.timers.setTime(new Date('2026-10-28T16:00:00Z').getTime());
        member.roles.cache.set('400', true);
        await checkBirthdays(client);
        assert.equal(sent.length, 1);
        assert.deepEqual(roleOps.at(-1), ['remove', '400']);
        assert.deepEqual(db.store.get(`guild:${guildId}:birthdays:tracking`), { announcedDate: '2026-10-29', roles: {} });
    } finally {
        mock.timers.reset();
    }
});
