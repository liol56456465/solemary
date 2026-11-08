// databaseLookup.js — read-only lookups for the owner-only /database command.
//
// Every query here is a fixed, parameterized SELECT: user input only ever goes in as a
// parameter ($1, $2), never into the SQL text. Table names come from pgConfig.tables (the
// allowlist in config/database/postgres.js). Nothing here writes.
//
// Secrets are never shown, not even to the owner: any column, alias, JSON field or setting
// whose name contains token, secret, password, session, key, hash (or csrf, totp, recovery)
// is replaced with HIDDEN, and so is any value that looks like a credential (bot token, a
// database URL with a password, a long hex digest, an encrypted blob). Premium codes are
// selected as their last 4 characters only; session ids, CSRF values, IP hashes, password
// hashes, 2FA secrets, recovery codes and OAuth tokens are never selected at all.
//
// A database error is thrown (the command answers "database not responding"); an empty
// result is only returned when the database really has no rows.

import { escapeMarkdown } from 'discord.js';
import { pgConfig } from '../../config/database/postgres.js';
import { botText } from '../../utils/botText.js';

export const HIDDEN = '(hidden)';
export const RECENT_ROWS = 5;
export const SEARCH_LIMIT = 10;
export const SEARCH_CASE_LIMIT = 25;
export const SEARCH_MIN = 2;
export const SEARCH_MAX = 100;
export const PAGE_TEXT_MAX = 3800; // embed description limit is 4096
export const MAX_PAGES = 25;
const VALUE_MAX = 160;
const LINE_MAX = 900;

const ID = /^\d{17,20}$/;
const CASE_CODE = /^[a-z0-9]{5,7}$/;
const SENSITIVE_NAME = /token|secret|password|passwd|session|key|hash|csrf|totp|recovery/i;
const SECRET_VALUES = [
    /^[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,}$/, // Discord bot token
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/i, // URL with user:password@
    /^[a-f0-9]{40,}$/i, // SHA-1/SHA-256 digest
    /^(?=[^\s]*[A-Za-z])[A-Za-z0-9+/=_-]{16,}(?::[A-Za-z0-9+/=_-]{16,})+$/, // iv:tag:data style encrypted value
    /^(?=[^\s]*[A-Za-z])(?=[^\s]*\d)[A-Za-z0-9+/=_-]{60,}$/, // long opaque blob
];

const VALUE_FIELDS = new Set(['value', 'old', 'new', 'old_value', 'new_value', 'data']);

/** True when a column / field / setting name marks a secret. */
export function isSensitiveName(name) {
    return Boolean(name) && SENSITIVE_NAME.test(String(name));
}

/** True when a string value looks like a credential, whatever its column is called. */
export function looksSecret(value) {
    if (typeof value !== 'string') return false;
    const text = value.trim();
    return SECRET_VALUES.some((pattern) => pattern.test(text));
}

/**
 * A copy of `value` with every secret replaced by HIDDEN: by name (column, alias, JSON field)
 * and by look (looksSecret). Dates stay dates, BigInts become strings.
 */
export function redact(value, name = null) {
    if (value === null || value === undefined) return value;
    if (isSensitiveName(name)) return HIDDEN;
    if (value instanceof Date) return value;
    if (typeof value === 'bigint') return value.toString();
    if (Buffer.isBuffer(value)) return HIDDEN;
    if (Array.isArray(value)) return value.map((item) => redact(item, null));
    if (typeof value === 'object') {
        // A name/value pair (a setting, a key-value row, an edited field): the name decides.
        const label = [value.setting, value.key, value.field, value.name].find((item) => typeof item === 'string');
        const pairHidden = isSensitiveName(label);
        return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key,
            pairHidden && VALUE_FIELDS.has(key) && inner != null ? HIDDEN : redact(inner, key)]));
    }
    if (typeof value === 'string' && looksSecret(value)) return HIDDEN;
    return value;
}

