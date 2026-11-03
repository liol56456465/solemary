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

    // Temporary roles (dashboard Members): the role is removed by the expiry cron at expires_at
    // and given back if the member rejoins before then. One row per member + role.
    `CREATE TABLE IF NOT EXISTS ${t.member_temp_roles} (
        guild_id VARCHAR(20) NOT NULL,
        user_id VARCHAR(20) NOT NULL,
        role_id VARCHAR(20) NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        given_by VARCHAR(20) NOT NULL,
        given_by_username VARCHAR(100) NOT NULL,
        reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (guild_id, user_id, role_id)
    )`,
    // Modmail: which member a modmail channel belongs to. The only source of truth (the channel
    // topic is ignored: staff with Manage Channels could fake it). One channel per member.
    `CREATE TABLE IF NOT EXISTS ${t.modmail_links} (
        channel_id VARCHAR(20) PRIMARY KEY,
        guild_id VARCHAR(20) NOT NULL,
        user_id VARCHAR(20) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (guild_id, user_id)
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
    // Ban/kick appeals: the appellant talks in a support-server channel (channel_id, in
    // channel_guild_id); the dossier and Accept / Deny are in a main-server staff channel.
    `ALTER TABLE ${t.mod_appeals} ADD COLUMN IF NOT EXISTS channel_guild_id VARCHAR(20)`,
    `ALTER TABLE ${t.mod_appeals} ADD COLUMN IF NOT EXISTS staff_channel_id VARCHAR(20)`,
    // Appeal status updates (schema v6): who took it ("I'm looking at it") and the 2-day reminder.
    `ALTER TABLE ${t.mod_appeals} ADD COLUMN IF NOT EXISTS claimed_by VARCHAR(20)`,
    `ALTER TABLE ${t.mod_appeals} ADD COLUMN IF NOT EXISTS claimed_by_username VARCHAR(100)`,
    `ALTER TABLE ${t.mod_appeals} ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ`,
    `ALTER TABLE ${t.mod_appeals} ADD COLUMN IF NOT EXISTS reminded_at TIMESTAMPTZ`,

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

    // Staff watchlist (/case watch): members staff keep an eye on. The member is never
    // told. A watched member joining, getting a new case or tripping automod posts one
    // line to the mod log. until NULL = no limit; ended_at is set when staff end it or
    // once it has expired.
    `CREATE TABLE IF NOT EXISTS ${t.mod_watchlist} (
        id BIGSERIAL PRIMARY KEY,
        guild_id VARCHAR(20) NOT NULL,
        user_id VARCHAR(20) NOT NULL,
        reason TEXT NOT NULL,
        created_by VARCHAR(20) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        until TIMESTAMPTZ,
        ended_at TIMESTAMPTZ,
        ended_by VARCHAR(20)
    )`,

    // Raid timeline (schema v10, dashboard Moderate → Raid timeline): one row per incident
    // (a join-raid lockdown), opened when it starts and closed when it ends, and what the
    // bot and staff did during it as short events (services/automod/incidentTimeline.js).
    // No message content. At most 2,000 events per incident (event_count, guarded in the
    // INSERT; dropped_events counts the rest); purged 90 days after the end by a daily cron.
    // report_id = the automod_raid_incidents row of the incident report, once posted.
    `CREATE TABLE IF NOT EXISTS ${t.incident_timelines} (
        id BIGSERIAL PRIMARY KEY,
        guild_id VARCHAR(20) NOT NULL,
        trigger_kind VARCHAR(20) NOT NULL,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ended_at TIMESTAMPTZ,
        ended_by VARCHAR(20),
        report_id BIGINT,
        event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
        dropped_events INTEGER NOT NULL DEFAULT 0 CHECK (dropped_events >= 0)
    )`,
    `CREATE TABLE IF NOT EXISTS ${t.incident_events} (
        id BIGSERIAL PRIMARY KEY,
        incident_id BIGINT NOT NULL REFERENCES ${t.incident_timelines}(id) ON DELETE CASCADE,
        at TIMESTAMPTZ NOT NULL,
        kind VARCHAR(30) NOT NULL,
        actor_id VARCHAR(20),
        target_id VARCHAR(20),
        detail VARCHAR(200)
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

    // Per-server settings edited from the dashboard (services/settings/guildSettings.js,
    // keys in settingsRegistry.js). Held in memory; env values seed missing keys once.
    `CREATE TABLE IF NOT EXISTS ${t.guild_settings} (
        guild_id VARCHAR(20) PRIMARY KEY,
        data JSONB NOT NULL DEFAULT '{}',
        seeded_from_env BOOLEAN NOT NULL DEFAULT FALSE,
        updated_by VARCHAR(20),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,

    // Dashboard logins (services/dashboard/sessionStore.js). Only a SHA-256 hash of the
    // session id is stored; the browser holds the id (HMAC-signed cookie).
    `CREATE TABLE IF NOT EXISTS ${t.dashboard_sessions} (
        id_hash CHAR(64) PRIMARY KEY,
        user_id VARCHAR(20) NOT NULL,
        username VARCHAR(100),
        avatar VARCHAR(100),
        csrf VARCHAR(64) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    // One-shot message shown after a dashboard form was saved (POST → 303 → GET).
    `ALTER TABLE ${t.dashboard_sessions} ADD COLUMN IF NOT EXISTS flash TEXT`,
    // "My record" logins on the website (/me, services/site/memberPortal.js). Same shape as
    // dashboard_sessions but its own table, so a member session can never be a dashboard one.
    `CREATE TABLE IF NOT EXISTS ${t.member_sessions} (
        id_hash CHAR(64) PRIMARY KEY,
        user_id VARCHAR(20) NOT NULL,
        username VARCHAR(100),
        avatar VARCHAR(100),
        csrf VARCHAR(64) NOT NULL,
        flash TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,

    // Who changed which dashboard setting (old → new), one row per key.
    `CREATE TABLE IF NOT EXISTS ${t.dashboard_audit} (
        id BIGSERIAL PRIMARY KEY,
        guild_id VARCHAR(20) NOT NULL,
        user_id VARCHAR(20),
        username VARCHAR(100),
        module VARCHAR(40) NOT NULL,
        key VARCHAR(80) NOT NULL,
        old JSONB,
        new JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,

    // Global bot blacklist (dashboard Owner area, services/owner/blacklistService.js): users or
    // servers that may not use the bot. Undo sets removed_at (the row stays as history).
    `CREATE TABLE IF NOT EXISTS ${t.bot_blacklist} (
        id BIGSERIAL PRIMARY KEY,
        kind VARCHAR(10) NOT NULL CHECK (kind IN ('user', 'guild')),
        target_id VARCHAR(20) NOT NULL,
        reason VARCHAR(300) NOT NULL,
        added_by VARCHAR(20) NOT NULL,
        added_by_username VARCHAR(100),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        removed_at TIMESTAMPTZ,
        removed_by VARCHAR(20),
        removed_by_username VARCHAR(100)
    )`,

    // Scheduled and recurring bot messages (dashboard Messages page, services/scheduledMessageService.js).
    // payload = { content, embed } as for "Send a message"; schedule = { kind: once|weekly|interval, … }
    // in the IANA `timezone`. next_run_at NULL = finished (a one-time message that was posted).
    `CREATE TABLE IF NOT EXISTS ${t.scheduled_messages} (
        id BIGSERIAL PRIMARY KEY,
        guild_id VARCHAR(20) NOT NULL,
        channel_id VARCHAR(20) NOT NULL,
        payload JSONB NOT NULL,
        schedule JSONB NOT NULL,
        timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
        next_run_at TIMESTAMPTZ,
        last_run_at TIMESTAMPTZ,
        last_error VARCHAR(500),
        last_message_id VARCHAR(20),
        failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
        paused BOOLEAN NOT NULL DEFAULT FALSE,
        created_by VARCHAR(20) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    // Role rules (dashboard Members, services/members/roleRuleService.js): a role the bot gives
    // when a member meets a condition (days in the server, leveling level, has a role), and
    // optionally takes back. Applied by a cron every 10 minutes and on join / level-up / role
    // change. last_* = the last cron run of the rule (shown on the page).
    `CREATE TABLE IF NOT EXISTS ${t.member_role_rules} (
        id BIGSERIAL PRIMARY KEY,
        guild_id VARCHAR(20) NOT NULL,
        name VARCHAR(80) NOT NULL,
        trigger_kind VARCHAR(20) NOT NULL CHECK (trigger_kind IN ('days_in_server', 'level_reached', 'has_role')),
        threshold INTEGER,
        trigger_role_id VARCHAR(20),
        role_id VARCHAR(20) NOT NULL,
        remove_when_false BOOLEAN NOT NULL DEFAULT FALSE,
        enabled BOOLEAN NOT NULL DEFAULT FALSE,
        created_by VARCHAR(20) NOT NULL,
        created_by_username VARCHAR(100) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_run_at TIMESTAMPTZ,
        last_added INTEGER NOT NULL DEFAULT 0,
        last_removed INTEGER NOT NULL DEFAULT 0,
        last_failed INTEGER NOT NULL DEFAULT 0,
        last_problem TEXT
    )`,
    // Joins and leaves (dashboard Members → Insights), one row per event; kept 90 days
    // (pruned daily, services/members/memberInsightsService.js).
    // Premium (TEST CHECKOUT ONLY, services/billing/premiumService.js; no payment provider):
    // one subscription row per Discord account, the test orders, and premium keys (gifts and
    // owner-generated). A key is unused until redeemed_at or revoked_at is set.
    `CREATE TABLE IF NOT EXISTS ${t.premium_subscriptions} (
        user_id VARCHAR(20) PRIMARY KEY,
        username VARCHAR(100),
        plan_id VARCHAR(20),
        started_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ,
        source VARCHAR(60),
        reminded_for TIMESTAMPTZ,
        ended_notified_for TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    // The cron's "ends in 3 days" / "has ended" DMs: done for this end date (an extension re-arms them).
    `ALTER TABLE ${t.premium_subscriptions} ADD COLUMN IF NOT EXISTS reminded_for TIMESTAMPTZ`,
    `ALTER TABLE ${t.premium_subscriptions} ADD COLUMN IF NOT EXISTS ended_notified_for TIMESTAMPTZ`,
    `CREATE TABLE IF NOT EXISTS ${t.premium_orders} (
        id BIGSERIAL PRIMARY KEY,
        user_id VARCHAR(20) NOT NULL,
        username VARCHAR(100),
        plan_id VARCHAR(20) NOT NULL,
        period VARCHAR(10) NOT NULL CHECK (period IN ('monthly', 'yearly')),
        kind VARCHAR(10) NOT NULL CHECK (kind IN ('personal', 'gift')),
        amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
        currency CHAR(3) NOT NULL DEFAULT 'EUR',
        test BOOLEAN NOT NULL DEFAULT TRUE,
        key_code VARCHAR(30),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS ${t.premium_keys} (
        code VARCHAR(30) PRIMARY KEY,
        plan_id VARCHAR(20) NOT NULL,
        duration_days INTEGER NOT NULL CHECK (duration_days > 0),
        source VARCHAR(10) NOT NULL CHECK (source IN ('gift', 'owner')),
        created_by VARCHAR(20) NOT NULL,
        created_by_username VARCHAR(100),
        order_id BIGINT,
        note VARCHAR(200),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        redeemed_by VARCHAR(20),
        redeemed_by_username VARCHAR(100),
        redeemed_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        revoked_by VARCHAR(20),
        gift_to VARCHAR(50),
        gift_message VARCHAR(300),
        expires_at TIMESTAMPTZ
    )`,
    // Gift "to" + message; unused keys expire (NULL = never).
    `ALTER TABLE ${t.premium_keys} ADD COLUMN IF NOT EXISTS gift_to VARCHAR(50)`,
    `ALTER TABLE ${t.premium_keys} ADD COLUMN IF NOT EXISTS gift_message VARCHAR(300)`,
    `ALTER TABLE ${t.premium_keys} ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`,
    `CREATE TABLE IF NOT EXISTS ${t.member_events} (
        id BIGSERIAL PRIMARY KEY,
        guild_id VARCHAR(20) NOT NULL,
        user_id VARCHAR(20) NOT NULL,
        kind VARCHAR(5) NOT NULL CHECK (kind IN ('join', 'leave')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    // Case tags and private staff notes (schema v6).
    `ALTER TABLE ${t.mod_cases} ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}'`,
    `CREATE TABLE IF NOT EXISTS ${t.mod_case_notes} (
        id BIGSERIAL PRIMARY KEY,
        case_code VARCHAR(7) NOT NULL REFERENCES ${t.mod_cases}(case_code) ON DELETE CASCADE,
        author_id VARCHAR(20) NOT NULL,
        author_username VARCHAR(100),
        text VARCHAR(1000) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    // Messages per server per UTC day, a count only (Dashboard → Activity; schema v6).
    `CREATE TABLE IF NOT EXISTS ${t.guild_daily_stats} (
        guild_id VARCHAR(20) NOT NULL,
        day DATE NOT NULL,
        messages INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, day)
    )`,
    // /remind: one row per reminder; sent_at set when the cron claims it (schema v6).
    `CREATE TABLE IF NOT EXISTS ${t.reminders} (
        id BIGSERIAL PRIMARY KEY,
        user_id VARCHAR(20) NOT NULL,
        guild_id VARCHAR(20),
        channel_id VARCHAR(20),
        text VARCHAR(500) NOT NULL,
        due_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        sent_at TIMESTAMPTZ,
        failed_at TIMESTAMPTZ
    )`,

    // Mewvo accounts on the website (/me/signup, services/accounts/; schema v7, no email since v8).
    // Username stored lowercase. Only a scrypt hash of the password, only "confirmed 13+"
    // (never the birth date), the 2FA secret only encrypted (AES-256-GCM). email /
    // pending_email / email_confirmed_at are only set on accounts made before v8.
    `CREATE TABLE IF NOT EXISTS ${t.member_accounts} (
        id BIGSERIAL PRIMARY KEY,
        username VARCHAR(30) NOT NULL UNIQUE,
        email VARCHAR(254) UNIQUE,
        password_hash TEXT NOT NULL,
        age_confirmed_at TIMESTAMPTZ NOT NULL,
        terms_accepted_at TIMESTAMPTZ NOT NULL,
        email_confirmed_at TIMESTAMPTZ,
        pending_email VARCHAR(254),
        discord_user_id VARCHAR(20) UNIQUE,
        discord_username VARCHAR(100),
        discord_linked_at TIMESTAMPTZ,
        totp_secret_enc TEXT,
        totp_enabled_at TIMESTAMPTZ,
        totp_last_step BIGINT,
        password_changed_at TIMESTAMPTZ,
        last_login_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    // Email links from before v8 (confirmation, email change, reset): only a SHA-256 hash of the
    // token, single use (used_at), with an expiry. Nothing writes this table since v8; the daily
    // prune empties it.
    `CREATE TABLE IF NOT EXISTS ${t.member_account_tokens} (
        token_hash CHAR(64) PRIMARY KEY,
        account_id BIGINT NOT NULL REFERENCES ${t.member_accounts}(id) ON DELETE CASCADE,
        purpose VARCHAR(20) NOT NULL CHECK (purpose IN ('confirm', 'email_change', 'reset')),
        email VARCHAR(254),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ
    )`,
    // 2FA recovery codes, hashed, each usable once.
    `CREATE TABLE IF NOT EXISTS ${t.member_account_recovery_codes} (
        account_id BIGINT NOT NULL REFERENCES ${t.member_accounts}(id) ON DELETE CASCADE,
        code_hash CHAR(64) NOT NULL,
        used_at TIMESTAMPTZ,
        PRIMARY KEY (account_id, code_hash)
    )`,
    // Early-account bonuses, one row per DISCORD account the first time it is linked:
    // link_number 1..30 may claim a 1-letter username, 1..100 get Pro for 6 months (183 days). The row
    // stays when the account is deleted or unlinked, so a Discord account never gets a second one.
    `CREATE TABLE IF NOT EXISTS ${t.member_account_bonuses} (
        discord_user_id VARCHAR(20) PRIMARY KEY,
        account_id BIGINT,
        link_number INTEGER NOT NULL UNIQUE CHECK (link_number > 0),
        pro_granted_at TIMESTAMPTZ,
        pro_skip_reason VARCHAR(200),
        letter_eligible BOOLEAN NOT NULL DEFAULT FALSE,
        letter_claimed VARCHAR(1) UNIQUE,
        letter_claimed_at TIMESTAMPTZ,
        letter_declined_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    // Race-safe counters (the next link_number): the row is locked with SELECT ... FOR UPDATE.
    `CREATE TABLE IF NOT EXISTS ${t.member_account_counters} (
        name VARCHAR(40) PRIMARY KEY,
        value BIGINT NOT NULL DEFAULT 0
    )`,
    // Website sessions of a Mewvo account: account_id set; user_id (Discord) empty until linked.
    `ALTER TABLE ${t.member_sessions} ADD COLUMN IF NOT EXISTS account_id BIGINT`,
    `ALTER TABLE ${t.member_sessions} ALTER COLUMN user_id DROP NOT NULL`,
    // Schema v8: accounts without email (username + password, Discord link required). Keeps the
    // column and its data; UNIQUE allows any number of NULLs.
    `ALTER TABLE ${t.member_accounts} ALTER COLUMN email DROP NOT NULL`,
];

export const indexStatements = [
    `CREATE INDEX IF NOT EXISTS idx_mod_cases_tags ON ${t.mod_cases} USING GIN (tags)`,
    `CREATE INDEX IF NOT EXISTS idx_mod_case_notes_case ON ${t.mod_case_notes}(case_code)`,
    `CREATE INDEX IF NOT EXISTS idx_reminders_due ON ${t.reminders}(due_at) WHERE sent_at IS NULL`,
    `CREATE INDEX IF NOT EXISTS idx_reminders_user ON ${t.reminders}(user_id)`,
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
    `CREATE INDEX IF NOT EXISTS idx_member_temp_roles_expires ON ${t.member_temp_roles}(expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_mod_cases_moderator ON ${t.mod_cases}(guild_id, moderator_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_raid_incidents_guild ON ${t.automod_raid_incidents}(guild_id, ended_at DESC)`,
    // /case search (newest first, by reason key) and the panel's precedent hint.
    `CREATE INDEX IF NOT EXISTS idx_mod_cases_guild_created ON ${t.mod_cases}(guild_id, created_at DESC, id DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_mod_cases_reason ON ${t.mod_cases}(guild_id, reason_key, created_at DESC)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_no_contact_one_open ON ${t.no_contact_orders}(guild_id, user_a, user_b) WHERE ended_at IS NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_mod_watchlist_one_open ON ${t.mod_watchlist}(guild_id, user_id) WHERE ended_at IS NULL`,
    `CREATE INDEX IF NOT EXISTS idx_incident_timelines_guild ON ${t.incident_timelines}(guild_id, started_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_incident_events_incident ON ${t.incident_events}(incident_id, at, id)`,
    `CREATE INDEX IF NOT EXISTS idx_suggestions_guild ON ${t.suggestions}(guild_id, id DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_starboard_posts_star ON ${t.starboard_posts}(star_message_id)`,
    `CREATE INDEX IF NOT EXISTS idx_dashboard_sessions_expires ON ${t.dashboard_sessions}(expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_dashboard_sessions_user ON ${t.dashboard_sessions}(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_member_sessions_expires ON ${t.member_sessions}(expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_member_sessions_account ON ${t.member_sessions}(account_id) WHERE account_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_member_accounts_unconfirmed ON ${t.member_accounts}(created_at) WHERE email_confirmed_at IS NULL`,
    `CREATE INDEX IF NOT EXISTS idx_member_account_tokens_account ON ${t.member_account_tokens}(account_id, purpose)`,
    `CREATE INDEX IF NOT EXISTS idx_member_account_tokens_expires ON ${t.member_account_tokens}(expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_dashboard_audit_guild ON ${t.dashboard_audit}(guild_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_dashboard_audit_module ON ${t.dashboard_audit}(guild_id, module, id DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_dashboard_audit_user ON ${t.dashboard_audit}(guild_id, user_id, id DESC)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_blacklist_one_active ON ${t.bot_blacklist}(kind, target_id) WHERE removed_at IS NULL`,
    `CREATE INDEX IF NOT EXISTS idx_scheduled_messages_guild ON ${t.scheduled_messages}(guild_id)`,
    `CREATE INDEX IF NOT EXISTS idx_scheduled_messages_due ON ${t.scheduled_messages}(next_run_at) WHERE paused = FALSE AND next_run_at IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_member_role_rules_guild ON ${t.member_role_rules}(guild_id, id)`,
    `CREATE INDEX IF NOT EXISTS idx_member_events_guild ON ${t.member_events}(guild_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_member_events_created ON ${t.member_events}(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_premium_orders_user ON ${t.premium_orders}(user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_premium_keys_created_by ON ${t.premium_keys}(created_by, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_premium_keys_created ON ${t.premium_keys}(created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_premium_subscriptions_expires ON ${t.premium_subscriptions}(expires_at)`,
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
