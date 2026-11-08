// wipedataService.js: what /wipedata deletes, in one place (the Privacy Policy points here).
//
// A member's own data in one server: levels and XP, economy balance, AFK status, birthday,
// plus their personal to-do list and reminders (not per server), and the encrypted Discord
// login token stored by "Verify with Discord" (oauth:tokens:<userId>; without it the bot can
// no longer add them to the support server) with the list of servers it was given in
// (oauth_verified_guilds). Moderation, appeal, report and verification
// records are safety records and are not touched.
//
// Each item is deleted on its own; the result says which ones failed, so the reply never
// claims success after a failed delete (data layer rule).

import { getAFKKey, getEconomyKey, getUserLevelKey } from '../utils/database/keys.js';
import { deleteBirthday } from '../utils/database.js';
import { query } from './enforcement/db.js';
import { pgConfig } from '../config/database/postgres.js';

/** The member's own unsent and sent reminders (everywhere: reminders are personal). */
async function deleteReminders(userId) {
    await query(`DELETE FROM ${pgConfig.tables.reminders} WHERE user_id = $1`, [userId]);
}

/** Which servers the member verified in with "Verify with Discord" (goes with the token). */
async function deleteVerifiedGuilds(userId) {
    await query(`DELETE FROM ${pgConfig.tables.oauth_verified_guilds} WHERE user_id = $1`, [userId]);
}

/** The data /wipedata removes, in the order shown to the member. */
export const WIPE_ITEMS = [
    { id: 'levels', label: 'Levels and XP' },
    { id: 'economy', label: 'Economy balance' },
    { id: 'afk', label: 'AFK status' },
    { id: 'birthday', label: 'Birthday' },
    { id: 'todo', label: 'Personal to-do list' },
    { id: 'reminders', label: 'Reminders' },
    { id: 'oauth', label: 'Stored Discord login token (from Verify with Discord)' },
];

/** The key-value key of the member's encrypted OAuth tokens (oauthVerification.js). */
export const oauthTokenKey = (userId) => `oauth:tokens:${userId}`;

const ID = /^\d{17,20}$/;

/**
 * Deletes the caller's own data. Returns { deleted: [ids], failed: [ids] }.
 * `removeBirthday` is injectable for tests.
 */
export async function wipeMemberData(client, guildId, userId, {
    removeBirthday = deleteBirthday, removeReminders = deleteReminders, removeVerifiedGuilds = deleteVerifiedGuilds,
} = {}) {
    if (!ID.test(String(guildId)) || !ID.test(String(userId))) throw new Error('wipeMemberData: bad ids');
    const db = client?.db;
    if (!db) throw new Error('wipeMemberData: database not available');

    const deleteKey = async (key) => {
        if (!(await db.exists(key))) return false;
        const result = await db.delete(key);
        if (result === false) throw new Error(`delete returned false for a stored key`);
        return true;
    };

    const steps = {
        levels: () => deleteKey(getUserLevelKey(guildId, userId)),
        economy: () => deleteKey(getEconomyKey(guildId, userId)),
        afk: () => deleteKey(getAFKKey(guildId, userId)),
        birthday: () => removeBirthday(client, guildId, userId),
        todo: () => deleteKey(`todo_${userId}`),
        reminders: () => removeReminders(userId),
        // The token first: without it the server list is never used; then the list itself.
        oauth: async () => {
            await deleteKey(oauthTokenKey(userId));
            await removeVerifiedGuilds(userId);
        },
    };

    const deleted = [];
    const failed = [];
    for (const { id } of WIPE_ITEMS) {
        try {
            await steps[id]();
            deleted.push(id);
        } catch (error) {
            failed.push({ id, error });
        }
    }
    return { deleted, failed };
}