/** "%text%" for ILIKE with \, % and _ escaped (used with ESCAPE '\'). */
export function likePattern(text) {
    return `%${String(text).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** A user id from "123…", "<@123…>" or "<@!123…>", or null. */
export function parseUserId(input) {
    const text = String(input || '').trim();
    const match = /^<@!?(\d{17,20})>$/.exec(text);
    const id = match ? match[1] : text;
    return ID.test(id) ? id : null;
}

/** A case code, lowercased, or null when it can't be one. */
export function parseCaseCode(input) {
    const code = String(input || '').trim().toLowerCase();
    return CASE_CODE.test(code) ? code : null;
}

/** A refusal of the typed input. `key` + `params`: the same text in the bot catalog (owner.database.input.*). */
export class LookupInputError extends Error {
    constructor(message, key = null, params = {}) {
        super(message);
        this.name = 'LookupInputError';
        this.key = key;
        this.params = params;
    }

    /** The message in a language (English = message). */
    textIn(lang = 'en') {
        return this.key ? botText(lang).t(this.key, this.params) : this.message;
    }
}

const COUNT = 'COUNT(*) OVER() AS _n';

/**
 * /database user: [label, sql(t)] — $1 = user id, $2 = row limit. Each query returns the most
 * recent rows plus _n (all matching rows, computed before LIMIT).
 */
export const USER_SECTIONS = [
    ['Known username', (t) => `SELECT username, updated_at, ${COUNT} FROM ${t.users} WHERE id = $1 LIMIT $2`],
    ['Cases against them', (t) => `SELECT case_code, guild_id, type, status, name, LEFT(reason, 200) AS reason, moderator_username AS moderator,
        created_at, expires_at, is_test, ${COUNT} FROM ${t.mod_cases} WHERE target_user_id = $1 ORDER BY created_at DESC LIMIT $2`],
    ['Cases they gave (as moderator)', (t) => `SELECT case_code, guild_id, type, target_username AS target, created_at, ${COUNT}
        FROM ${t.mod_cases} WHERE moderator_id = $1 ORDER BY created_at DESC LIMIT $2`],
    ['Warn ladder', (t) => `SELECT guild_id, level, warns_since_level, updated_at, ${COUNT} FROM ${t.mod_ladder} WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2`],
    ['Appeals', (t) => `SELECT id, case_code, guild_id, status, created_at, decided_at, decided_by_username AS decided_by, ${COUNT}
        FROM ${t.mod_appeals} WHERE user_id = $1 AND kind = 'appeal' ORDER BY created_at DESC LIMIT $2`],
    ['Staff reports they filed', (t) => `SELECT id, guild_id, status, created_at, decided_at, ${COUNT}
        FROM ${t.mod_appeals} WHERE user_id = $1 AND kind = 'report' ORDER BY created_at DESC LIMIT $2`],
    ['Watchlist', (t) => `SELECT guild_id, LEFT(reason, 200) AS reason, created_at, until, ended_at, ${COUNT}
        FROM ${t.mod_watchlist} WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`],
    ['Keep-apart orders', (t) => `SELECT id, guild_id, CASE WHEN user_a = $1 THEN user_b ELSE user_a END AS other_member, LEFT(reason, 200) AS reason,
        until, ended_at, created_at, ${COUNT} FROM ${t.no_contact_orders} WHERE user_a = $1 OR user_b = $1 ORDER BY created_at DESC LIMIT $2`],
    ['Levels / XP', (t) => `SELECT guild_id, level, xp, total_xp, last_message, ${COUNT} FROM ${t.user_levels} WHERE user_id = $1 ORDER BY total_xp DESC LIMIT $2`],
    ['Economy', (t) => `SELECT guild_id, balance, bank, updated_at, ${COUNT} FROM ${t.economy} WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2`],
    ['Modmail channels', (t) => `SELECT guild_id, channel_id, created_at, ${COUNT} FROM ${t.modmail_links} WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`],
    ['Modmail blocked in', (t) => `SELECT id AS guild_id, ${COUNT} FROM ${t.guilds}
        WHERE jsonb_typeof(config->'modmailBlocked') = 'array' AND config->'modmailBlocked' ? $1 ORDER BY id LIMIT $2`],
    ['Verification log', (t) => `SELECT guild_id, action, source, created_at, ${COUNT} FROM ${t.verification_audit} WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`],
    // Only when an IP was seen, never the hash itself.
    ['Verification IPs seen', (t) => `SELECT seen_at, ${COUNT} FROM ${t.verification_ips} WHERE user_id = $1 ORDER BY seen_at DESC LIMIT $2`],
    ['Verification IPs seen, per server (v12)', (t) => `SELECT guild_id, seen_at, ${COUNT} FROM ${t.verification_guild_ips} WHERE user_id = $1 ORDER BY seen_at DESC LIMIT $2`],
    ['OAuth verified in', (t) => `SELECT guild_id, authorized_at, verified_at, ${COUNT} FROM ${t.oauth_verified_guilds} WHERE user_id = $1 ORDER BY authorized_at DESC LIMIT $2`],
    // Only whether the OAuth record exists in the key-value store, never its value.
    ['OAuth verification link', (t) => `SELECT 'stored' AS status, created_at, expires_at, ${COUNT} FROM ${t.temp_data}
        WHERE key = 'oauth:tokens:' || $1::text LIMIT $2`],
    ['Tickets opened', (t) => `SELECT guild_id, channel_id, data->>'status' AS status, created_at, ${COUNT}
        FROM ${t.tickets} WHERE data->>'userId' = $1 ORDER BY created_at DESC LIMIT $2`],
    ['Birthdays', (t) => `SELECT guild_id, month, day, ${COUNT} FROM ${t.birthdays} WHERE user_id = $1 ORDER BY guild_id LIMIT $2`],
    ['Mewvo website account', (t) => `SELECT id AS account_id, username AS account_name, discord_username, created_at, last_login_at,
        (totp_enabled_at IS NOT NULL) AS two_step_on, (email IS NOT NULL) AS has_email, ${COUNT}
        FROM ${t.member_accounts} WHERE discord_user_id = $1 LIMIT $2`],
    ['Website logins (My record)', (t) => `SELECT created_at, last_seen, expires_at, ${COUNT} FROM ${t.member_sessions}
        WHERE user_id = $1 ORDER BY last_seen DESC LIMIT $2`],
    ['Dashboard logins', (t) => `SELECT created_at, last_seen, expires_at, ${COUNT} FROM ${t.dashboard_sessions}
        WHERE user_id = $1 ORDER BY last_seen DESC LIMIT $2`],
    ['Early-account bonus', (t) => `SELECT link_number, pro_granted_at, letter_eligible, letter_claimed, created_at, ${COUNT}
        FROM ${t.member_account_bonuses} WHERE discord_user_id = $1 LIMIT $2`],
    ['Premium plan', (t) => `SELECT plan_id, source, started_at, expires_at, ${COUNT} FROM ${t.premium_subscriptions} WHERE user_id = $1 LIMIT $2`],
    ['Premium orders', (t) => `SELECT id, plan_id, period, kind, amount_cents, currency, test,
        CASE WHEN key_code IS NULL THEN NULL ELSE '…' || RIGHT(key_code, 4) END AS gift_code_end, created_at, ${COUNT}
        FROM ${t.premium_orders} WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`],
    ['Premium codes (made or redeemed)', (t) => `SELECT '…' || RIGHT(code, 4) AS code_end, plan_id, source, duration_days,
        CASE WHEN redeemed_by = $1 THEN 'redeemed' ELSE 'made' END AS role, created_at, redeemed_at, revoked_at, ${COUNT}
        FROM ${t.premium_keys} WHERE created_by = $1 OR redeemed_by = $1 ORDER BY created_at DESC LIMIT $2`],
    ['Bot blacklist', (t) => `SELECT reason, created_at, removed_at, ${COUNT} FROM ${t.bot_blacklist}
        WHERE kind = 'user' AND target_id = $1 ORDER BY created_at DESC LIMIT $2`],
    ['Staff warnings', (t) => `SELECT guild_id, LEFT(reason, 200) AS reason, given_by_username AS given_by, created_at, expires_at, ${COUNT}
        FROM ${t.staff_warnings} WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`],
    ['Temporary roles', (t) => `SELECT guild_id, role_id, expires_at, created_at, ${COUNT} FROM ${t.member_temp_roles}
        WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`],
    ['Joins and leaves', (t) => `SELECT guild_id, kind, created_at, ${COUNT} FROM ${t.member_events} WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`],
    ['Suggestions', (t) => `SELECT id, guild_id, status, created_at, ${COUNT} FROM ${t.suggestions} WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`],
    ['Reminders', (t) => `SELECT id, guild_id, due_at, sent_at, ${COUNT} FROM ${t.reminders} WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`],
    ['AFK', (t) => `SELECT guild_id, LEFT(reason, 200) AS reason, status_at, ${COUNT} FROM ${t.afk_status} WHERE user_id = $1 ORDER BY status_at DESC LIMIT $2`],
];

/** Tables with a guild_id column, counted by /database server (keys of pgConfig.tables). */
export const GUILD_TABLES = [
    'mod_cases', 'mod_ladder', 'mod_appeals', 'mod_watchlist', 'no_contact_orders', 'staff_warnings', 'staff_activity',
    'member_temp_roles', 'modmail_links', 'tickets', 'user_levels', 'economy', 'birthdays', 'afk_status', 'giveaways',
    'invite_tracking', 'application_roles', 'verification_audit', 'member_events', 'member_role_rules', 'guild_users',
    'server_snapshots', 'automod_native_rules', 'automod_raid_incidents', 'incident_timelines', 'sticky_messages', 'tags',
    'suggestions', 'starboard_posts', 'feeds', 'scheduled_messages', 'dashboard_audit', 'guild_daily_stats', 'reminders',
    'error_events',
];

/** Big tables whose oldest and newest rows /database stats shows: [table key, time column]. */
export const DATED_TABLES = [
    ['mod_cases', 'created_at'], ['mod_appeals', 'created_at'], ['mod_case_evidence', 'added_at'],
    ['verification_audit', 'created_at'], ['member_events', 'created_at'], ['dashboard_audit', 'created_at'],
    ['user_levels', 'created_at'], ['incident_events', 'at'], ['guild_daily_stats', 'day'], ['reminders', 'created_at'],
    ['error_events', 'created_at'],
];

function section(name, rows, { count, note } = {}) {
    const clean = (rows || []).map((row) => {
        const copy = { ...row };
        delete copy._n;
        return redact(copy);
    });
    const total = count ?? (rows?.length ? Number(rows[0]._n ?? rows.length) : 0);
    return { name, count: Number.isFinite(total) ? total : clean.length, rows: clean, note: note || null };
}

/**
 * The lookups. `query(text, params)` returns { rows } and throws on a database error (the
 * enforcement db.js query does). `tables` and `migrationTable` are injectable for tests.
 */
export function createDatabaseLookup({ query, tables = pgConfig.tables, migrationTable = pgConfig.migration.table } = {}) {
    if (typeof query !== 'function') throw new Error('createDatabaseLookup: query is required');
    const t = tables;
    const run = async (text, params = []) => (await query(text, params))?.rows || [];

    async function user(input) {
        const userId = parseUserId(input);
        if (!userId) throw new LookupInputError('That is not a user ID or @mention.', 'owner.database.input.notUser');
        const sections = [];
        for (const [name, sql] of USER_SECTIONS) {
            sections.push(section(name, await run(sql(t), [userId, RECENT_ROWS])));
        }
        return { kind: 'user', title: `User ${userId}`, subject: userId, sections };
    }

    async function server(input) {
        const guildId = String(input || '').trim();
        if (!ID.test(guildId)) throw new LookupInputError('That is not a server ID.', 'owner.database.input.notServer');
        const sections = [];
        const guildRow = await run(`SELECT created_at, updated_at,
            (SELECT array_agg(f ORDER BY f) FROM jsonb_object_keys(CASE WHEN jsonb_typeof(config) = 'object' THEN config ELSE '{}'::jsonb END) AS f) AS config_fields,
            CASE WHEN jsonb_typeof(config->'modmailBlocked') = 'array' THEN jsonb_array_length(config->'modmailBlocked') ELSE 0 END AS modmail_blocked
            FROM ${t.guilds} WHERE id = $1`, [guildId]);
        sections.push(section('Guild config row', guildRow, { count: guildRow.length }));

        const settings = await run(`SELECT s.setting, s.value FROM ${t.guild_settings} g, jsonb_each(g.data) AS s(setting, value)
            WHERE g.guild_id = $1 ORDER BY s.setting`, [guildId]);
        // The setting's own name decides whether its value is shown.
        const shown = settings.map((row) => ({ setting: row.setting, value: isSensitiveName(row.setting) ? HIDDEN : row.value }));
        sections.push(section('Settings that are set (guild_settings)', shown, { count: shown.length }));

        const modules = await run(`SELECT
            (SELECT config->>'enabled' FROM ${t.leveling_configs} WHERE guild_id = $1) AS leveling,
            (SELECT config->>'enabled' FROM ${t.welcome_configs} WHERE guild_id = $1) AS welcome,
            (SELECT config->>'goodbyeEnabled' FROM ${t.welcome_configs} WHERE guild_id = $1) AS goodbye,
            (SELECT config->'verification'->>'enabled' FROM ${t.guilds} WHERE id = $1) AS verification,
            (SELECT suggestions_channel_id IS NOT NULL FROM ${t.community_settings} WHERE guild_id = $1) AS suggestions,
            (SELECT starboard_channel_id IS NOT NULL FROM ${t.community_settings} WHERE guild_id = $1) AS starboard,
            (SELECT config->'disabledCategories' FROM ${t.guilds} WHERE id = $1) AS categories_off,
            (SELECT config->'disabledCommands' FROM ${t.guilds} WHERE id = $1) AS commands_off`, [guildId]);
        sections.push(section('Module states', modules, { count: modules.length, note: 'empty = never set (the default applies)' }));

        const countSql = GUILD_TABLES.map((name) => `SELECT '${name}' AS tbl, COUNT(*)::int AS n FROM ${t[name]} WHERE guild_id = $1`).join('\nUNION ALL\n');
        const counts = (await run(countSql, [guildId])).filter((row) => Number(row.n) > 0);
        sections.push(section('Rows per table (non-empty)', counts.map((row) => ({ table: row.tbl, rows: Number(row.n) })), { count: counts.length }));

        const open = await run(`SELECT a.id, a.kind, a.case_code, a.username, a.created_at, ${COUNT}
            FROM ${t.mod_appeals} a LEFT JOIN ${t.mod_cases} c ON c.case_code = a.case_code
            WHERE (a.guild_id = $1 OR a.channel_guild_id = $1 OR c.guild_id = $1) AND a.status = 'pending'
            ORDER BY a.created_at DESC LIMIT $2`, [guildId, 15]);
        sections.push(section('Open appeals and reports', open));
        return { kind: 'server', title: `Server ${guildId}`, subject: guildId, sections };
    }

    async function caseByCode(input) {
        const code = parseCaseCode(input);
        if (!code) throw new LookupInputError('That is not a case code (5 to 7 letters and digits).', 'owner.database.input.notCase');
        const rows = await run(`SELECT * FROM ${t.mod_cases} WHERE case_code = $1`, [code]);
        if (!rows.length) return { kind: 'case', title: `Case ${code}`, subject: code, sections: [], notFound: true };
        const sections = [section('Case', rows, { count: 1 })];
        sections.push(section('Edits', await run(`SELECT edited_at, edited_by_username AS edited_by, field, LEFT(old_value, 200) AS old_value,
            LEFT(new_value, 200) AS new_value FROM ${t.mod_case_edits} WHERE case_code = $1 ORDER BY edited_at`, [code])));
        // The image URL is a signed Discord CDN link: only where the copy is stored.
        sections.push(section('Evidence', await run(`SELECT id, kind, source_message_url, LEFT(excerpt, 300) AS excerpt, note,
            store_channel_id, store_message_id, added_by_username AS added_by, added_at
            FROM ${t.mod_case_evidence} WHERE case_code = $1 ORDER BY added_at`, [code])));
        sections.push(section('Staff notes', await run(`SELECT author_username AS author, text, created_at FROM ${t.mod_case_notes}
            WHERE case_code = $1 ORDER BY created_at`, [code])));
        sections.push(section('Appeals', await run(`SELECT id, kind, status, username, user_id, body, created_at, claimed_by_username AS claimed_by,
            decided_by_username AS decided_by, decided_at, note FROM ${t.mod_appeals} WHERE case_code = $1 ORDER BY created_at`, [code])));
        return { kind: 'case', title: `Case ${code}`, subject: code, sections };
    }

    async function stats() {
        const names = [...new Set(Object.values(t))].sort();
        const countSql = names.map((name) => `SELECT '${name}' AS tbl, COUNT(*)::bigint AS n FROM ${name}`).join('\nUNION ALL\n');
        const counts = await run(countSql);
        const sections = [section('Rows per table', counts.map((row) => ({ table: row.tbl, rows: Number(row.n) })), { count: counts.length })];

        let schema;
        try {
            schema = await run(`SELECT version, label, applied_at FROM ${migrationTable} ORDER BY version DESC LIMIT 1`);
        } catch (error) {
            if (error?.code !== '42P01') throw error; // undefined_table: never migrated; anything else is a real error
            schema = [];
        }
        sections.push(section('Schema version', schema, { count: schema.length, note: schema.length ? null : 'not recorded (no migrations table)' }));
        const size = await run('SELECT pg_size_pretty(pg_database_size(current_database())) AS size');
        sections.push(section('Database size', size, { count: size.length }));

        const datedSql = DATED_TABLES.map(([name, column]) => `SELECT '${t[name]}' AS tbl, MIN(${column})::timestamptz AS oldest, MAX(${column})::timestamptz AS newest FROM ${t[name]}`)
            .join('\nUNION ALL\n');
        const dated = await run(datedSql);
        sections.push(section('Oldest and newest rows', dated.map((row) => ({ table: row.tbl, oldest: row.oldest, newest: row.newest })), { count: dated.length }));
        return { kind: 'stats', title: 'Database stats', subject: 'stats', sections };
    }

    async function search(input) {
        const text = String(input || '').trim();
        if (text.length < SEARCH_MIN || text.length > SEARCH_MAX) {
            throw new LookupInputError(`Search for ${SEARCH_MIN} to ${SEARCH_MAX} characters.`, 'owner.database.input.searchLength', { min: SEARCH_MIN, max: SEARCH_MAX });
        }
        const p = likePattern(text);
        const sections = [];
        sections.push(section('Cases (code, reason, member or moderator name)', await run(`SELECT case_code, guild_id, type, status,
            target_user_id, target_username, moderator_username AS moderator, LEFT(reason, 120) AS reason, created_at, ${COUNT}
            FROM ${t.mod_cases}
            WHERE case_code ILIKE $1 ESCAPE '\\' OR reason ILIKE $1 ESCAPE '\\' OR target_username ILIKE $1 ESCAPE '\\' OR moderator_username ILIKE $1 ESCAPE '\\'
            ORDER BY created_at DESC LIMIT $2`, [p, SEARCH_CASE_LIMIT])));
        sections.push(section('Known usernames', await run(`SELECT id AS user_id, username, updated_at, ${COUNT} FROM ${t.users}
            WHERE username ILIKE $1 ESCAPE '\\' ORDER BY updated_at DESC NULLS LAST LIMIT $2`, [p, SEARCH_LIMIT])));
        sections.push(section('Appeals and reports (username)', await run(`SELECT id, kind, case_code, user_id, username, status, created_at, ${COUNT}
            FROM ${t.mod_appeals} WHERE username ILIKE $1 ESCAPE '\\' ORDER BY created_at DESC LIMIT $2`, [p, SEARCH_LIMIT])));
        sections.push(section('Website accounts (name or Discord name)', await run(`SELECT id AS account_id, username AS account_name, discord_user_id, discord_username, created_at, ${COUNT}
            FROM ${t.member_accounts} WHERE username ILIKE $1 ESCAPE '\\' OR discord_username ILIKE $1 ESCAPE '\\' ORDER BY created_at DESC LIMIT $2`, [p, SEARCH_LIMIT])));
        sections.push(section('Premium plans (username)', await run(`SELECT user_id, username, plan_id, expires_at, ${COUNT}
            FROM ${t.premium_subscriptions} WHERE username ILIKE $1 ESCAPE '\\' ORDER BY updated_at DESC LIMIT $2`, [p, SEARCH_LIMIT])));
        sections.push(section('Staff warnings (username)', await run(`SELECT guild_id, user_id, username, created_at, ${COUNT}
            FROM ${t.staff_warnings} WHERE username ILIKE $1 ESCAPE '\\' ORDER BY created_at DESC LIMIT $2`, [p, SEARCH_LIMIT])));
        return { kind: 'search', title: 'Search', subject: text, sections };
    }

    return { user, server, caseByCode, stats, search };
}

// ── Rendering (pure) ─────────────────────────────────────────────────────

function cut(text, max) {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** One value as Discord text: dates as <t:…:f>, secrets already HIDDEN, markdown escaped. */
export function formatValue(value) {
    if (value === null || value === undefined || value === '') return '-';
    if (value === HIDDEN) return HIDDEN;
    if (value instanceof Date) {
        const ms = value.getTime();
        return Number.isFinite(ms) ? `<t:${Math.floor(ms / 1000)}:f>` : '-';
    }
    if (typeof value === 'boolean') return value ? 'yes' : 'no';
    if (typeof value === 'number' || typeof value === 'bigint') return String(value);
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return escapeMarkdown(cut(text.replace(/\s+/g, ' ').trim(), VALUE_MAX));
}

export function formatRow(row) {
    const parts = Object.entries(row).map(([key, value]) => `${key}: ${formatValue(value)}`);
    return cut(`• ${parts.join(' · ')}`, LINE_MAX);
}

// Section names and notes in the owner's language: English text → catalog key id (owner.database.section.* /
// owner.database.note.*). Table and column names in the rows stay as they are (technical terms).
export const SECTION_KEYS = Object.freeze({
    'Known username': 'knownUsername',
    'Cases against them': 'casesAgainst',
    'Cases they gave (as moderator)': 'casesGiven',
    'Warn ladder': 'warnLadder',
    Appeals: 'appeals',
    'Staff reports they filed': 'staffReports',
    Watchlist: 'watchlist',
    'Keep-apart orders': 'keepApart',
    'Levels / XP': 'levels',
    Economy: 'economy',
    'Modmail channels': 'modmailChannels',
    'Modmail blocked in': 'modmailBlocked',
    'Verification log': 'verificationLog',
    'Verification IPs seen': 'verificationIps',
    'Verification IPs seen, per server (v12)': 'verificationIpsPerServer',
    'OAuth verified in': 'oauthVerified',
    'OAuth verification link': 'oauthLink',
    'Tickets opened': 'tickets',
    Birthdays: 'birthdays',
    'Mewvo website account': 'websiteAccount',
    'Website logins (My record)': 'websiteLogins',
    'Dashboard logins': 'dashboardLogins',
    'Early-account bonus': 'earlyBonus',
    'Premium plan': 'premiumPlan',
    'Premium orders': 'premiumOrders',
    'Premium codes (made or redeemed)': 'premiumCodes',
    'Bot blacklist': 'blacklist',
    'Staff warnings': 'staffWarnings',
    'Temporary roles': 'tempRoles',
    'Joins and leaves': 'joinsLeaves',
    Suggestions: 'suggestions',
    Reminders: 'reminders',
    AFK: 'afk',
    'Guild config row': 'guildConfig',
    'Settings that are set (guild_settings)': 'settings',
    'Module states': 'modules',
    'Rows per table (non-empty)': 'rowsNonEmpty',
    'Open appeals and reports': 'openAppeals',
    Case: 'case',
    Edits: 'edits',
    Evidence: 'evidence',
    'Staff notes': 'staffNotes',
    'Rows per table': 'rows',
    'Schema version': 'schema',
    'Database size': 'size',
    'Oldest and newest rows': 'oldestNewest',
    'Cases (code, reason, member or moderator name)': 'searchCases',
    'Known usernames': 'searchUsernames',
    'Appeals and reports (username)': 'searchAppeals',
    'Website accounts (name or Discord name)': 'searchAccounts',
    'Premium plans (username)': 'searchPremium',
    'Staff warnings (username)': 'searchStaffWarnings',
});
export const NOTE_KEYS = Object.freeze({
    'empty = never set (the default applies)': 'neverSet',
    'not recorded (no migrations table)': 'noMigrations',
});

function translated(tr, group, keys, english) {
    const id = keys[english];
    const key = id ? `owner.database.${group}.${id}` : null;
    return key && tr.has(key) ? tr.t(key) : english;
}

/** The result's title in a language (English: result.title). */
export function resultTitle(result, { lang = 'en' } = {}) {
    if (lang === 'en') return result.title;
    const tr = botText(lang);
    const titles = {
        user: () => tr.t('owner.database.title.user', { id: result.subject }),
        server: () => tr.t('owner.database.title.server', { id: result.subject }),
        case: () => tr.t('owner.database.title.case', { code: result.subject }),
        stats: () => tr.t('owner.database.title.stats'),
        search: () => tr.t('owner.database.title.search'),
    };
    return titles[result.kind] ? titles[result.kind]() : result.title;
}

/** The result as text lines: per section a header with its count, then its rows. */
export function resultLines(result, { lang = 'en' } = {}) {
    const tr = botText(lang);
    if (result.notFound) return [tr.t('owner.database.nothingFound')];
    const lines = [];
    for (const s of result.sections) {
        const showing = s.rows.length < s.count ? ` ${tr.t('owner.database.showing', { shown: s.rows.length })}` : '';
        const name = translated(tr, 'section', SECTION_KEYS, s.name);
        const note = s.note ? translated(tr, 'note', NOTE_KEYS, s.note) : null;
        lines.push(`**${escapeMarkdown(name)}**: ${s.count}${showing}${note ? ` _${escapeMarkdown(note)}_` : ''}`);
        for (const row of s.rows) lines.push(formatRow(row));
    }
    return lines.length ? lines : [tr.t('owner.database.nothingFound')];
}

/**
 * Pages of at most PAGE_TEXT_MAX characters each (and at most MAX_PAGES): { title, pages: [text] }.
 * An embed with this description, the title and a short footer stays under 6000 in total.
 */
export function paginate(result, { lang = 'en' } = {}) {
    const pages = [];
    let current = '';
    for (const line of resultLines(result, { lang })) {
        const next = current ? `${current}\n${line}` : line;
        if (next.length > PAGE_TEXT_MAX && current) {
            pages.push(current);
            current = line;
        } else {
            current = next;
        }
    }
    if (current) pages.push(current);
    const truncated = pages.length > MAX_PAGES;
    const kept = pages.slice(0, MAX_PAGES);
    if (truncated) kept[kept.length - 1] = `${cut(kept.at(-1), PAGE_TEXT_MAX - 60)}\n${botText(lang).t('owner.database.morePages')}`;
    return { title: cut(resultTitle(result, { lang }), 200), pages: kept };
}

// ── Pages kept for the buttons ───────────────────────────────────────────

export const PAGE_TTL_MS = 15 * 60 * 1000;
export const PAGE_STORE_MAX = 50;

/**
 * A bounded TTL map of rendered (already redacted) results: nonce → { ownerId, title, pages,
 * expiresAt }. Memory only; a restart or the TTL ends the buttons ("run /database again").
 */
export function createPageStore({ ttlMs = PAGE_TTL_MS, max = PAGE_STORE_MAX, now = () => Date.now() } = {}) {
    const entries = new Map();
    const prune = () => {
        const at = now();
        for (const [nonce, entry] of entries) if (entry.expiresAt <= at) entries.delete(nonce);
        while (entries.size > max) entries.delete(entries.keys().next().value);
    };
    return {
        put(nonce, entry) {
            prune();
            entries.set(nonce, { ...entry, expiresAt: now() + ttlMs });
            prune();
        },
        get(nonce) {
            const entry = entries.get(nonce);
            if (!entry) return null;
            if (entry.expiresAt <= now()) {
                entries.delete(nonce);
                return null;
            }
            return entry;
        },
        get size() {
            return entries.size;
        },
    };
}

export const lookupPages = createPageStore();
