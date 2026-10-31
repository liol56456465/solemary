// wipedataService.js: what /wipedata deletes, in one place (the Privacy Policy points here).
//
// A member's own data in one server: levels and XP, economy balance, AFK status, birthday,
// plus their personal to-do list (it is not per server). Moderation, appeal, report and
// verification records are safety records and are not touched.
//
// Each item is deleted on its own; the result says which ones failed, so the reply never
// claims success after a failed delete (data layer rule).

import { getAFKKey, getEconomyKey, getUserLevelKey } from '../utils/database/keys.js';
import { deleteBirthday } from '../utils/database.js';

/** The data /wipedata removes, in the order shown to the member. */
export const WIPE_ITEMS = [
    { id: 'levels', label: 'Levels and XP' },
    { id: 'economy', label: 'Economy balance' },
    { id: 'afk', label: 'AFK status' },
    { id: 'birthday', label: 'Birthday' },
    { id: 'todo', label: 'Personal to-do list' },
];

const ID = /^\d{17,20}$/;

/**
 * Deletes the caller's own data. Returns { deleted: [ids], failed: [ids] }.
 * `removeBirthday` is injectable for tests.
 */
export async function wipeMemberData(client, guildId, userId, { removeBirthday = deleteBirthday } = {}) {
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
