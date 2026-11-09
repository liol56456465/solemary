// joinWelcome.js — the message Mewvo posts when it is added to a server (multi-server B2).
//
// Discord does not say which channel an invite came from, so: the server's system channel when
// Mewvo can view it, send there and embed links; else the first text channel (by position) where
// it can. With View Audit Log, the member who added the bot (BotAdd entry for Mewvo, at most a
// minute old) also gets it as a DM; without it that step is skipped silently. When no channel
// took the post, the server owner gets it as a DM instead (unless the adder was the owner and
// already has it), so somebody always hears how to start.
// The post says what admins do first (/setup or the dashboard); the dashboard button says it is
// for admins (members cannot open it).
// A rejoin within 24 hours posts nothing (guild config key botWelcomeAt; data is kept after the
// bot leaves, owner decision). Every send error is logged in one line and never fails the join.

import { ActionRowBuilder, AuditLogEvent, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { textForGuild } from '../../utils/botText.js';
import { dashboardUrlFor } from '../site/shell.js';
import { supportInviteUrl } from '../../commands/Core/support.js';
import { getGuildConfig, updateGuildConfig } from '../config/guildConfig.js';
import { blacklistHit } from '../owner/blacklistCache.js';

export const WELCOME_REPOST_MS = 24 * 60 * 60 * 1000;
export const ADDER_MAX_AGE_MS = 60 * 1000;
export const WELCOME_STAMP_KEY = 'botWelcomeAt';
const POST_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
const NO_MENTIONS = Object.freeze({ parse: [] });

/** True when Mewvo can view, send and embed in this channel (all three: has() needs every bit). */
export function canPostWelcome(channel, me) {
    if (!channel || !me || typeof channel.permissionsFor !== 'function') return false;
    if (typeof channel.isTextBased === 'function' && !channel.isTextBased()) return false;
    try {
        return Boolean(channel.permissionsFor(me)?.has(POST_PERMISSIONS));
    } catch {
        return false;
    }
}

/** Sort key of a channel as Discord lists it: channels without a category first, then by category, then by position. */
function positionKey(channel) {
    const parent = channel.parent || null;
    return [parent ? 1 : 0, parent?.rawPosition ?? -1, channel.rawPosition ?? channel.position ?? 0];
}

function byPosition(a, b) {
    const ka = positionKey(a);
    const kb = positionKey(b);
    for (let i = 0; i < ka.length; i += 1) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return String(a.id).localeCompare(String(b.id));
}

/** The channel for the welcome post: the system channel, else the first text channel Mewvo can post in, else null. */
export function chooseWelcomeChannel(guild) {
    const me = guild?.members?.me || null;
    if (!me) return null;
    if (canPostWelcome(guild.systemChannel, me)) return guild.systemChannel;
    const text = [...(guild.channels?.cache?.values?.() || [])]
        .filter((c) => c.type === ChannelType.GuildText && canPostWelcome(c, me))
        .sort(byPosition);
    return text[0] || null;
}

/**
 * The welcome message in `tr`'s language. `dm`: the version for the member who added Mewvo;
 * `owner`: the DM to the server owner when Mewvo could not post in any channel.
 */
export function welcomeMessage(guild, tr, { dm = false, owner = false } = {}) {
    const server = guild.name || guild.id;
    const first = owner ? tr.t('setup.welcome.ownerDm', { server })
        : dm ? tr.t('setup.welcome.dm', { server }) : tr.t('setup.welcome.body');
    const lines = [first, '', tr.t('setup.welcome.optional'), '', tr.t('setup.welcome.help')];
    const embed = createEmbed({ title: tr.t('setup.welcome.title'), description: lines.join('\n'), color: 'primary' });
    const buttons = [];
    const dashboard = dashboardUrlFor(guild.id);
    if (dashboard) buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(tr.t('setup.welcome.dashboardButton')).setURL(dashboard));
    buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(tr.t('setup.welcome.supportButton')).setURL(supportInviteUrl()));
    return { embeds: [embed], components: [new ActionRowBuilder().addComponents(buttons)], allowedMentions: NO_MENTIONS };
}

/** True when a welcome was already posted less than 24 hours ago (stamp in the guild config). */
export function welcomedRecently(config, now = Date.now()) {
    const at = Date.parse(config?.[WELCOME_STAMP_KEY] || '');
    return Number.isFinite(at) && now - at >= 0 && now - at < WELCOME_REPOST_MS;
}

