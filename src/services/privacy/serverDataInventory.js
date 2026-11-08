// serverDataInventory.js — EVERY place a server's data lives, in one list (owner decision
// 2026-11-07: a server's data is kept after the bot is removed until the server's owner asks for
// it to be deleted; serverDataDeletion.js deletes exactly what is listed here).
//
// tests/serverDataInventory.test.js reads src/utils/database/schema.js and fails when a table with
// a guild_id column (or any new table) is not classified here. When you add a table: put it in
// TABLES (per-server data), or in NOT_SERVER_DATA with the reason it holds none.
//
// Each TABLES entry:
//   key     the pgConfig.tables key (the real name comes from pgConfig, never from input)
//   kind    the line it is counted under in the preview (KINDS)
//   where   (tables) => SQL condition for the rows of ONE server; `$1` is the server id and the
//           only parameter
//   mode    'delete' (default) or 'detach' (the row is the member's own: only the server link goes)
// Entries run in this order inside their kind's transaction (children before parents). The kinds
// run in GROUP_ORDER (appeals before cases: mod_appeals.case_code has no ON DELETE CASCADE; the
// guilds row last: it cascades into the old per-server tables, which are emptied explicitly first).
//
// Cross-server data is never touched: a member's own account, tokens, premium, reminders' text,
// and other servers' cases. Mod cases also feed members' "My record" across servers, so this
// server's cases disappear from there too (the preview says so).

/** The preview lines, in the order shown. */
export const KINDS = Object.freeze([
    'cases', 'appeals', 'moderation', 'settings', 'logs', 'levels', 'tickets', 'automod', 'snapshots',
    'community', 'verification', 'oauthLinks', 'insights', 'audit', 'kv', 'misc',
]);

/** One transaction per group, in this order ('logs' has no rows of its own: it lives in the guilds row). */
export const GROUP_ORDER = Object.freeze([
    'appeals', 'cases', 'moderation', 'levels', 'tickets', 'automod', 'snapshots', 'community',
    'verification', 'oauthLinks', 'insights', 'audit', 'misc', 'kv', 'settings',
]);

const CASES = (t) => `SELECT case_code FROM ${t.mod_cases} WHERE guild_id = $1`;
const APPEALS = (t) => `SELECT id FROM ${t.mod_appeals} WHERE guild_id = $1 OR case_code IN (${CASES(t)})`;

/**
 * The key-value store (temp_data / cache_data): every key that names this server's id as a whole
 * number (guild:<id>:…, automod:settings:<id>, ticket_config_<id>, legacy keys …). Snowflakes are
 * unique across Discord, so a key holding this id belongs to this server. The deletion request
 * itself (serverdata:deletion:<id>) is kept: it records the request and its result.
 */
export const DELETION_KEY_PREFIX = 'serverdata:deletion:';
const KV_MATCH = () => `key ~ ('(^|[^0-9])' || $1 || '([^0-9]|$)') AND key NOT LIKE '${DELETION_KEY_PREFIX}%'`;

