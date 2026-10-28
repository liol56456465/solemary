// Atomic settings services (tickets, verification, welcome, leveling) with a fake
// client.db whose update() serializes per key like the Postgres row lock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TitanBotError, ErrorTypes } from '../src/utils/errorHandler.js';
import {
    TICKET_SETTING_KEYS, getTicketSettings, updateTicketSettings, clearTicketSettings,
} from '../src/services/ticketSettingsService.js';
import {
    getVerificationSettings, updateVerificationSettings, setVerificationSettings,
} from '../src/services/verificationSettingsService.js';
import {
    getWelcomeSettings, updateWelcomeSettings, addAutoRole, removeAutoRole,
} from '../src/services/welcomeService.js';
import {
    getLevelingConfig, updateLevelingConfig, setLevelRoleReward, saveLevelingConfig,
} from '../src/services/leveling/leveling.js';

const GUILD = '300000000000000001';
const CHANNEL = '300000000000000002';
const ROLE_A = '300000000000000003';
const ROLE_B = '300000000000000004';

const tick = () => new Promise((resolve) => setTimeout(resolve, 2));

function fakeClient() {
    const store = new Map();
    const chains = new Map();
    const db = {
        store,
        async get(key, defaultValue = null) {
            await tick();
            return store.has(key) ? structuredClone(store.get(key)) : defaultValue;
        },
        async set(key, value) {
            await tick();
            store.set(key, structuredClone(value));
            return true;
        },
        // Serialized per key; the read and write are separated by awaits so an
        // unlocked read-modify-write would interleave.
        update(key, mutator, defaultValue = null) {
            const run = async () => {
                await tick();
                const current = store.has(key) ? structuredClone(store.get(key)) : structuredClone(defaultValue);
                await tick();
                const next = await mutator(current);
                await tick();
                store.set(key, structuredClone(next));
                return next;
            };
            const result = (chains.get(key) || Promise.resolve()).then(run, run);
            chains.set(key, result.catch(() => {}));
            return result;
        },
    };
    return { db };
}

async function assertValidation(promise, fieldWord) {
    await assert.rejects(promise, (error) => {
        assert.ok(error instanceof TitanBotError, `expected TitanBotError, got ${error}`);
        assert.equal(error.type, ErrorTypes.VALIDATION);
        assert.equal(typeof error.userMessage, 'string');
        if (fieldWord) assert.match(error.userMessage, fieldWord);
        return true;
    });
}

// --- tickets -----------------------------------------------------------------

test('tickets: validation errors name the field', async () => {
    const client = fakeClient();
    await assertValidation(updateTicketSettings(client, GUILD, { ticketButtonLabel: 'x'.repeat(81) }), /Button label/);
    await assertValidation(updateTicketSettings(client, GUILD, { ticketButtonLabel: '   ' }), /Button label/);
    await assertValidation(updateTicketSettings(client, GUILD, { ticketPanelMessage: 'x'.repeat(2001) }), /Panel message/);
    await assertValidation(updateTicketSettings(client, GUILD, { maxTicketsPerUser: 11 }), /Max tickets/);
    await assertValidation(updateTicketSettings(client, GUILD, { maxTicketsPerUser: 2.5 }), /Max tickets/);
    await assertValidation(updateTicketSettings(client, GUILD, { dmOnClose: 'yes' }), /DM on close/);
    await assertValidation(updateTicketSettings(client, GUILD, { ticketStaffRoleId: '123' }), /staff role/);
    await assertValidation(updateTicketSettings(client, GUILD, { prefix: '!' }), /Unknown setting/);
    await assertValidation(updateTicketSettings(client, GUILD, null));
    await assertValidation(clearTicketSettings(client, GUILD, ['prefix']), /Unknown/);
    assert.equal(client.db.store.size, 0, 'nothing written');
});

test('tickets: update merges only patched keys and returns before/after', async () => {
    const client = fakeClient();
    const first = await updateTicketSettings(client, GUILD, { ticketPanelChannelId: CHANNEL, ticketButtonLabel: '  Open  ' });
    assert.equal(first.before.ticketPanelChannelId, undefined);
    assert.equal(first.after.ticketPanelChannelId, CHANNEL);
    assert.equal(first.after.ticketButtonLabel, 'Open', 'trimmed');
    assert.deepEqual(Object.keys(first.after).sort(), [...TICKET_SETTING_KEYS].sort());

    const second = await updateTicketSettings(client, GUILD, { ticketStaffRoleId: null, maxTicketsPerUser: 4 });
    assert.equal(second.before.ticketButtonLabel, 'Open');
    assert.equal(second.after.ticketPanelChannelId, CHANNEL, 'untouched key kept');
    assert.equal(second.after.maxTicketsPerUser, 4);

    const read = await getTicketSettings(client, GUILD);
    assert.equal(read.ticketButtonLabel, 'Open');
    assert.equal(read.maxTicketsPerUser, 4);
});

