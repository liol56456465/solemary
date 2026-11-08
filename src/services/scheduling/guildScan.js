// guildScan.js — which servers a cron or startup job has to look at, and pacing between them.
//
// Crons used to read every server's config each run to find the few that use a feature. These
// queries return just the ids of the servers that do (one query per run). They return null when
// the bot runs on in-memory storage (no SQL); callers then check every server as before. A
// database error throws: callers skip the run or fall back to every server, never guess.

import { pgConfig } from '../../config/database/postgres.js';

const t = pgConfig.tables;

/** Waits `ms` milliseconds (not keeping the process alive). */
export function sleep(ms) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, Math.max(0, ms));
        timer.unref?.();
    });
}

/** True when SQL queries can be used (Postgres, not the in-memory fallback). */
function hasSql(client) {
    return Boolean(client?.db?.rows?.());
}

async function defaultQuery(text, params) {
    const { query } = await import('../enforcement/db.js');
    return query(text, params);
}

/**
 * The ids (strings) of `sql` (a SELECT with an `id` column), or null without SQL.
 * `query` (tests) skips the SQL check.
 */
export async function guildIdsFromSql(client, sql, params = [], { query } = {}) {
    if (!query && !hasSql(client)) return null;
    const { rows } = await (query || defaultQuery)(sql, params);
    return new Set(rows.map((row) => String(row.id)));
}

export const GUILD_SQL = {
    // Servers with at least one stats counter.
    counters: `SELECT id, counters FROM ${t.guilds}
               WHERE jsonb_typeof(counters) = 'array' AND jsonb_array_length(counters) > 0`,
    // Birthday announcements need a channel (birthdayService).
    birthdays: `SELECT id FROM ${t.guilds} WHERE COALESCE(config->>'birthdayChannelId', '') <> ''`,
    // A /ticket category makes a server take modmail (modmailService.isModmailSetUp).
    ticketCategory: `SELECT id FROM ${t.guilds} WHERE COALESCE(config->>'ticketCategoryId', '') <> ''`,
    // Ticket and verification panels (panelHealthService).
    ticketPanel: `SELECT id FROM ${t.guilds} WHERE COALESCE(config->>'ticketPanelChannelId', '') <> ''`,
    verificationPanel: `SELECT id FROM ${t.guilds}
                        WHERE COALESCE(config->'verification'->>'channelId', '') <> ''
                          AND COALESCE(config->'verification'->>'enabled', 'true') <> 'false'`,
    // Reaction role panels: temp_data keys guild:<id>:reaction_roles:<msg> and legacy reaction_roles:<id>:<msg>.
    reactionRoles: `SELECT DISTINCT split_part(key, ':', 2) AS id FROM ${t.temp_data}
                    WHERE (key LIKE 'guild:%:reaction\\_roles:%' OR key LIKE 'reaction\\_roles:%')
                      AND (expires_at IS NULL OR expires_at > NOW())`,
    // Level reward roles (levelRoleSyncService).
    levelRewards: `SELECT guild_id AS id FROM ${t.leveling_configs}
                   WHERE jsonb_typeof(config->'roleRewards') = 'object' AND config->'roleRewards' <> '{}'::jsonb
                     AND COALESCE(config->>'enabled', 'true') <> 'false'`,
    // Servers with counted messages since $1 (a YYYY-MM-DD day; server cat).
    activeSince: `SELECT DISTINCT guild_id AS id FROM ${t.guild_daily_stats} WHERE day >= $1::date`,
};