export const TABLES = Object.freeze([
    // ── Appeals and staff reports (before the cases they point at) ──
    { key: 'temp_data', kind: 'appeals', where: (t) => `key IN (SELECT 'appeals:stale-reminded:' || id FROM ${t.mod_appeals} WHERE guild_id = $1 OR case_code IN (${CASES(t)}))`, note: 'stale-appeal reminder marks' },
    { key: 'mod_appeals', kind: 'appeals', where: (t) => `id IN (${APPEALS(t)})` },
    // ── Cases (children first; they also cascade) ──
    { key: 'temp_data', kind: 'cases', where: (t) => `key IN (SELECT 'automod:contest:' || case_code FROM ${t.mod_cases} WHERE guild_id = $1)`, note: 'automod "contest this" records' },
    { key: 'mod_case_evidence', kind: 'cases', where: (t) => `case_code IN (${CASES(t)})` },
    { key: 'mod_case_notes', kind: 'cases', where: (t) => `case_code IN (${CASES(t)})` },
    { key: 'mod_case_edits', kind: 'cases', where: (t) => `case_code IN (${CASES(t)})` },
    { key: 'mod_cases', kind: 'cases', where: () => 'guild_id = $1' },
    { key: 'mod_ladder', kind: 'cases', where: () => 'guild_id = $1' },
    // ── Other moderation records ──
    { key: 'mod_watchlist', kind: 'moderation', where: () => 'guild_id = $1' },
    { key: 'no_contact_orders', kind: 'moderation', where: () => 'guild_id = $1' },
    { key: 'member_temp_roles', kind: 'moderation', where: () => 'guild_id = $1' },
    { key: 'staff_warnings', kind: 'moderation', where: () => 'guild_id = $1' },
    { key: 'staff_activity', kind: 'moderation', where: () => 'guild_id = $1' },
    { key: 'modmail_links', kind: 'moderation', where: () => 'guild_id = $1' },
    // ── Levels and members' per-server data ──
    { key: 'user_levels', kind: 'levels', where: () => 'guild_id = $1' },
    { key: 'economy', kind: 'levels', where: () => 'guild_id = $1' },
    { key: 'afk_status', kind: 'levels', where: () => 'guild_id = $1' },
    { key: 'birthdays', kind: 'levels', where: () => 'guild_id = $1' },
    { key: 'guild_users', kind: 'levels', where: () => 'guild_id = $1' },
    // ── Tickets ──
    { key: 'tickets', kind: 'tickets', where: () => 'guild_id = $1' },
    // ── Automod, raids, incidents ──
    { key: 'automod_native_rules', kind: 'automod', where: () => 'guild_id = $1' },
    { key: 'automod_raid_incidents', kind: 'automod', where: () => 'guild_id = $1' },
    { key: 'incident_events', kind: 'automod', where: (t) => `incident_id IN (SELECT id FROM ${t.incident_timelines} WHERE guild_id = $1)` },
    { key: 'incident_timelines', kind: 'automod', where: () => 'guild_id = $1' },
    // ── Structure snapshots (/backup) ──
    { key: 'server_snapshots', kind: 'snapshots', where: () => 'guild_id = $1' },
    // ── Community features and posts the bot manages ──
    { key: 'suggestion_votes', kind: 'community', where: (t) => `suggestion_id IN (SELECT id FROM ${t.suggestions} WHERE guild_id = $1)` },
    { key: 'suggestions', kind: 'community', where: () => 'guild_id = $1' },
    { key: 'starboard_posts', kind: 'community', where: () => 'guild_id = $1' },
    { key: 'sticky_messages', kind: 'community', where: () => 'guild_id = $1' },
    { key: 'tags', kind: 'community', where: () => 'guild_id = $1' },
    { key: 'feeds', kind: 'community', where: () => 'guild_id = $1' },
    { key: 'giveaways', kind: 'community', where: () => 'guild_id = $1' },
    { key: 'scheduled_messages', kind: 'community', where: () => 'guild_id = $1' },
    { key: 'member_role_rules', kind: 'community', where: () => 'guild_id = $1' },
    { key: 'application_roles', kind: 'community', where: () => 'guild_id = $1' },
    { key: 'invite_tracking', kind: 'community', where: () => 'guild_id = $1' },
    // ── Verification ──
    { key: 'verification_audit', kind: 'verification', where: () => 'guild_id = $1' },
    { key: 'verification_guild_ips', kind: 'verification', where: () => 'guild_id = $1' },
    // Member backups: which members verified HERE (the purpose binding of their guilds.join token).
    // The tokens themselves are the members' own (cross-server) and stay.
    { key: 'oauth_verified_guilds', kind: 'oauthLinks', where: () => 'guild_id = $1' },
    // ── Member insights ──
    { key: 'member_events', kind: 'insights', where: () => 'guild_id = $1' },
    { key: 'guild_daily_stats', kind: 'insights', where: () => 'guild_id = $1' },
    // ── Dashboard audit log of this server ──
    { key: 'dashboard_audit', kind: 'audit', where: () => 'guild_id = $1' },
    // ── Other ──
    { key: 'error_events', kind: 'misc', where: () => 'guild_id = $1' },
    // A member's own reminder stays theirs; it only loses the server channel (sent by DM).
    { key: 'reminders', kind: 'misc', where: () => 'guild_id = $1', mode: 'detach', set: 'guild_id = NULL, channel_id = NULL' },
    // ── Key-value store ──
    { key: 'temp_data', kind: 'kv', where: KV_MATCH },
    { key: 'cache_data', kind: 'kv', where: KV_MATCH },
    // ── Settings (last: the guilds row cascades into the old per-server tables above) ──
    { key: 'guild_settings', kind: 'settings', where: () => 'guild_id = $1' },
    { key: 'enforcement_settings', kind: 'settings', where: () => 'guild_id = $1' },
    { key: 'community_settings', kind: 'settings', where: () => 'guild_id = $1' },
    { key: 'welcome_configs', kind: 'settings', where: () => 'guild_id = $1' },
    { key: 'leveling_configs', kind: 'settings', where: () => 'guild_id = $1' },
    // The server config (also holds the logging channels and filters: counted as 'logs' too).
    { key: 'guilds', kind: 'settings', where: () => 'id = $1' },
]);

/**
 * Not counted as rows: the logging setup lives inside the guilds row's config. The preview shows
 * it as its own line (1 when the server has logging configured).
 */
export const LOGS_COUNT_SQL = (t) => `SELECT COUNT(*)::int AS n FROM ${t.guilds} WHERE id = $1 AND config ? 'logging'`;

/** Tables that hold no per-server data, and why (the guard test needs every table classified). */
export const NOT_SERVER_DATA = Object.freeze({
    users: 'a Discord account (name, avatar), shared by every server',
    verification_ips: 'hashed IPs per member for ban-evasion checks, not tied to a server',
    dashboard_sessions: 'dashboard logins of a person, not of a server',
    member_sessions: '"My record" logins of a person',
    bot_blacklist: 'the bot owner\'s safety record of blocked accounts and servers; kept as history',
    premium_subscriptions: 'a person\'s plan',
    premium_orders: 'a person\'s (test) orders',
    premium_keys: 'premium keys of a person',
    member_accounts: 'a person\'s Mewvo account',
    member_account_tokens: 'a person\'s account links',
    member_account_recovery_codes: 'a person\'s 2FA codes',
    member_account_bonuses: 'a person\'s early-account bonus',
    member_account_counters: 'global counters',
    site_content: 'website text',
    site_content_history: 'website text history',
    site_images: 'website images',
});

/** Child tables covered through their parent (FK), listed in TABLES with a sub-select. */
export const CHILD_TABLES = Object.freeze(['mod_case_edits', 'mod_case_evidence', 'mod_case_notes', 'incident_events', 'suggestion_votes']);

/** Every pgConfig key the inventory deletes from (or detaches). */
export function coveredTableKeys() {
    return [...new Set(TABLES.map((entry) => entry.key))];
}

/** The entries of one group, in run order. */
export function entriesOf(kind) {
    return TABLES.filter((entry) => entry.kind === kind);
}
