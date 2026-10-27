/**
 * Single source of truth for the PostgreSQL schema.
 *
 * Both the runtime auto-create path (src/utils/postgresDatabase.js) and the
 * standalone migration script (scripts/migrate.js) build the database from these
 * definitions, so the schema can never diverge between them.
 */

import { pgConfig } from '../../config/database/postgres.js';

const t = pgConfig.tables;

export const tableStatements = [
    `CREATE TABLE IF NOT EXISTS ${t.guilds} (
        id VARCHAR(20) PRIMARY KEY,
        config JSONB DEFAULT '{}',
        counters JSONB DEFAULT '[]',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS ${t.users} (
        id VARCHAR(20) PRIMARY KEY,
        username VARCHAR(100),
        discriminator VARCHAR(10),
        avatar VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS ${t.guild_users} (
        guild_id VARCHAR(20),
        user_id VARCHAR(20),
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (guild_id, user_id),
        FOREIGN KEY (guild_id) REFERENCES ${t.guilds}(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES ${t.users}(id) ON DELETE CASCADE
    )`,

    `CREATE TABLE IF NOT EXISTS ${t.birthdays} (
        guild_id VARCHAR(20),
        user_id VARCHAR(20),
        month INTEGER NOT NULL,
        day INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (guild_id, user_id),
        FOREIGN KEY (guild_id) REFERENCES ${t.guilds}(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES ${t.users}(id) ON DELETE CASCADE
    )`,

    `CREATE TABLE IF NOT EXISTS ${t.giveaways} (
        id SERIAL PRIMARY KEY,
        guild_id VARCHAR(20),
        message_id VARCHAR(20) NOT NULL,
        data JSONB NOT NULL,
        ends_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (guild_id) REFERENCES ${t.guilds}(id) ON DELETE CASCADE,
        UNIQUE(guild_id, message_id)
    )`,

    `CREATE TABLE IF NOT EXISTS ${t.tickets} (
        guild_id VARCHAR(20),
        channel_id VARCHAR(20) PRIMARY KEY,
        data JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP,
        FOREIGN KEY (guild_id) REFERENCES ${t.guilds}(id) ON DELETE CASCADE
    )`,

    `CREATE TABLE IF NOT EXISTS ${t.afk_status} (
        guild_id VARCHAR(20),
        user_id VARCHAR(20),
        reason TEXT,
        status_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP,
        PRIMARY KEY (guild_id, user_id),
        FOREIGN KEY (guild_id) REFERENCES ${t.guilds}(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES ${t.users}(id) ON DELETE CASCADE
    )`,

    `CREATE TABLE IF NOT EXISTS ${t.welcome_configs} (
        guild_id VARCHAR(20) PRIMARY KEY,
        config JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (guild_id) REFERENCES ${t.guilds}(id) ON DELETE CASCADE
    )`,

    `CREATE TABLE IF NOT EXISTS ${t.leveling_configs} (
        guild_id VARCHAR(20) PRIMARY KEY,
        config JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (guild_id) REFERENCES ${t.guilds}(id) ON DELETE CASCADE
    )`,

    `CREATE TABLE IF NOT EXISTS ${t.user_levels} (
        guild_id VARCHAR(20),
        user_id VARCHAR(20),
        xp BIGINT DEFAULT 0,
        level INTEGER DEFAULT 0,
        total_xp BIGINT DEFAULT 0,
        last_message TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        rank INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (guild_id, user_id),
        FOREIGN KEY (guild_id) REFERENCES ${t.guilds}(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES ${t.users}(id) ON DELETE CASCADE
    )`,

    `CREATE TABLE IF NOT EXISTS ${t.economy} (
        guild_id VARCHAR(20),
        user_id VARCHAR(20),
        balance BIGINT DEFAULT 0,
        bank BIGINT DEFAULT 0,
        data JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (guild_id, user_id),
        FOREIGN KEY (guild_id) REFERENCES ${t.guilds}(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES ${t.users}(id) ON DELETE CASCADE
    )`,

    `CREATE TABLE IF NOT EXISTS ${t.verification_audit} (
        id SERIAL PRIMARY KEY,
        guild_id VARCHAR(20) NOT NULL,
        user_id VARCHAR(20) NOT NULL,
        action VARCHAR(50) NOT NULL,
        source VARCHAR(50),
        moderator_id VARCHAR(20),
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS ${t.invite_tracking} (
        guild_id VARCHAR(20),
        inviter_id VARCHAR(20),
        invite_code VARCHAR(20),
        uses INTEGER DEFAULT 0,
        data JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (guild_id, invite_code),
        FOREIGN KEY (guild_id) REFERENCES ${t.guilds}(id) ON DELETE CASCADE
    )`,

    `CREATE TABLE IF NOT EXISTS ${t.application_roles} (
        guild_id VARCHAR(20),
        role_id VARCHAR(20),
        data JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (guild_id, role_id),
        FOREIGN KEY (guild_id) REFERENCES ${t.guilds}(id) ON DELETE CASCADE
    )`,

    `CREATE TABLE IF NOT EXISTS ${t.temp_data} (
        key VARCHAR(255) PRIMARY KEY,
        value JSONB NOT NULL,
        expires_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS ${t.cache_data} (
        key VARCHAR(255) PRIMARY KEY,
        value JSONB NOT NULL,
        expires_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    // ── Enforcement (schema v2) ────────────────────────────────────────────
    // One row per ban / kick / mute / warn. case_code is globally unique.
    `CREATE TABLE IF NOT EXISTS ${t.mod_cases} (
        id BIGSERIAL PRIMARY KEY,
        guild_id VARCHAR(20) NOT NULL,
        case_code VARCHAR(7) NOT NULL UNIQUE,
        target_user_id VARCHAR(20) NOT NULL,
        target_username VARCHAR(100) NOT NULL,
        moderator_id VARCHAR(20) NOT NULL,
        moderator_username VARCHAR(100) NOT NULL,
        type VARCHAR(10) NOT NULL CHECK (type IN ('ban', 'kick', 'mute', 'warn')),
        name VARCHAR(100) NOT NULL,
        reason TEXT NOT NULL,
        prebuilt_or_custom VARCHAR(10) NOT NULL CHECK (prebuilt_or_custom IN ('prebuilt', 'custom')),
        reason_key VARCHAR(50),
        duration_ms BIGINT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ,
        unappealable BOOLEAN NOT NULL DEFAULT FALSE,
        appeal_deadline TIMESTAMPTZ,
        ladder_level_after SMALLINT NOT NULL DEFAULT 0,
        counts_toward_level SMALLINT,
        is_auto BOOLEAN NOT NULL DEFAULT FALSE,
        is_imported BOOLEAN NOT NULL DEFAULT FALSE,
        import_key VARCHAR(120) UNIQUE,
        dm_delivered BOOLEAN NOT NULL DEFAULT FALSE,
        status VARCHAR(20) NOT NULL DEFAULT 'active'
            CHECK (status IN ('active', 'expired', 'revoked', 'appeal_pending')),
        revoked_by VARCHAR(20),
        revoked_at TIMESTAMPTZ,
        revoke_reason TEXT,
        is_test BOOLEAN NOT NULL DEFAULT FALSE
    )`,

    // Cases created by /test: real rows (appealable, shown in /appeals) that the bot
    // never acts on: no bans, unbans, roles or ladder changes.
    `ALTER TABLE ${t.mod_cases} ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE`,

    // "Your ban/mute has ended" DM: NULL = not sent (yet), TRUE/FALSE = delivered or not.
    // Sent once when the ban or mute ends (expiry or an early lift); never retried.
    `ALTER TABLE ${t.mod_cases} ADD COLUMN IF NOT EXISTS end_dm_delivered BOOLEAN`,

    // /case void: the case was a mistake. It stays on record (status 'revoked') but
    // no longer counts anywhere: ladder, offences, warn roles, staff stats.
    `ALTER TABLE ${t.mod_cases} ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ`,
    `ALTER TABLE ${t.mod_cases} ADD COLUMN IF NOT EXISTS voided_by VARCHAR(20)`,
    `ALTER TABLE ${t.mod_cases} ADD COLUMN IF NOT EXISTS void_reason TEXT`,

    // /case edit history: one row per changed field.
    `CREATE TABLE IF NOT EXISTS ${t.mod_case_edits} (
        id BIGSERIAL PRIMARY KEY,
        case_code VARCHAR(7) NOT NULL REFERENCES ${t.mod_cases}(case_code) ON DELETE CASCADE,
        edited_by VARCHAR(20) NOT NULL,
        edited_by_username VARCHAR(100) NOT NULL,
        edited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        field VARCHAR(20) NOT NULL,
        old_value TEXT,
        new_value TEXT
    )`,

    // Case evidence: message links (with a text excerpt kept in case the message is
    // deleted) and images re-hosted in the evidence channel. Discord CDN URLs expire,
    // so images are shown by re-fetching store_channel_id/store_message_id.
    `CREATE TABLE IF NOT EXISTS ${t.mod_case_evidence} (
        id BIGSERIAL PRIMARY KEY,
        case_code VARCHAR(7) NOT NULL REFERENCES ${t.mod_cases}(case_code) ON DELETE CASCADE,
        kind VARCHAR(10) NOT NULL CHECK (kind IN ('link', 'image')),
        url TEXT,
        store_channel_id VARCHAR(20),
        store_message_id VARCHAR(20),
        source_message_url TEXT,
        excerpt TEXT,
        note TEXT,
        added_by VARCHAR(20) NOT NULL,
        added_by_username VARCHAR(100) NOT NULL,
        added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,

    // Warn ladder. Never reset; lowered by one only by an accepted ladder-ban appeal.
    `CREATE TABLE IF NOT EXISTS ${t.mod_ladder} (
        guild_id VARCHAR(20) NOT NULL,
        user_id VARCHAR(20) NOT NULL,
        level SMALLINT NOT NULL DEFAULT 0,
        warns_since_level INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (guild_id, user_id)
    )`,

    // Appeals and staff reports; guild_id is the server their channel opened in.
    `CREATE TABLE IF NOT EXISTS ${t.mod_appeals} (
        id BIGSERIAL PRIMARY KEY,
        kind VARCHAR(10) NOT NULL CHECK (kind IN ('appeal', 'report')),
        case_code VARCHAR(7) REFERENCES ${t.mod_cases}(case_code),
        user_id VARCHAR(20) NOT NULL,
        username VARCHAR(100) NOT NULL,
        guild_id VARCHAR(20) NOT NULL,
        channel_id VARCHAR(20),
        body JSONB NOT NULL DEFAULT '{}',
        status VARCHAR(10) NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'accepted', 'denied', 'closed')),
        decided_by VARCHAR(20),
        decided_by_username VARCHAR(100),
        decided_at TIMESTAMPTZ,
        note TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,

    // Warnings the owner gives staff (/staff warn). They expire; enough active ones
    // remove the member's staff roles.
    `CREATE TABLE IF NOT EXISTS ${t.staff_warnings} (
        id BIGSERIAL PRIMARY KEY,
        guild_id VARCHAR(20) NOT NULL,
        user_id VARCHAR(20) NOT NULL,
        username VARCHAR(100) NOT NULL,
        reason TEXT NOT NULL,
        given_by VARCHAR(20) NOT NULL,
        given_by_username VARCHAR(100) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL
    )`,

    // One-way hashes of the IP addresses members verified from, to spot ban evasion.
    // The IP itself is never stored; rows older than 60 days are deleted unless the
    // member has an active ban.
    `CREATE TABLE IF NOT EXISTS ${t.verification_ips} (
        user_id VARCHAR(20) NOT NULL,
        ip_hash VARCHAR(64) NOT NULL,
        seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, ip_hash)
    )`,

    // Weekly staff activity counters (messages, review decisions, tickets claimed);
    // moderation actions are counted from mod_cases instead.
    `CREATE TABLE IF NOT EXISTS ${t.staff_activity} (
        guild_id VARCHAR(20) NOT NULL,
        user_id VARCHAR(20) NOT NULL,
        week_start DATE NOT NULL,
        messages INTEGER NOT NULL DEFAULT 0,
        reviews INTEGER NOT NULL DEFAULT 0,
        tickets INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, user_id, week_start)
    )`,

    // Daily snapshots of a server's roles and channels, for /backup rebuild.
    `CREATE TABLE IF NOT EXISTS ${t.server_snapshots} (
        id BIGSERIAL PRIMARY KEY,
        guild_id VARCHAR(20) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        summary TEXT NOT NULL,
        data JSONB NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS ${t.enforcement_settings} (
        guild_id VARCHAR(20) PRIMARY KEY,
        muted_role_id VARCHAR(20),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,

    // Native Discord AutoMod bridge: what the bot does when a native rule blocks a
    // message (ignore, log a line, or warn through the enforcement path). Rules without
    // a row are logged.
    `CREATE TABLE IF NOT EXISTS ${t.automod_native_rules} (
        guild_id VARCHAR(20) NOT NULL,
        rule_id VARCHAR(20) NOT NULL,
        policy VARCHAR(10) NOT NULL DEFAULT 'log' CHECK (policy IN ('ignore', 'log', 'warn')),
        dedupe_minutes INTEGER NOT NULL DEFAULT 10 CHECK (dedupe_minutes >= 0 AND dedupe_minutes <= 1440),
        updated_by VARCHAR(20),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (guild_id, rule_id)
    )`,

    // One row per ended join-raid lockdown: the incident report and its
    // "Release non-offenders" button (services/automod/raidIncidentService.js).
    `CREATE TABLE IF NOT EXISTS ${t.automod_raid_incidents} (
        id BIGSERIAL PRIMARY KEY,
        guild_id VARCHAR(20) NOT NULL,
        started_at TIMESTAMPTZ NOT NULL,
        ended_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ended_by VARCHAR(20),
        joiner_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        actions JSONB NOT NULL DEFAULT '{}'::jsonb,
        released_at TIMESTAMPTZ,
        released_by VARCHAR(20),
        release_result JSONB
    )`,

    // No-contact orders (/case nocontact): two members may not mention or reply to
    // each other until `until`. user_a < user_b (numerically), so a pair is stored
    // one way. ended_at is set when staff end it early or once it has expired.
    `CREATE TABLE IF NOT EXISTS ${t.no_contact_orders} (
        id BIGSERIAL PRIMARY KEY,
        guild_id VARCHAR(20) NOT NULL,
        user_a VARCHAR(20) NOT NULL,
        user_b VARCHAR(20) NOT NULL,
        until TIMESTAMPTZ NOT NULL,
        created_by VARCHAR(20) NOT NULL,
        reason TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ended_at TIMESTAMPTZ,
        ended_by VARCHAR(20),
        CHECK (user_a <> user_b)
    )`,

    // Sticky messages (/community sticky): reposted at the bottom of a channel after
    // members talk there. Held in memory; last_message_id is written on each repost.
    `CREATE TABLE IF NOT EXISTS ${t.sticky_messages} (
        channel_id VARCHAR(20) PRIMARY KEY,
        guild_id VARCHAR(20) NOT NULL,
        content TEXT NOT NULL,
        last_message_id VARCHAR(20),
        updated_by VARCHAR(20),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,

    // Tags (/tag): saved texts shown with /tag show, optionally posted automatically
    // when a message contains a word/phrase or matches a regex. Names are stored
    // lowercase. Held in memory per guild; uses is bumped when a tag is shown.
    `CREATE TABLE IF NOT EXISTS ${t.tags} (
        id BIGSERIAL PRIMARY KEY,
        guild_id VARCHAR(20) NOT NULL,
        name VARCHAR(32) NOT NULL,
        content TEXT NOT NULL,
        trigger_kind VARCHAR(10) NOT NULL DEFAULT 'none' CHECK (trigger_kind IN ('none', 'word', 'regex')),
        trigger TEXT,
        allow_channels TEXT[] NOT NULL DEFAULT '{}',
        deny_channels TEXT[] NOT NULL DEFAULT '{}',
        cooldown_s INTEGER NOT NULL DEFAULT 60 CHECK (cooldown_s >= 0 AND cooldown_s <= 86400),
        created_by VARCHAR(20) NOT NULL,
        uses INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (guild_id, name)
    )`,

    // Per-guild settings of the community features (/community suggestions and
    // /community starboard). Held in memory; written only when an admin changes them.
    `CREATE TABLE IF NOT EXISTS ${t.community_settings} (
        guild_id VARCHAR(20) PRIMARY KEY,
        suggestions_channel_id VARCHAR(20),
        starboard_channel_id VARCHAR(20),
        starboard_emoji VARCHAR(100) NOT NULL DEFAULT '⭐',
        starboard_threshold INTEGER NOT NULL DEFAULT 3 CHECK (starboard_threshold >= 1 AND starboard_threshold <= 100),
        updated_by VARCHAR(20),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,

    // Suggestions (/suggest): posted in the suggestions channel with vote buttons.
    // upvotes/downvotes mirror suggestion_votes and are recounted on every vote.
    `CREATE TABLE IF NOT EXISTS ${t.suggestions} (
        id BIGSERIAL PRIMARY KEY,
        guild_id VARCHAR(20) NOT NULL,
        user_id VARCHAR(20) NOT NULL,
        content TEXT NOT NULL,
        channel_id VARCHAR(20),
        message_id VARCHAR(20),
        status VARCHAR(12) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'considering')),
        status_reason TEXT,
        decided_by VARCHAR(20),
        decided_at TIMESTAMPTZ,
        upvotes INTEGER NOT NULL DEFAULT 0,
        downvotes INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS ${t.suggestion_votes} (
        suggestion_id BIGINT NOT NULL REFERENCES ${t.suggestions}(id) ON DELETE CASCADE,
        user_id VARCHAR(20) NOT NULL,
        vote SMALLINT NOT NULL CHECK (vote IN (-1, 1)),
        voted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (suggestion_id, user_id)
    )`,

    // Starboard (/community starboard): one starboard post per starred message.
    // Held in memory; written when a post is created, its count changes or it is removed.
    `CREATE TABLE IF NOT EXISTS ${t.starboard_posts} (
        source_message_id VARCHAR(20) PRIMARY KEY,
        guild_id VARCHAR(20) NOT NULL,
        source_channel_id VARCHAR(20) NOT NULL,
        star_channel_id VARCHAR(20) NOT NULL,
        star_message_id VARCHAR(20) NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,

    // Feeds (/community feed): new YouTube videos posted to a channel. Polled every
    // 15 minutes from memory; last_item_id is written only when a new video is posted.
    `CREATE TABLE IF NOT EXISTS ${t.feeds} (
        id BIGSERIAL PRIMARY KEY,
        guild_id VARCHAR(20) NOT NULL,
        kind VARCHAR(16) NOT NULL DEFAULT 'youtube' CHECK (kind IN ('youtube')),
        source_id VARCHAR(64) NOT NULL,
        channel_id VARCHAR(20) NOT NULL,
        message_template TEXT,
        last_item_id VARCHAR(64),
        created_by VARCHAR(20),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (guild_id, kind, source_id, channel_id)
    )`,
];

export const indexStatements = [
    `CREATE INDEX IF NOT EXISTS idx_guild_users_guild_id ON ${t.guild_users}(guild_id)`,
    `CREATE INDEX IF NOT EXISTS idx_guild_users_user_id ON ${t.guild_users}(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_birthdays_guild_id ON ${t.birthdays}(guild_id)`,
    `CREATE INDEX IF NOT EXISTS idx_birthdays_month_day ON ${t.birthdays}(month, day)`,
    `CREATE INDEX IF NOT EXISTS idx_giveaways_guild_id ON ${t.giveaways}(guild_id)`,
    `CREATE INDEX IF NOT EXISTS idx_giveaways_ends_at ON ${t.giveaways}(ends_at)`,
    `CREATE INDEX IF NOT EXISTS idx_tickets_guild_id ON ${t.tickets}(guild_id)`,
    `CREATE INDEX IF NOT EXISTS idx_tickets_expires_at ON ${t.tickets}(expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_afk_status_guild_id ON ${t.afk_status}(guild_id)`,
    `CREATE INDEX IF NOT EXISTS idx_afk_status_expires_at ON ${t.afk_status}(expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_user_levels_guild_id ON ${t.user_levels}(guild_id)`,
    `CREATE INDEX IF NOT EXISTS idx_user_levels_xp ON ${t.user_levels}(xp)`,
    `CREATE INDEX IF NOT EXISTS idx_economy_guild_id ON ${t.economy}(guild_id)`,
    `CREATE INDEX IF NOT EXISTS idx_verification_audit_guild_id ON ${t.verification_audit}(guild_id)`,
    `CREATE INDEX IF NOT EXISTS idx_verification_audit_user_id ON ${t.verification_audit}(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_verification_audit_created_at ON ${t.verification_audit}(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_temp_data_expires_at ON ${t.temp_data}(expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_cache_data_expires_at ON ${t.cache_data}(expires_at)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_mod_cases_guild_name ON ${t.mod_cases}(guild_id, lower(name))`,
    `CREATE INDEX IF NOT EXISTS idx_mod_cases_target ON ${t.mod_cases}(guild_id, target_user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_mod_cases_expiry ON ${t.mod_cases}(expires_at) WHERE status IN ('active', 'appeal_pending') AND expires_at IS NOT NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_mod_appeals_one_pending ON ${t.mod_appeals}(case_code) WHERE status = 'pending' AND kind = 'appeal'`,
    `CREATE INDEX IF NOT EXISTS idx_staff_warnings_user ON ${t.staff_warnings}(guild_id, user_id, expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_verification_ips_hash ON ${t.verification_ips}(ip_hash)`,
    `CREATE INDEX IF NOT EXISTS idx_server_snapshots_guild ON ${t.server_snapshots}(guild_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_mod_appeals_case ON ${t.mod_appeals}(case_code, decided_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_mod_case_edits_case ON ${t.mod_case_edits}(case_code, edited_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_mod_case_evidence_case ON ${t.mod_case_evidence}(case_code, added_at)`,
    `CREATE INDEX IF NOT EXISTS idx_mod_cases_moderator ON ${t.mod_cases}(guild_id, moderator_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_raid_incidents_guild ON ${t.automod_raid_incidents}(guild_id, ended_at DESC)`,
    // /case search (newest first, by reason key) and the panel's precedent hint.
    `CREATE INDEX IF NOT EXISTS idx_mod_cases_guild_created ON ${t.mod_cases}(guild_id, created_at DESC, id DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_mod_cases_reason ON ${t.mod_cases}(guild_id, reason_key, created_at DESC)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_no_contact_one_open ON ${t.no_contact_orders}(guild_id, user_a, user_b) WHERE ended_at IS NULL`,
    `CREATE INDEX IF NOT EXISTS idx_suggestions_guild ON ${t.suggestions}(guild_id, id DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_starboard_posts_star ON ${t.starboard_posts}(star_message_id)`,
];

export const UPDATE_TIMESTAMP_FUNCTION = `
    CREATE OR REPLACE FUNCTION update_updated_at_column()
    RETURNS TRIGGER AS $$
    BEGIN
        NEW.updated_at = CURRENT_TIMESTAMP;
        RETURN NEW;
    END;
    $$ language 'plpgsql';
`;

/**
 * Tables that carry an updated_at column maintained by the shared trigger.
 * `name` is the trigger identifier, `table` is the concrete table name.
 */
export const triggerDefinitions = [
    { name: 'update_guilds_updated_at', table: t.guilds },
    { name: 'update_users_updated_at', table: t.users },
    { name: 'update_welcome_configs_updated_at', table: t.welcome_configs },
    { name: 'update_leveling_configs_updated_at', table: t.leveling_configs },
    { name: 'update_user_levels_updated_at', table: t.user_levels },
    { name: 'update_economy_updated_at', table: t.economy },
    { name: 'update_application_roles_updated_at', table: t.application_roles },
    { name: 'update_invite_tracking_updated_at', table: t.invite_tracking },
    { name: 'update_guild_users_updated_at', table: t.guild_users },
    { name: 'update_birthdays_updated_at', table: t.birthdays },
    { name: 'update_giveaways_updated_at', table: t.giveaways },
    { name: 'update_tickets_updated_at', table: t.tickets },
    { name: 'update_afk_status_updated_at', table: t.afk_status },
];
