// tagService.js — tags and auto-responders (/tag show | list | create | edit | delete).
//
// A tag is a saved text members can post with /tag show. A tag may also have a
// trigger (a word/phrase or a regex, see tagMatcher.js): a member message that
// matches gets the tag as a reply, limited per channel by allow/deny lists and a
// cooldown. Tags are held in memory per guild (loaded at startup, reloaded for a
// guild after each change), so messageCreate never reads the database.

import { logger } from '../../utils/logger.js';
import { CT, query, isCommunityDbAvailable, isUniqueViolation, userError } from './db.js';
import { channelAllowed, compileTrigger, matchFirst, onCooldown } from './tagMatcher.js';

export const TAG_NAME = /^[a-z0-9_-]{1,32}$/;
export const TAG_CONTENT_MAX = 2000;
export const TAG_MAX_PER_GUILD = 100;
export const TAG_DEFAULT_COOLDOWN_S = 60;
export const TAG_MIN_TRIGGER_COOLDOWN_S = 5;
export const TRIGGER_KINDS = ['none', 'word', 'regex'];

// guildId → { tags: [tag], triggered: [tag with pattern] }
let byGuild = new Map();
let loaded = false;
const lastFired = new Map(); // tagId:channelId → ms
const LAST_FIRED_MAX = 5000;

/** Row → cached tag; compiles the trigger (a broken one is kept but never fires). */
export function toTag(row) {
    const tag = {
        id: Number(row.id),
        guildId: row.guild_id,
        name: row.name,
        content: row.content,
        triggerKind: row.trigger_kind || 'none',
        trigger: row.trigger || null,
        allowChannels: row.allow_channels || [],
        denyChannels: row.deny_channels || [],
        cooldownS: Number(row.cooldown_s ?? TAG_DEFAULT_COOLDOWN_S),
        createdBy: row.created_by,
        uses: Number(row.uses || 0),
        pattern: null,
    };
    if (tag.triggerKind !== 'none') {
        try {
            tag.pattern = compileTrigger(tag.triggerKind, tag.trigger);
        } catch (error) {
            logger.warn(`Tag ${tag.guildId}/${tag.name}: trigger disabled (${error.message})`);
        }
    }
    return tag;
}

function indexGuild(tags) {
    const sorted = [...tags].sort((a, b) => a.name.localeCompare(b.name));
    return { tags: sorted, triggered: sorted.filter((tag) => tag.pattern) };
}

export async function loadTags() {
    if (!isCommunityDbAvailable()) return null;
    const { rows } = await query(`SELECT * FROM ${CT.tags}`);
    const grouped = new Map();
    for (const row of rows) {
        if (!grouped.has(row.guild_id)) grouped.set(row.guild_id, []);
        grouped.get(row.guild_id).push(toTag(row));
    }
    byGuild = new Map([...grouped].map(([guildId, tags]) => [guildId, indexGuild(tags)]));
    loaded = true;
    return rows.length;
}

async function reloadGuild(guildId) {
    const { rows } = await query(`SELECT * FROM ${CT.tags} WHERE guild_id = $1`, [guildId]);
    if (rows.length) byGuild.set(guildId, indexGuild(rows.map(toTag)));
    else byGuild.delete(guildId);
}

async function reloadQuietly(guildId) {
    await reloadGuild(guildId).catch((error) => logger.warn(`Tag cache reload failed for ${guildId}: ${error.message}`));
}

export function isTagCacheLoaded() {
    return loaded;
}

/** Tags of a guild from memory, sorted by name. */
export function listTags(guildId) {
    return byGuild.get(guildId)?.tags || [];
}

export function getTag(guildId, name) {
    const key = String(name ?? '').trim().toLowerCase();
    return listTags(guildId).find((tag) => tag.name === key) || null;
}

function bumpUses(tag) {
    tag.uses += 1;
    query(`UPDATE ${CT.tags} SET uses = uses + 1 WHERE id = $1`, [tag.id])
        .catch((error) => logger.debug(`Tag uses not saved for ${tag.id}: ${error.message}`));
}

/** /tag show: the tag, with its use counted; null when there is none. */
export function useTag(guildId, name) {
    const tag = getTag(guildId, name);
    if (tag) bumpUses(tag);
    return tag;
}

