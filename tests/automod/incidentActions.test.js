import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import {
    clampPanicHours, describePanic, panicUntil, pauseInvitesAndDms, resumeInvitesAndDms,
} from '../../src/services/automod/incidentActions.js';
import { normalizeSettings } from '../../src/services/automod/automodSettings.js';

const HOUR = 60 * 60 * 1000;

function fakeGuild({ manageGuild = true, fail = null } = {}) {
    const calls = [];
    return {
        id: 'g1',
        calls,
        members: { me: { permissions: { has: (flag) => flag === PermissionFlagsBits.ManageGuild && manageGuild } } },
        async setIncidentActions(body) {
            calls.push(body);
            if (fail) throw new Error(fail);
            return {};
        },
    };
}

test('panic: hours are clamped to 1–24, default 2', () => {
    assert.equal(clampPanicHours(undefined), 2);
    assert.equal(clampPanicHours(0), 2);
    assert.equal(clampPanicHours('abc'), 2);
    assert.equal(clampPanicHours(5), 5);
    assert.equal(clampPanicHours(48), 24);
    const now = Date.UTC(2026, 0, 1);
    assert.equal(panicUntil(100, now), new Date(now + 24 * HOUR).toISOString());
    assert.equal(panicUntil(2, now), new Date(now + 2 * HOUR).toISOString());
});

test('panic: settings default to on for 2 hours and are normalized', () => {
    assert.deepEqual(normalizeSettings({}).panic, { enabled: true, hours: 2 });
    assert.deepEqual(normalizeSettings({ panic: { enabled: false, hours: 99 } }).panic, { enabled: false, hours: 24 });
    assert.deepEqual(normalizeSettings({ panic: 'junk' }).panic, { enabled: true, hours: 2 });
});

test('panic: pauses invites and DMs with the same end time', async () => {
    const guild = fakeGuild();
    const result = await pauseInvitesAndDms(guild, 3);
    assert.equal(result.applied, true);
    assert.equal(guild.calls.length, 1);
    assert.equal(guild.calls[0].invitesDisabledUntil, result.until);
    assert.equal(guild.calls[0].dmsDisabledUntil, result.until);
    const ahead = new Date(result.until).getTime() - Date.now();
    assert.ok(ahead > 2.9 * HOUR && ahead <= 3 * HOUR);
    assert.match(describePanic(result), /paused until <t:\d+:t>/);
});

test('panic: without Manage Server nothing is called and the alert says so', async () => {
    const guild = fakeGuild({ manageGuild: false });
    const result = await pauseInvitesAndDms(guild, 2);
    assert.deepEqual(result, { applied: false, reason: 'missing Manage Server' });
    assert.equal(guild.calls.length, 0);
    assert.match(describePanic(result), /Manage Server/);
    assert.match(describePanic(null), /panic mode is off/);
});

test('panic: a refused request degrades; resume clears both', async () => {
    const failing = fakeGuild({ fail: 'Missing Access' });
    const result = await pauseInvitesAndDms(failing, 2);
    assert.equal(result.applied, false);
    assert.match(describePanic(result), /Missing Access/);

    const guild = fakeGuild();
    assert.equal(await resumeInvitesAndDms(guild), true);
    assert.deepEqual(guild.calls[0], { invitesDisabledUntil: null, dmsDisabledUntil: null });
    assert.equal(await resumeInvitesAndDms(fakeGuild({ fail: 'x' })), false);
});
