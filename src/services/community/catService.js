// catService.js — the Mewvo server cat: one cat per server that grows with the server's
// activity. No table of its own:
//
//   growth     the server's counted messages: guild_daily_stats (kept 400 days by
//              activityService.js) plus what is still buffered in memory
//   mood       raid lockdown (raidService) → scared; grew a stage in the last 24 h → proud;
//              last 7 days ≥ the 7 before → happy; else sleepy (catModel.js catMood)
//   settings   name and the growth announcement switch: settings registry (catName,
//              catAnnounce; guild_settings)
//   state      the last stage recorded by the growth check and when it was reached: the
//              key-value store under `server_cat:<guildId>` ({ stage, grownAt })
//
// Reads throw on a database error (callers say "database not responding"); nothing returns a
// made-up cat. The growth check runs from a cron (app.js), never per message.

import { AttachmentBuilder, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { fileURLToPath } from 'node:url';
import { pgConfig } from '../../config/database/postgres.js';
import { query as defaultQuery } from '../enforcement/db.js';
import { resolveSetting } from '../settings/guildSettings.js';
import { pendingMessages } from '../stats/activityService.js';
import { logger } from '../../utils/logger.js';
import {
    CAT_DEFAULT_NAME, CAT_STAGES, catImageFile, catMood, catProgressLine, growthAction, moodSentence, sanitizeCatName,
    shownStage, stageIndexFor, stageProgress,
} from './catModel.js';

export * from './catModel.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const IMG_DIR = new URL('../site/static/img/cat/', import.meta.url);
const stateKey = (guildId) => `server_cat:${guildId}`;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

let kv = null;
async function kvHelpers() {
    if (!kv) kv = await import('../../utils/database/wrapper.js');
    return kv;
}

/** The stored growth state { stage, grownAt } or null. Throws on a database error. */
export async function getCatState(guildId) {
    const { getFromDb } = await kvHelpers();
    const value = await getFromDb(stateKey(guildId), null);
    return value && typeof value === 'object' && Number.isInteger(value.stage) ? value : null;
}

/** Saves the growth state; throws when it was not saved. */
export async function setCatState(guildId, state) {
    const { setInDb } = await kvHelpers();
    await setInDb(stateKey(guildId), { stage: state.stage, grownAt: state.grownAt || null });
}

async function defaultLockdown(guildId) {
    const { isLockdownActive } = await import('../automod/raidService.js');
    return isLockdownActive(guildId);
}

/**
 * The cat's name and announcement switch of this server (settings registry; synchronous, from the
 * cache). Throws SettingsUnavailableError when another server's settings could not be read.
 */
export function catSettings(guildId, env = process.env) {
    const name = sanitizeCatName(resolveSetting(guildId, 'catName', env)) || CAT_DEFAULT_NAME;
    return { name, announce: resolveSetting(guildId, 'catAnnounce', env) !== false };
}

/**
 * { total, lastWeek, previousWeek } of a server: every stored day plus the buffered counts.
 * Weeks are UTC days: the last 7 (today included) and the 7 before. Throws on a database error.
 */
export async function catActivity(guildId, { query = defaultQuery, pending = pendingMessages, now = Date.now() } = {}) {
    const t = pgConfig.tables.guild_daily_stats;
    const weekFrom = dayOf(now - 6 * DAY_MS);
    const prevFrom = dayOf(now - 13 * DAY_MS);
    const { rows: [row] } = await query(
        `SELECT COALESCE(SUM(messages), 0)::bigint AS total,
                COALESCE(SUM(messages) FILTER (WHERE day >= $2::date), 0)::bigint AS last_week,
                COALESCE(SUM(messages) FILTER (WHERE day >= $3::date AND day < $2::date), 0)::bigint AS previous_week
         FROM ${t} WHERE guild_id = $1`,
        [guildId, weekFrom, prevFrom],
    );
    const out = { total: Number(row?.total) || 0, lastWeek: Number(row?.last_week) || 0, previousWeek: Number(row?.previous_week) || 0 };
    for (const { day, count } of pending(guildId)) {
        out.total += count;
        if (day >= weekFrom) out.lastWeek += count;
        else if (day >= prevFrom) out.previousWeek += count;
    }
    return out;
}

/**
 * Everything a view needs: { name, announce, stageIndex, stage, mood, sentence, total,
 * progress: { fraction, toNext, next }, image }. Throws on a database error.
 * `deps` (tests): query, pending, lockdown(guildId), getState(guildId), now, env.
 */
export async function getServerCat(guildId, deps = {}) {
    const { now = Date.now(), env = process.env, lockdown = defaultLockdown, getState = getCatState } = deps;
    const [activity, state, locked] = await Promise.all([
        catActivity(guildId, { query: deps.query, pending: deps.pending, now }),
        getState(guildId),
        lockdown(guildId),
    ]);
    const { name, announce } = catSettings(guildId, env);
    const stageIndex = shownStage(stageIndexFor(activity.total), state);
    const mood = catMood({
        lockdown: locked, grownAt: state?.grownAt, grownStage: state?.stage, stageIndex,
        lastWeek: activity.lastWeek, previousWeek: activity.previousWeek, now,
    });
    return {
        name, announce, stageIndex, stage: CAT_STAGES[stageIndex], mood, sentence: moodSentence(name, mood),
        total: activity.total, progress: stageProgress(activity.total, stageIndex), image: catImageFile(stageIndex, mood),
    };
}

/** The committed PNG of a cat as a discord.js attachment (name: the file name). */
export function catAttachment(cat) {
    return new AttachmentBuilder(fileURLToPath(new URL(cat.image, IMG_DIR)), { name: cat.image });
}

const formatNumber = (n) => (Number(n) || 0).toLocaleString('en-US');

/** The /cat view embed (plain text, the image as attachment://<file>). */
export function catEmbed(cat) {
    const next = cat.progress.next
        ? `${catProgressLine(cat.progress.fraction)}\n${formatNumber(cat.progress.toNext)} more messages to ${cat.progress.next.name}.`
        : 'Fully grown. This is the last stage.';
    return new EmbedBuilder()
        .setTitle(cat.name)
        .setDescription(cat.sentence)
        .addFields(
            { name: 'Stage', value: cat.stage.name, inline: true },
            { name: 'Mood', value: cat.mood, inline: true },
            { name: 'Messages counted', value: formatNumber(cat.total), inline: true },
            { name: 'Next stage', value: next, inline: false },
        )
        .setImage(`attachment://${cat.image}`)
        .setFooter({ text: 'The cat grows with every message members send here.' })
        .setColor(0xf2b84b);
}

/** The growth announcement message. */
export function growthMessage(cat) {
    const embed = new EmbedBuilder()
        .setTitle(`${cat.name} grew into a ${cat.stage.name}`)
        .setDescription(`Thanks to everyone who chats here. ${cat.name} is now a ${cat.stage.name} after ${formatNumber(cat.total)} messages.`)
        .setImage(`attachment://${cat.image}`)
        .setColor(0xf2b84b);
    return { embeds: [embed], files: [catAttachment(cat)], allowedMentions: { parse: [] } };
}

/** The level-up channel if the bot can post there with an image, else null. */
function announceChannel(guild, channelId) {
    if (!channelId) return null;
    const channel = guild.channels?.cache?.get(channelId);
    if (!channel?.isTextBased?.()) return null;
    const me = guild.members?.me;
    const perms = me ? channel.permissionsFor?.(me) : null;
    if (!perms?.has?.([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles])) return null;
    return channel;
}

/**
 * One growth check for one server. Records the stage the first time (no announcement); when
 * it is higher than recorded, posts once in the level-up channel (announce on, channel set and
 * usable) and records it only after a successful post. With announce off or no usable channel
 * it just records the new stage. A failed post is retried on the next run. Returns what it did:
 * 'none' | 'init' | 'announced' | 'recorded' | 'failed'.
 */
export async function checkGuildCatGrowth(guild, { client, getLevelingConfig, getState = getCatState, setState = setCatState, now = Date.now(), ...deps } = {}) {
    const state = await getState(guild.id);
    const cat = await getServerCat(guild.id, { ...deps, getState: async () => state, now });
    const counted = stageIndexFor(cat.total);
    const action = growthAction(state, counted);
    if (action === 'none') return 'none';
    if (action === 'init') {
        await setState(guild.id, { stage: counted, grownAt: null });
        return 'init';
    }
    const grown = { stage: counted, grownAt: new Date(now).toISOString() };
    // The announcement shows the new stage, proud (unless a lockdown is on).
    const shown = { ...cat, stageIndex: counted, stage: CAT_STAGES[counted], mood: cat.mood === 'scared' ? 'scared' : 'proud' };
    shown.image = catImageFile(counted, shown.mood);
    let channel = null;
    if (cat.announce) {
        const leveling = await getLevelingConfig(client, guild.id);
        channel = announceChannel(guild, leveling?.levelUpChannel || null);
    }
    if (!channel) {
        await setState(guild.id, grown);
        return 'recorded';
    }
    try {
        await channel.send(growthMessage(shown));
    } catch (error) {
        logger.warn(`Server cat: growth announcement in ${guild.id} failed (retried next run): ${error.message}`);
        return 'failed';
    }
    await setState(guild.id, grown);
    return 'announced';
}

/** The cron job: every server the bot is in. One server's failure does not stop the others. */
export async function checkCatGrowth(client, deps = {}) {
    const getLevelingConfig = deps.getLevelingConfig || (await import('../leveling/leveling.js')).getLevelingConfig;
    for (const guild of client.guilds?.cache?.values?.() || []) {
        try {
            await checkGuildCatGrowth(guild, { client, getLevelingConfig, ...deps });
        } catch (error) {
            logger.warn(`Server cat: growth check for ${guild.id} failed: ${error.message}`);
        }
    }
}
