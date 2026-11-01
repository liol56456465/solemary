// dataExport.js: "Download my data" on My record (GDPR Art. 15 access, Art. 20 portability).
//
// One JSON file with what Mewvo stores about the logged-in member, across every server.
// The user id always comes from the member session, never from the request.
//
// Columns are picked per table so the file never contains another person's data: no
// moderator ids, no reporter ids, no other party of a no-contact order, nobody who redeemed
// a gift key. Staff notes, evidence, case edit history and revoke reasons are left out (as
// on My record), and so is the IP hash itself (only when it was seen). The file says so,
// and how to ask for more.

import { pgConfig } from '../../config/database/postgres.js';

export const EXPORT_FORMAT = 'mewvo-data-export-v1';
const ID = /^\d{17,20}$/;

/** Each section: [name, sql builder (tables) → text, uses $1 = user id]. */
export const EXPORT_SECTIONS = [
    ['levels', (t) => `SELECT guild_id, xp, level, total_xp, last_message FROM ${t.user_levels} WHERE user_id = $1 ORDER BY guild_id`],
    ['economy', (t) => `SELECT guild_id, balance, bank FROM ${t.economy} WHERE user_id = $1 ORDER BY guild_id`],
    ['afk', (t) => `SELECT guild_id, reason, status_at, expires_at FROM ${t.afk_status} WHERE user_id = $1 ORDER BY guild_id`],
    ['birthdays', (t) => `SELECT guild_id, month, day FROM ${t.birthdays} WHERE user_id = $1 ORDER BY guild_id`],
    ['moderationCases', (t) => `SELECT guild_id, case_code, type, reason, moderator_username, created_at, duration_ms, expires_at, status,
        unappealable, appeal_deadline, ladder_level_after, counts_toward_level, is_auto, is_imported, dm_delivered
        FROM ${t.mod_cases} WHERE target_user_id = $1 AND is_test IS NOT TRUE ORDER BY created_at`],
    ['warningLadder', (t) => `SELECT guild_id, level, warns_since_level, updated_at FROM ${t.mod_ladder} WHERE user_id = $1 ORDER BY guild_id`],
    ['appealsAndReports', (t) => `SELECT kind, guild_id, case_code, body, status, created_at, decided_at FROM ${t.mod_appeals} WHERE user_id = $1 ORDER BY created_at`],
    ['temporaryRoles', (t) => `SELECT guild_id, role_id, reason, created_at, expires_at FROM ${t.member_temp_roles} WHERE user_id = $1 ORDER BY created_at`],
    ['modmail', (t) => `SELECT guild_id, channel_id, created_at FROM ${t.modmail_links} WHERE user_id = $1 ORDER BY created_at`],
    ['suggestions', (t) => `SELECT guild_id, id, content, status, status_reason, upvotes, downvotes, created_at FROM ${t.suggestions} WHERE user_id = $1 ORDER BY created_at`],
    ['suggestionVotes', (t) => `SELECT suggestion_id, vote, voted_at FROM ${t.suggestion_votes} WHERE user_id = $1 ORDER BY voted_at`],
    ['verification', (t) => `SELECT guild_id, action, source, created_at FROM ${t.verification_audit} WHERE user_id = $1 ORDER BY created_at`],
    ['verificationIpHashSeen', (t) => `SELECT seen_at FROM ${t.verification_ips} WHERE user_id = $1 ORDER BY seen_at`],
    ['joinsAndLeaves', (t) => `SELECT guild_id, kind, created_at FROM ${t.member_events} WHERE user_id = $1 ORDER BY created_at`],
    ['noContactOrders', (t) => `SELECT guild_id, until, created_at, ended_at FROM ${t.no_contact_orders} WHERE user_a = $1 OR user_b = $1 ORDER BY created_at`],
    ['staffWarnings', (t) => `SELECT guild_id, reason, given_by_username, created_at, expires_at FROM ${t.staff_warnings} WHERE user_id = $1 ORDER BY created_at`],
    ['staffActivity', (t) => `SELECT guild_id, week_start, messages, reviews, tickets FROM ${t.staff_activity} WHERE user_id = $1 ORDER BY week_start`],
    ['dashboardChanges', (t) => `SELECT guild_id, module, key, old, new, created_at FROM ${t.dashboard_audit} WHERE user_id = $1 ORDER BY created_at`],
    ['plan', (t) => `SELECT plan_id, started_at, expires_at, source FROM ${t.premium_subscriptions} WHERE user_id = $1`],
    ['planOrders', (t) => `SELECT id, plan_id, period, kind, amount_cents, currency, test, created_at FROM ${t.premium_orders} WHERE user_id = $1 ORDER BY created_at`],
    ['giftKeysBought', (t) => `SELECT code, plan_id, duration_days, gift_to, gift_message, created_at, expires_at, (redeemed_at IS NOT NULL) AS redeemed, (revoked_at IS NOT NULL) AS revoked
        FROM ${t.premium_keys} WHERE created_by = $1 AND source = 'gift' ORDER BY created_at`],
    ['keysRedeemed', (t) => `SELECT code, plan_id, duration_days, gift_to, gift_message, redeemed_at FROM ${t.premium_keys} WHERE redeemed_by = $1 ORDER BY redeemed_at`],
    ['reminders', (t) => `SELECT text, due_at, created_at, sent_at, guild_id FROM ${t.reminders} WHERE user_id = $1 ORDER BY created_at`],
    // Mewvo account on the website: never the password hash, the 2FA secret or the recovery codes.
    // The email columns only hold something for accounts made before schema v8 (cleanAccountExport).
    ['mewvoAccount', (t) => `SELECT username, email, pending_email, email_confirmed_at, age_confirmed_at, terms_accepted_at, discord_user_id, discord_username,
        discord_linked_at, (totp_enabled_at IS NOT NULL) AS two_step_login_on, totp_enabled_at, password_changed_at, last_login_at, created_at
        FROM ${t.member_accounts} WHERE discord_user_id = $1`],
    ['earlyAccountBonus', (t) => `SELECT link_number, pro_granted_at, pro_skip_reason, letter_eligible, letter_claimed, letter_claimed_at, letter_declined_at, created_at
        FROM ${t.member_account_bonuses} WHERE discord_user_id = $1`],
    ['blocks', (t) => `SELECT reason, created_at, removed_at FROM ${t.bot_blacklist} WHERE kind = 'user' AND target_id = $1 ORDER BY created_at`],
];