/**
 * A tag's trigger is switched off after this many timeouts within the window. One timeout
 * can be plain CPU load; successful matches do not clear the count (a pattern that is slow
 * only on some messages must not dodge the limit by alternating with fast ones).
 */
export const TRIGGER_TIMEOUT_STRIKES = 3;
export const TRIGGER_TIMEOUT_WINDOW_MS = 10 * 60 * 1000;

/**
 * The tag a member message triggers, or null; pure apart from the cooldown map.
 * Matching all of a guild's patterns is one time-boxed vm call; a pattern that runs past
 * the timeout TRIGGER_TIMEOUT_STRIKES times within TRIGGER_TIMEOUT_WINDOW_MS is switched off
 * until the next reload. `match` is injectable for tests.
 */
export function findTriggeredTag(message, now = Date.now(), match = matchFirst) {
    const entry = byGuild.get(message.guild?.id);
    if (!entry?.triggered.length || !message.content) return null;
    const channelId = message.channel?.id;
    const parentId = message.channel?.isThread?.() ? message.channel.parentId : null;
    const candidates = entry.triggered.filter((tag) => tag.pattern
        && channelAllowed(tag, channelId, parentId)
        && !onCooldown(lastFired.get(`${tag.id}:${channelId}`), now, tag.cooldownS));
    if (!candidates.length) return null;
    const hit = match(candidates.map((tag) => tag.pattern), message.content);
    if (hit === null) {
        // Find the slow one(s) and count the timeout; repeated timeouts switch the tag off
        // rather than paying the timeout on every message.
        for (const tag of candidates) {
            if (match([tag.pattern], message.content) !== null) continue;
            tag.timeoutsAt = (tag.timeoutsAt || []).filter((at) => now - at < TRIGGER_TIMEOUT_WINDOW_MS);
            tag.timeoutsAt.push(now);
            if (tag.timeoutsAt.length >= TRIGGER_TIMEOUT_STRIKES) {
                logger.warn(`Tag ${tag.guildId}/${tag.name}: regex timed out ${tag.timeoutsAt.length} times in 10 min; trigger disabled until the tag is edited or the bot restarts`);
                tag.pattern = null;
            }
        }
        entry.triggered = entry.triggered.filter((tag) => tag.pattern);
        return null;
    }
    if (hit < 0) return null;
    const tag = candidates[hit];
    lastFired.set(`${tag.id}:${channelId}`, now);
    if (lastFired.size > LAST_FIRED_MAX) lastFired.delete(lastFired.keys().next().value);
    return tag;
}

/** messageCreate hook (after automod; not for commands): replies with a triggered tag. Never throws. */
export async function respondToTags(message) {
    try {
        if (!message.guild || message.author?.bot) return false;
        const tag = findTriggeredTag(message);
        if (!tag) return false;
        bumpUses(tag);
        await message.reply({ content: tag.content, allowedMentions: { parse: [], repliedUser: false } });
        return true;
    } catch (error) {
        logger.warn(`Tag auto-response failed: ${error.message}`);
        return false;
    }
}

function normalizeFields(fields, existing = null) {
    const out = {};
    if (fields.content !== undefined) {
        const content = String(fields.content ?? '').trim();
        if (!content) throw userError('The tag text cannot be empty.');
        if (content.length > TAG_CONTENT_MAX) throw userError(`Tag text is limited to ${TAG_CONTENT_MAX} characters.`);
        out.content = content;
    }
    const kind = fields.triggerKind ?? existing?.triggerKind ?? 'none';
    if (!TRIGGER_KINDS.includes(kind)) throw userError('trigger_kind must be none, word or regex.');
    if (kind === 'none' && fields.triggerKind === undefined && fields.trigger) {
        throw userError('This tag has no trigger; set trigger_kind (word or regex) along with the trigger.');
    }
    if (fields.triggerKind !== undefined || fields.trigger !== undefined) {
        const trigger = kind === 'none' ? null : String(fields.trigger ?? existing?.trigger ?? '').trim();
        if (kind !== 'none') {
            try {
                compileTrigger(kind, trigger);
            } catch (error) {
                throw userError(error.message);
            }
        }
        out.trigger_kind = kind;
        out.trigger = trigger;
    }
    if (fields.allowChannels !== undefined) out.allow_channels = fields.allowChannels;
    if (fields.denyChannels !== undefined) out.deny_channels = fields.denyChannels;
    if (fields.cooldownS !== undefined && fields.cooldownS !== null) {
        const cooldown = Number(fields.cooldownS);
        if (!Number.isInteger(cooldown) || cooldown < 0 || cooldown > 86400) throw userError('cooldown must be 0–86400 seconds.');
        out.cooldown_s = cooldown;
    }
    // A trigger without a cooldown could answer every single message.
    const finalKind = out.trigger_kind ?? existing?.triggerKind ?? 'none';
    const finalCooldown = out.cooldown_s ?? existing?.cooldownS ?? TAG_DEFAULT_COOLDOWN_S;
    if (finalKind !== 'none' && finalCooldown < TAG_MIN_TRIGGER_COOLDOWN_S) {
        throw userError(`Tags with a trigger need a cooldown of at least ${TAG_MIN_TRIGGER_COOLDOWN_S} seconds.`);
    }
    return out;
}