test('tickets: concurrent updates of different fields both survive', async () => {
    const client = fakeClient();
    await updateTicketSettings(client, GUILD, { ticketPanelChannelId: CHANNEL });
    await Promise.all([
        updateTicketSettings(client, GUILD, { ticketButtonLabel: 'Help' }),
        updateTicketSettings(client, GUILD, { maxTicketsPerUser: 7 }),
        updateTicketSettings(client, GUILD, { dmOnClose: false }),
    ]);
    const read = await getTicketSettings(client, GUILD);
    assert.equal(read.ticketButtonLabel, 'Help');
    assert.equal(read.maxTicketsPerUser, 7);
    assert.equal(read.dmOnClose, false);
    assert.equal(read.ticketPanelChannelId, CHANNEL);
});

test('tickets: clear removes the keys atomically', async () => {
    const client = fakeClient();
    await updateTicketSettings(client, GUILD, { ticketPanelChannelId: CHANNEL, ticketButtonLabel: 'Help' });
    const { before, after } = await clearTicketSettings(client, GUILD, ['ticketPanelChannelId', 'ticketButtonLabel']);
    assert.equal(before.ticketPanelChannelId, CHANNEL);
    assert.equal(after.ticketPanelChannelId, undefined);
    assert.equal(after.ticketButtonLabel, undefined);
});

// --- verification -----------------------------------------------------------

test('verification: validation errors name the field', async () => {
    const client = fakeClient();
    await assertValidation(updateVerificationSettings(client, GUILD, { enabled: 'on' }), /Verification enabled/);
    await assertValidation(updateVerificationSettings(client, GUILD, { roleId: 'abc' }), /Verified role/);
    await assertValidation(updateVerificationSettings(client, GUILD, { buttonText: 'x'.repeat(81) }), /Button text/);
    await assertValidation(updateVerificationSettings(client, GUILD, { message: '' }), /Verification message/);
    await assertValidation(updateVerificationSettings(client, GUILD, { autoVerify: { criteria: 'vibes' } }), /criteria/);
    await assertValidation(updateVerificationSettings(client, GUILD, { autoVerify: { accountAgeDays: 400 } }), /Account age/);
    await assertValidation(updateVerificationSettings(client, GUILD, { autoVerify: { criteria: 'account_age', accountAgeDays: null } }), /Account age/);
    await assertValidation(updateVerificationSettings(client, GUILD, { bogus: 1 }), /Unknown setting/);
    await assertValidation(setVerificationSettings(client, GUILD, { channelId: 'nope' }), /Verification channel/);
});

test('verification: nested autoVerify patch merges and concurrent writes survive', async () => {
    const client = fakeClient();
    await setVerificationSettings(client, GUILD, {
        enabled: false, channelId: CHANNEL, roleId: ROLE_A, message: 'Hi', buttonText: 'Verify',
        autoVerify: { enabled: false, criteria: 'account_age', accountAgeDays: 7, roleId: ROLE_A },
    });

    await Promise.all([
        updateVerificationSettings(client, GUILD, { messageId: CHANNEL }),
        updateVerificationSettings(client, GUILD, { buttonText: 'Go' }),
        updateVerificationSettings(client, GUILD, { autoVerify: { enabled: true } }),
        updateVerificationSettings(client, GUILD, { autoVerify: { roleId: ROLE_B } }),
    ]);

    const v = await getVerificationSettings(client, GUILD);
    assert.equal(v.messageId, CHANNEL);
    assert.equal(v.buttonText, 'Go');
    assert.equal(v.message, 'Hi');
    assert.equal(v.autoVerify.enabled, true);
    assert.equal(v.autoVerify.roleId, ROLE_B);
    assert.equal(v.autoVerify.criteria, 'account_age');
    assert.equal(v.autoVerify.accountAgeDays, 7);

    const { before, after } = await updateVerificationSettings(client, GUILD, { enabled: true });
    assert.equal(before.enabled, false);
    assert.equal(after.enabled, true);
});

// --- welcome ----------------------------------------------------------------