/** The user who added Mewvo (audit log BotAdd for Mewvo's id, at most a minute old), or null. Needs View Audit Log. */
export async function findAdder(guild, botId, now = Date.now()) {
    const me = guild?.members?.me;
    if (!botId || !me?.permissions?.has?.(PermissionFlagsBits.ViewAuditLog)) return null;
    const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.BotAdd, limit: 5 });
    const entry = [...(logs?.entries?.values?.() || [])].find((e) => String(e?.target?.id ?? e?.targetId ?? '') === String(botId)
        && now - Number(e.createdTimestamp) <= ADDER_MAX_AGE_MS);
    return entry?.executor && !entry.executor.bot ? entry.executor : null;
}

export const defaultWelcomeDeps = {
    getGuildConfig: (client, guildId) => getGuildConfig(client, guildId),
    // Row-locked merge (updateGuildConfigAtomic): creates the row of a new server, never overwrites other keys.
    stampWelcome: (client, guildId, at) => updateGuildConfig(client, guildId, { [WELCOME_STAMP_KEY]: at }),
    blacklistHit,
    textFor: (guildId) => textForGuild(guildId, { purpose: 'public' }),
    // The server owner as a member (one API call when not cached); null when unknown.
    fetchOwner: (guild) => (typeof guild?.fetchOwner === 'function' ? guild.fetchOwner() : null),
    log: logger,
};

/**
 * The whole join step: the welcome post and DM, unless one went out in the last 24 hours or the
 * server is blacklisted (ignored silently, like every command there). Stamps the guild config
 * (which also creates a new server's row). Never throws.
 * Returns { posted: channelId | null, dm: boolean, ownerDm: boolean, skipped: 'recent' | 'blacklisted' | null }
 * (+ adderId when the adder got the DM).
 */
export async function welcomeOnJoin(guild, client, { deps = defaultWelcomeDeps, now = Date.now() } = {}) {
    const d = { ...defaultWelcomeDeps, ...deps };
    const result = { posted: null, dm: false, ownerDm: false, skipped: null };
    if (d.blacklistHit({ guildId: guild.id })?.kind === 'guild') {
        result.skipped = 'blacklisted';
        return result;
    }
    let config = null;
    try {
        config = await d.getGuildConfig(client, guild.id);
    } catch (error) {
        // Unknown whether a welcome went out recently: post (a second welcome beats none).
        d.log.warn(`Join welcome: guild config of ${guild.id} could not be read (${error?.message || error}); posting anyway`);
    }
    if (config && welcomedRecently(config, now)) {
        result.skipped = 'recent';
        return result;
    }
    try {
        await d.stampWelcome(client, guild.id, new Date(now).toISOString());
    } catch (error) {
        d.log.warn(`Join welcome: the welcome time of ${guild.id} could not be saved: ${error?.message || error}`);
    }

    const tr = d.textFor(guild.id);
    const channel = chooseWelcomeChannel(guild);
    if (channel) {
        try {
            await channel.send(welcomeMessage(guild, tr));
            result.posted = channel.id;
        } catch (error) {
            d.log.warn(`Join welcome: could not post in ${channel.id} of ${guild.id}: ${error?.message || error}`);
        }
    } else {
        d.log.info(`Join welcome: no channel in ${guild.id} where Mewvo can view, send and embed; nothing posted`);
    }

    try {
        const adder = await findAdder(guild, client?.user?.id, now);
        // A blacklisted adder gets no DM (the server post still goes out).
        if (adder && !d.blacklistHit({ userId: adder.id })) {
            await adder.send(welcomeMessage(guild, tr, { dm: true }));
            result.dm = true;
            result.adderId = adder.id;
        }
    } catch (error) {
        d.log.warn(`Join welcome: no DM to the member who added Mewvo to ${guild.id}: ${error?.message || error}`);
    }

    // Nothing reached the server: tell its owner (one DM; not when the owner added Mewvo and got the DM above).
    if (!result.posted && !(result.dm && result.adderId && result.adderId === guild.ownerId)) {
        try {
            const owner = await d.fetchOwner(guild);
            if (owner?.send && !owner.user?.bot && !d.blacklistHit({ userId: owner.id })) {
                await owner.send(welcomeMessage(guild, tr, { owner: true }));
                result.ownerDm = true;
            }
        } catch (error) {
            d.log.warn(`Join welcome: no DM to the owner of ${guild.id} either: ${error?.message || error}`);
        }
    }
    return result;
}