/** Creates a tag; returns the cached tag. */
export async function createTag({ guildId, name, content, triggerKind = 'none', trigger = null, allowChannels = [], denyChannels = [], cooldownS = null, createdBy }) {
    const key = String(name ?? '').trim().toLowerCase();
    if (!TAG_NAME.test(key)) throw userError('Tag names use lowercase letters, digits, - and _ (up to 32).');
    const fields = normalizeFields({ content, triggerKind, trigger, allowChannels, denyChannels, cooldownS: cooldownS ?? TAG_DEFAULT_COOLDOWN_S });
    const { rows: [{ count }] } = await query(`SELECT COUNT(*)::int AS count FROM ${CT.tags} WHERE guild_id = $1`, [guildId]);
    if (count >= TAG_MAX_PER_GUILD) throw userError(`A server can have at most ${TAG_MAX_PER_GUILD} tags.`);
    try {
        await query(
            `INSERT INTO ${CT.tags} (guild_id, name, content, trigger_kind, trigger, allow_channels, deny_channels, cooldown_s, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [guildId, key, fields.content, fields.trigger_kind, fields.trigger, fields.allow_channels, fields.deny_channels, fields.cooldown_s, createdBy]
        );
    } catch (error) {
        if (isUniqueViolation(error)) throw userError(`There is already a tag called **${key}**. Use \`/tag edit\` to change it.`);
        throw error;
    }
    await reloadQuietly(guildId);
    return getTag(guildId, key);
}

/** Changes the given fields of a tag; returns the cached tag, or null when there is none. */
export async function editTag({ guildId, name, ...changes }) {
    const key = String(name ?? '').trim().toLowerCase();
    const existing = getTag(guildId, key);
    const fields = normalizeFields(changes, existing || { triggerKind: 'none', cooldownS: TAG_DEFAULT_COOLDOWN_S });
    const columns = Object.keys(fields);
    if (!columns.length) throw userError('Give at least one thing to change.');
    const sets = columns.map((column, i) => `${column} = $${i + 3}`);
    const { rowCount } = await query(
        `UPDATE ${CT.tags} SET ${sets.join(', ')}, updated_at = NOW() WHERE guild_id = $1 AND name = $2`,
        [guildId, key, ...columns.map((column) => fields[column])]
    );
    await reloadQuietly(guildId);
    return rowCount ? getTag(guildId, key) : null;
}

/** Deletes a tag; true when there was one. */
export async function deleteTag(guildId, name) {
    const key = String(name ?? '').trim().toLowerCase();
    const { rowCount } = await query(`DELETE FROM ${CT.tags} WHERE guild_id = $1 AND name = $2`, [guildId, key]);
    await reloadQuietly(guildId);
    return rowCount > 0;
}

/** For tests: replace the in-memory tags (rows as stored). */
export function setTagsForTests(rows) {
    const grouped = new Map();
    for (const row of rows) {
        if (!grouped.has(row.guild_id)) grouped.set(row.guild_id, []);
        grouped.get(row.guild_id).push(toTag(row));
    }
    byGuild = new Map([...grouped].map(([guildId, tags]) => [guildId, indexGuild(tags)]));
    lastFired.clear();
    loaded = true;
}
