// wipedataService.js: what /wipedata deletes, in one place (the Privacy Policy points here).
//
// A member's own data in one server: levels and XP, voice time (voice_activity), economy balance, AFK status, birthday,
// plus their personal to-do list and reminders (not per server), and the encrypted Discord
// login token stored by "Verify with Discord" (oauth:tokens:<userId>; without it the bot can
// no longer add them to the support server) with the list of servers it was given in
// (oauth_verified_guilds), and the log of the bot's DMs to them that a language change can
// re-edit (bot_dm_log, every server), the personal language they picked for Mewvo's DMs
// (user:<id>:lang, every server; services/personalLanguage.js), and the ticket ratings they gave lose their name and
// comment (ticket_ratings, every server; the stars stay). Invite tracking in this server (owner
// decision 4): the member's own join rows and their bonus/reset row are deleted, and they are
// blanked as the inviter in other members' join rows and in the invite code list. Moderation, appeal, report and verification
// records are safety records and are not touched.
//
// Each item is deleted on its own; the result says which ones failed, so the reply never
// claims success after a failed delete (data layer rule).

import { getAFKKey, getEconomyKey, getUserLevelKey } from '../utils/database/keys.js';
import { deleteBirthday } from '../utils/database.js';
import { query } from './enforcement/db.js';
import { pgConfig } from '../config/database/postgres.js';
import { deleteDmLogForUser } from './botDm/dmLog.js';
import { clearRatingsGivenBy } from './ticketRatingService.js';
import { hideChannelSurveysOf } from './ticketRatingEffects.js';
import { forgetPersonalLanguage, personalLanguageKey } from './personalLanguage.js';

// Voice XP: the member's voice time in this server goes with their levels.
async function deleteVoiceTime(guildId, userId) {
    await query(`DELETE FROM ${pgConfig.tables.voice_activity} WHERE guild_id = $1 AND user_id = $2`, [guildId, userId]);
}
import { wipeInviteData } from './invites/inviteStore.js';

/** The member's own unsent and sent reminders (everywhere: reminders are personal). */
async function deleteReminders(userId) {
    await query(`DELETE FROM ${pgConfig.tables.reminders} WHERE user_id = $1`, [userId]);
}

/** Which servers the member verified in with "Verify with Discord" (goes with the token). */
async function deleteVerifiedGuilds(userId) {
    await query(`DELETE FROM ${pgConfig.tables.oauth_verified_guilds} WHERE user_id = $1`, [userId]);
}

/**
 * The data /wipedata removes, in the order shown to the member. `legacy`: left over from
 * features Mewvo no longer has (economy, AFK); still deleted when present, but not listed.
 */
export const WIPE_ITEMS = [
    { id: 'levels', label: 'Levels, XP and voice time' },
    { id: 'economy', label: 'Economy balance', legacy: true },
    { id: 'afk', label: 'AFK status', legacy: true },
    { id: 'birthday', label: 'Birthday' },
    { id: 'todo', label: 'Personal to-do list' },
    { id: 'reminders', label: 'Reminders' },
    { id: 'oauth', label: 'Stored Discord login token (from Verify with Discord)' },
    { id: 'dmlog', label: 'Saved copies of bot DMs (to re-translate them when you change language)' },
    // Every server: one value per Discord account (/language without a role, the website).
    { id: 'language', label: 'Your personal language for Mewvo (from /language)' },
    // Every server: the stars stay (staff stats), without who gave them and without the comment.
    { id: 'ticketRatings', label: 'Ticket ratings you gave (your name and comment; the stars stay)' },
    { id: 'invites', label: 'Invite tracking: how you joined, and your name as the inviter of others' },
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
    removeDmLog = deleteDmLogForUser, removeVoiceTime = deleteVoiceTime, removeTicketRatings = clearRatingsGivenBy, removeInvites = wipeInviteData,
    hideSurveys = hideChannelSurveysOf,
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
        levels: async () => {
            await deleteKey(getUserLevelKey(guildId, userId));
            await removeVoiceTime(guildId, userId);
        },
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
        dmlog: () => removeDmLog(userId),
        // The stored key first; the in-memory copy only once that worked (a failed delete keeps both).
        language: async () => {
            await deleteKey(personalLanguageKey(userId));
            forgetPersonalLanguage(userId);
        },
        // Hide open channel surveys first: once opener_id is blank, the access sweep can't find them.
        ticketRatings: async () => { await hideSurveys(client, userId); return removeTicketRatings(userId); },
        invites: () => removeInvites(guildId, userId),
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
