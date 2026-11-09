// dataExport.js: "Download my data" on My record (GDPR Art. 15 access, Art. 20 portability).
//
// One JSON file with what Mewvo stores about the logged-in member, across every server.
// The user id always comes from the member session, never from the request.
//
// Columns are picked per table so the file never contains another person's data: no
// moderator ids, no reporter ids, no other party of a no-contact order, nobody who redeemed
// a gift key, no other raid joiners. Staff notes and watchlist entries about the member are
// included with the author shown as "staff". Evidence excerpts are given on request only (they
// store a username, not an id). Case edit history, revoke reasons, other people's messages, re-hosted images and
// the IP hash itself (only when it was seen) are left out. The OAuth token is reported as
// stored yes/no, never the token. The file says so, and how to ask for more.
// Every new section is capped at ROW_LIMIT rows.

import { pgConfig } from '../../config/database/postgres.js';
import { personalLanguageKey } from '../personalLanguage.js';

export const EXPORT_FORMAT = 'mewvo-data-export-v1';
const ID = /^\d{17,20}$/;
const ROW_LIMIT = 5000;

/** Each section: [name, sql builder (tables) → text, uses $1 = user id]. */
export const EXPORT_SECTIONS = [
    ['levels', (t) => `SELECT guild_id, xp, level, total_xp, last_message FROM ${t.user_levels} WHERE user_id = $1 ORDER BY guild_id`],
    // Voice XP: counted voice time per server (only minutes; never who was in the channel).
    ['voiceActivity', (t) => `SELECT guild_id, voice_seconds, voice_xp, day, day_minutes, updated_at FROM ${t.voice_activity} WHERE user_id = $1 ORDER BY guild_id LIMIT ${ROW_LIMIT}`],
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
    // Since schema v12 per server (the hash itself is still left out).
    ['verificationIpHashSeenPerServer', (t) => `SELECT guild_id, seen_at FROM ${t.verification_guild_ips} WHERE user_id = $1 ORDER BY seen_at LIMIT ${ROW_LIMIT}`],
    // The servers "Verify with Discord" was used in (the token itself is never exported).
    ['oauthVerifiedServers', (t) => `SELECT guild_id, authorized_at, verified_at FROM ${t.oauth_verified_guilds} WHERE user_id = $1 ORDER BY authorized_at LIMIT ${ROW_LIMIT}`],
    ['joinsAndLeaves', (t) => `SELECT guild_id, kind, created_at FROM ${t.member_events} WHERE user_id = $1 ORDER BY created_at`],
    // The reason is about this member too; the other party and the staff member are left out.
    ['noContactOrders', (t) => `SELECT guild_id, reason, until, created_at, ended_at FROM ${t.no_contact_orders} WHERE user_a = $1 OR user_b = $1 ORDER BY created_at LIMIT ${ROW_LIMIT}`],
    // Staff watchlist entries about this member (the member is never told otherwise); who added it is "staff".
    ['watchlist', (t) => `SELECT guild_id, reason, 'staff' AS who_added, created_at, until, ended_at FROM ${t.mod_watchlist} WHERE user_id = $1 ORDER BY created_at LIMIT ${ROW_LIMIT}`],
    // Raid timeline events where this member is the target (detail is a short label, no message text); the actor is left out.
    ['raidTimelineEvents', (t) => `SELECT incident_id, at, kind, detail FROM ${t.incident_events} WHERE target_id = $1 ORDER BY at LIMIT ${ROW_LIMIT}`],
    // Raid incident reports that list this member as a joiner: only the incident and its dates, not the other joiners.
    ['raidIncidentsJoined', (t) => `SELECT id AS incident_id, guild_id, started_at, ended_at, released_at FROM ${t.automod_raid_incidents}
        WHERE joiner_ids ? $1 ORDER BY started_at LIMIT ${ROW_LIMIT}`],
    // Staff notes on this member's own cases: the text is their personal data (CJEU C-434/16 Nowak); the author is "staff".
    ['caseNotes', (t) => `SELECT n.case_code, n.text, 'staff' AS who_wrote, n.created_at FROM ${t.mod_case_notes} n
        JOIN ${t.mod_cases} c ON c.case_code = n.case_code
        WHERE c.target_user_id = $1 AND c.is_test IS NOT TRUE ORDER BY n.created_at LIMIT ${ROW_LIMIT}`],
    // Evidence excerpts are NOT exported: an excerpt stores the author's username, not their Discord
    // id, so matching on the name could hand over someone else's message (security review 2026-11-04).
    // Add an author id column to mod_case_evidence first; until then evidence is given on request.
    // Tickets this member opened (who claimed or closed it is left out).
    ['tickets', (t) => `SELECT guild_id, channel_id, data->>'status' AS status, data->>'priority' AS priority, data->>'reason' AS reason,
        data->>'createdAt' AS opened_at, data->>'closedAt' AS closed_at, data->>'closeReason' AS close_reason
        FROM ${t.tickets} WHERE data->>'userId' = $1 ORDER BY created_at LIMIT ${ROW_LIMIT}`],
    // Ticket / modmail ratings this member gave (v14): stars, comment, dates (the staff member is left out).
    ['ticketRatingsGiven', (t) => `SELECT guild_id, kind, ticket_number, rating, comment, prompted_at, rated_at, comment_at
        FROM ${t.ticket_ratings} WHERE opener_id = $1 ORDER BY prompted_at LIMIT ${ROW_LIMIT}`],
    // Staff: ratings of tickets they handled: stars, date and ticket number only (not who rated, not the comment).
    ['ticketRatingsAboutYou', (t) => `SELECT guild_id, kind, ticket_number, rating, rated_at
        FROM ${t.ticket_ratings} WHERE staff_id = $1 AND rating IS NOT NULL ORDER BY rated_at LIMIT ${ROW_LIMIT}`],
    // Giveaways this member entered, and whether they won (no other entrants).
    ['giveawayEntries', (t) => `SELECT guild_id, message_id, data->>'prize' AS prize, ends_at, created_at,
        COALESCE(data->'winnerIds' ? $1, FALSE) AS won
        FROM ${t.giveaways} WHERE data->'participants' ? $1 ORDER BY created_at LIMIT ${ROW_LIMIT}`],
    // Invite codes this member created (invitees are not stored in this table).
    ['invitesCreated', (t) => `SELECT guild_id, invite_code, uses, created_at FROM ${t.invite_tracking} WHERE inviter_id = $1 ORDER BY created_at LIMIT ${ROW_LIMIT}`],
    // Invite tracking (v14): how this member joined each server (their own join rows; the inviter is
    // named, as on the server's join log). The members THEY invited are never listed: counts only.
    ['invitedBy', (t) => `SELECT guild_id, inviter_id, invite_code, source, account_created_at, joined_at, left_at, counted
        FROM ${t.invite_joins} WHERE user_id = $1 ORDER BY joined_at LIMIT ${ROW_LIMIT}`],
    ['invitesSummary', (t) => `SELECT COALESCE(j.guild_id, i.guild_id) AS guild_id, COALESCE(j.joins, 0)::int AS members_joined_through_you,
        COALESCE(j.left_count, 0)::int AS of_them_left, COALESCE(i.bonus, 0)::int AS staff_bonus, i.reset_at
        FROM (SELECT guild_id, COUNT(*) FILTER (WHERE counted) AS joins, COUNT(*) FILTER (WHERE counted AND left_at IS NOT NULL) AS left_count
              FROM ${t.invite_joins} WHERE inviter_id = $1 GROUP BY guild_id) j
        FULL OUTER JOIN (SELECT guild_id, bonus, reset_at FROM ${t.invite_inviters} WHERE user_id = $1) i ON i.guild_id = j.guild_id
        ORDER BY 1`],
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
    + 'Staff notes and watchlist entries about you are included, with the author shown as "staff". '
    + 'Evidence is included only as excerpts of your own messages. '
    + 'Left out to protect other people or the staff process: who wrote a note or took an action, other people\'s messages and images, '
    + 'case edit history, who reported or redeemed something, the other member of a no-contact order, other raid joiners, '
    + 'the IP hash itself (only when it was recorded) and the login token itself (only whether one is stored). '
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
    // Only whether a token is stored: the encrypted token itself is never in the file.
    const oauth = readKey ? await readKey(`oauth:tokens:${userId}`) : null;
    sections.oauthTokenStored = Boolean(oauth && typeof oauth === 'object');
    // The language picked for Mewvo's DMs (/language without a role, the website), or null.
    const language = readKey ? await readKey(personalLanguageKey(userId)) : null;
    sections.personalLanguage = typeof language === 'string' ? language : null;
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