test('welcome: validation errors name the field', async () => {
    const client = fakeClient();
    await assertValidation(updateWelcomeSettings(client, GUILD, { welcomeMessage: 'x'.repeat(2001) }), /Welcome message/);
    await assertValidation(updateWelcomeSettings(client, GUILD, { channelId: '1' }), /Welcome channel/);
    await assertValidation(updateWelcomeSettings(client, GUILD, { roleIds: ['x'] }), /Auto-role/);
    await assertValidation(updateWelcomeSettings(client, GUILD, { autoRoleDelay: -1 }), /Auto-role delay/);
    await assertValidation(updateWelcomeSettings(client, GUILD, { joinLogs: { enabled: 'y' } }), /Join logs/);
    await assertValidation(updateWelcomeSettings(client, GUILD, { nope: true }), /Unknown setting/);
    await assertValidation(addAutoRole(client, GUILD, 'not-a-role'), /Auto-role/);
});

test('welcome: concurrent updates survive; auto-role add/remove are atomic', async () => {
    const client = fakeClient();
    await Promise.all([
        updateWelcomeSettings(client, GUILD, { enabled: true, channelId: CHANNEL }),
        updateWelcomeSettings(client, GUILD, { goodbyeEnabled: true }),
        updateWelcomeSettings(client, GUILD, { joinLogs: { channelId: CHANNEL } }),
        addAutoRole(client, GUILD, ROLE_A),
    ]);
    const cfg = await getWelcomeSettings(client, GUILD);
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.channelId, CHANNEL);
    assert.equal(cfg.goodbyeEnabled, true);
    assert.equal(cfg.joinLogs.channelId, CHANNEL);
    assert.equal(cfg.joinLogs.enabled, false, 'nested logs object merged');
    assert.deepEqual(cfg.roleIds, [ROLE_A]);

    const again = await addAutoRole(client, GUILD, ROLE_A);
    assert.equal(again.changed, false);

    // One auto-role allowed (as /autorole add): adding another replaces it.
    const replaced = await addAutoRole(client, GUILD, ROLE_B);
    assert.equal(replaced.changed, true);
    assert.deepEqual(replaced.before.roleIds, [ROLE_A]);
    assert.deepEqual(replaced.after.roleIds, [ROLE_B]);

    const missing = await removeAutoRole(client, GUILD, ROLE_A);
    assert.equal(missing.changed, false);
    const removed = await removeAutoRole(client, GUILD, ROLE_B);
    assert.equal(removed.changed, true);
    assert.deepEqual(removed.after.roleIds, []);
    assert.equal(removed.after.goodbyeEnabled, true, 'other fields untouched');
});

// --- leveling ---------------------------------------------------------------

test('leveling: validation errors', async () => {
    const client = fakeClient();
    await assertValidation(updateLevelingConfig(client, GUILD, { xpCooldown: 4000 }), /Cooldown/);
    await assertValidation(updateLevelingConfig(client, GUILD, { xpRange: { min: 10, max: 5 } }), /Minimum XP/);
    await assertValidation(updateLevelingConfig(client, GUILD, { xpRange: { min: 0, max: 5 } }), /Minimum XP/);
    await assertValidation(setLevelRoleReward(client, GUILD, 0, ROLE_A), /Level/);
    await assertValidation(setLevelRoleReward(client, GUILD, 5, 'role'), /role/);
});

test('leveling: patch starts from defaults, concurrent writes survive, role rewards per level', async () => {
    const client = fakeClient();
    const { before, after } = await updateLevelingConfig(client, GUILD, { levelUpChannel: CHANNEL });
    assert.equal(before.enabled, true, 'defaults when nothing stored');
    assert.equal(after.levelUpChannel, CHANNEL);
    assert.equal(after.levelUpMessage, '{user} has leveled up to level {level}!');

    await Promise.all([
        updateLevelingConfig(client, GUILD, { xpCooldown: 30 }),
        updateLevelingConfig(client, GUILD, { announceLevelUp: false }),
        setLevelRoleReward(client, GUILD, 5, ROLE_A),
        setLevelRoleReward(client, GUILD, 10, ROLE_B),
    ]);
    let cfg = await getLevelingConfig(client, GUILD);
    assert.equal(cfg.xpCooldown, 30);
    assert.equal(cfg.announceLevelUp, false);
    assert.equal(cfg.levelUpChannel, CHANNEL);
    assert.deepEqual(cfg.roleRewards, { 5: ROLE_A, 10: ROLE_B });

    await setLevelRoleReward(client, GUILD, 5, null);
    cfg = await getLevelingConfig(client, GUILD);
    assert.deepEqual(cfg.roleRewards, { 10: ROLE_B });

    // saveLevelingConfig still replaces the whole leveling object.
    await saveLevelingConfig(client, GUILD, { enabled: false, xpCooldown: 5 });
    cfg = await getLevelingConfig(client, GUILD);
    assert.deepEqual(cfg, { enabled: false, xpCooldown: 5 });
});