export const EXPORT_NOTE = 'Everything Mewvo stores about your Discord account, in every server that uses it. '
    + 'Left out to protect other people or the staff process: staff notes, evidence, case edit history, '
    + 'who reported or redeemed something, and the IP hash itself (only when it was recorded). '
    + 'Moderation channel transcripts live on Discord. To ask for any of this, or to have data corrected or deleted, see /privacy on the website.';

/** The note of the file for a Mewvo account that has no Discord account linked. */
export const ACCOUNT_EXPORT_NOTE = 'Your Mewvo account on the website. No Discord account is linked, so there is no Discord data to show. '
    + 'Left out for your safety: the password hash, the two-step login secret and the recovery codes. To ask for more, or to have data corrected or deleted, see /privacy on the website.';

/** Email columns of a Mewvo account: only in the file when set (accounts made before v8 had an email; newer ones have none). */
const ACCOUNT_EMAIL_FIELDS = ['email', 'pending_email', 'email_confirmed_at'];
export function cleanAccountExport(row) {
    if (!row) return null;
    const out = { ...row };
    for (const field of ACCOUNT_EMAIL_FIELDS) if (out[field] === null || out[field] === undefined) delete out[field];
    return out;
}

/**
 * Builds the export. `query(text, params)` returns { rows }; `readKey(key)` reads the
 * key-value store (the to-do list). Any error is thrown: a half export is never served.
 */
export async function buildDataExport(userId, { query, readKey, tables = pgConfig.tables, now = () => new Date() } = {}) {
    if (!ID.test(String(userId))) throw new Error('buildDataExport: bad user id');
    const sections = {};
    for (const [name, sql] of EXPORT_SECTIONS) {
        const result = await query(sql(tables), [String(userId)]);
        sections[name] = name === 'mewvoAccount' ? (result?.rows || []).map(cleanAccountExport) : result?.rows || [];
    }
    const todo = readKey ? await readKey(`todo_${userId}`) : null;
    sections.todoList = todo && typeof todo === 'object' ? todo : null;
    return {
        format: EXPORT_FORMAT,
        generatedAt: now().toISOString(),
        userId: String(userId),
        note: EXPORT_NOTE,
        ...sections,
    };
}

/** File name for the download: mewvo-data-<id>-<yyyy-mm-dd>.json */
export function exportFileName(userId, date = new Date()) {
    return `mewvo-data-${String(userId).replace(/\D/g, '')}-${date.toISOString().slice(0, 10)}.json`;
}
