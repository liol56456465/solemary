// quarantineService.js — quarantine: a member keeps their place in the server but loses every
// role and can see no channel until staff release them.
//
// The quarantine role (dashboard Enforcement → Roles, setting quarantineRoleId) is managed like
// the Muted role (muteService.js applyRoleDenyOverwrite): it is denied View Channel in every
// channel, and in new channels on channelCreate. A quarantined member's removable roles are saved
// in the key-value store (quarantine:<guild>:<user>: { roleId, roles, reason, at, by, automated,
// trigger, alert }) and replaced by that role in one role change; managed roles (boosts,
// integrations) cannot be removed and stay. The record outlives a leave: rejoining re-applies it.
//
// Triggers: a raid joiner who breaks an automod rule during a lockdown (automodService.actOn,
// instead of the kick), the staff guard's anti-nuke (staffGuardService.demote, instead of
// stripping staff roles), and staff by hand (dashboard member page). Not set: those keep their
// old behaviour (kick / strip).
//
// Each quarantine DMs the member (server, reason, the server's support invite: appealInvite, the
// same resolution as punishment DMs), posts an alert in the staff alerts channel that pings the
// configured head admin roles (quarantinePingRoleIds; allowedMentions exactly those) with a
// Release button (qrelease:<guildId>:<userId>, handlers/quarantineRelease.js), and records the
// quarantine and the release in the mod log (subject: the member, for the Advanced forum).
//
// Info channel (quarantineInfoChannelId, optional): the one channel a quarantined member still
// sees, read-only: the quarantine role is allowed View Channel + Read Message History there and
// denied posting, reacting and threads; every other channel denies View Channel. A changed setting
// is fixed the next time the overwrites run (each quarantine, rejoin, or posting the info
// message): the old channel then gets the plain deny, the new one the read-only allow. The info
// message (postQuarantineInfo, dashboard button) is an embed in the server's language; re-posting
// replaces the old one (key-value store quarantineInfo:posted:<guild>), and "Refresh posted
// messages" edits it in place (refreshQuarantineInfo).
//
// Mass actions (massActionGuard.js): a quarantine is no case, so the case-based counts never see
// it. A moderator blocked by the guard cannot quarantine by hand (the caller checks the block);
// releasing is an undo and always works. Automatic quarantines are the bot's own.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits, escapeMarkdown } from 'discord.js';
import { db, getFromDb, setInDb, deleteFromDb } from '../../utils/database.js';
import { logger } from '../../utils/logger.js';
import { botText, textForGuild } from '../../utils/botText.js';
import { resolveSetting } from '../settings/guildSettings.js';
import { isEnforcementDbAvailable } from './db.js';
import { applyRoleDenyOverwrite } from './muteService.js';
import { appealInvite, safeServerName } from './dmTemplates.js';
import { createEmbed } from '../../utils/embeds.js';
import { dateStamp, truncate } from './format.js';
import { postModLog } from './enforcementService.js';
import { postAlert } from '../automod/alertPost.js';
import { staffGuildId } from '../automod/channelRouting.js';
import { sendLoggedDm } from '../botDm/dmLog.js';
import { hasOwnerPower, isMewvoServer } from '../../utils/ownerPower.js';
import { CUSTOM_REASON_KEY } from '../../config/enforcement.js';
import { startFlow } from './flowBuilder.js';
import { executeAction } from './enforcementService.js';
import { Mutex } from '../../utils/mutex.js';
import { enforceMassActionGuard, noteManualQuarantine } from './massActionGuard.js';

export const QUARANTINE_DENY_NAMES = Object.freeze(['ViewChannel']);
// The info channel: readable, never writable.
export const INFO_ALLOW_NAMES = Object.freeze(['ViewChannel', 'ReadMessageHistory']);
export const INFO_DENY_NAMES = Object.freeze(['SendMessages', 'SendMessagesInThreads', 'AddReactions', 'CreatePublicThreads', 'CreatePrivateThreads']);
export const infoPostKey = (guildId) => `quarantineInfo:posted:${guildId}`;
export const QUARANTINE_TRIGGERS = Object.freeze(['raid', 'staffGuard', 'automod', 'manual']);
// The alert's decision buttons: qdecide:<release|kick|ban|keep>:<guildId>:<userId> (kick asks to
// confirm with qdecide:kickok, ban opens the qban reason form). qrelease: the first alerts' Release.
export const DECIDE_BUTTON = 'qdecide';
export const RELEASE_BUTTON = 'qrelease';
export const BAN_MODAL = 'qban';
export const DECISIONS = Object.freeze(['release', 'kick', 'ban', 'keep']);
export const MAX_PING_ROLES = 5;
const REASON_MAX = 500;
const OVERWRITE_REASON = 'Quarantine role: no channel access';

export const quarantineKey = (guildId, userId) => `quarantine:${guildId}:${userId}`;

// Side effects, replaceable in tests (setQuarantineDepsForTest).
const defaultDeps = {
    getFromDb: (...args) => getFromDb(...args),
    setInDb: (...args) => setInDb(...args),
    deleteFromDb: (...args) => deleteFromDb(...args),
    listKeys: (prefix) => db.list(prefix),
    dbAvailable: () => isEnforcementDbAvailable(),
    resolveSetting: (...args) => resolveSetting(...args),
    appealInvite: (...args) => appealInvite(...args),
    sendDm: (...args) => sendLoggedDm(...args),
    postAlert: (...args) => postAlert(...args),
    postModLog: (...args) => postModLog(...args),
    executeAction: (...args) => executeAction(...args),
    enforceMassActionGuard: (...args) => enforceMassActionGuard(...args),
    noteManualQuarantine: (...args) => noteManualQuarantine(...args),
    hasOwnerPower: (...args) => hasOwnerPower(...args),
};
let deps = { ...defaultDeps };

/** Test hook: replace some side effects (no argument restores all). */
export function setQuarantineDepsForTest(overrides = null) {
    deps = overrides ? { ...defaultDeps, ...overrides } : { ...defaultDeps };
}

const highest = (member) => member?.roles?.highest?.position ?? 0;
const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/**
 * The quarantine role of this server (its own setting; resolveSetting never lends the main
 * server's role to another server), or null: not set, gone, or the settings could not be read.
 */
export function quarantineRoleOf(guild) {
    let roleId;
    try {
        roleId = deps.resolveSetting(guild.id, 'quarantineRoleId');
    } catch {
        return null;
    }
    return roleId ? guild.roles?.cache?.get(roleId) || null : null;
}

/** Why Mewvo cannot give `role` in `guild` (a refusal code), or null. */
export function quarantineRoleProblem(guild, role) {
    if (!role) return 'noRole';
    const me = guild.members?.me;
    if (!me?.permissions?.has?.(PermissionFlagsBits.ManageRoles)) return 'botNoManageRoles';
    if (role.managed) return 'roleManaged';
    if ((role.position ?? 0) >= highest(me)) return 'roleAboveBot';
    // Its own permissions would go to every quarantined member (an Administrator role: raid joiners as admins).
    const bits = role.permissions?.bitfield;
    if (bits !== undefined && BigInt(bits) !== 0n) return 'roleHasPermissions';
    return null;
}

/** The quarantine info channel id of this server, or null (not set / settings unreadable). */
export function infoChannelIdOf(guild) {
    try {
        return deps.resolveSetting(guild.id, 'quarantineInfoChannelId') || null;
    } catch {
        return null;
    }
}

/** The info channel's read-only overwrite for the quarantine role, unless it has it. Returns true when written. */
export async function applyInfoOverwrite(channel, role) {
    if (!channel?.permissionOverwrites) return false;
    const overwrite = channel.permissionOverwrites.cache?.get(role.id);
    const has = overwrite
        && INFO_ALLOW_NAMES.every((name) => overwrite.allow?.has?.(PermissionFlagsBits[name]))
        && INFO_DENY_NAMES.every((name) => overwrite.deny?.has?.(PermissionFlagsBits[name]));
    if (has) return false;
    const values = {
        ...Object.fromEntries(INFO_ALLOW_NAMES.map((name) => [name, true])),
        ...Object.fromEntries(INFO_DENY_NAMES.map((name) => [name, false])),
    };
    await channel.permissionOverwrites.edit(role, values, { reason: 'Quarantine role: read-only info channel' });
    return true;
}

/** One channel's quarantine overwrite: read-only in the info channel, View Channel denied everywhere else. */
function applyChannelOverwrite(channel, role, infoId) {
    return channel.id === infoId
        ? applyInfoOverwrite(channel, role)
        : applyRoleDenyOverwrite(channel, role, QUARANTINE_DENY_NAMES, OVERWRITE_REASON);
}

/** True when a quarantine can run here (role set and assignable): the raid and staff guard triggers use it. */
export function quarantineReady(guild) {
    return Boolean(guild && quarantineRoleProblem(guild, quarantineRoleOf(guild)) === null);
}

/**
 * Why `member` may not be quarantined (a refusal code), or null: the owner, Mewvo, bots, at/above
 * Mewvo. A manual quarantine passes `actorMember` (the moderator): never themselves, never someone
 * whose highest role is at or above theirs, unless they are the live server owner or OWNER_IDS
 * with owner power here (`actorIsOwner`), like every other moderation action.
 */
export function targetRefusal(guild, member, { actorMember = null, actorIsOwner = false } = {}) {
    if (!member) return 'notInServer';
    const id = member.id || member.user?.id;
    if (id === guild.ownerId) return 'owner';
    const me = guild.members?.me;
    if (id === me?.id || id === guild.client?.user?.id) return 'self';
    if (member.user?.bot) return 'bot';
    if (highest(member) >= highest(me)) return 'aboveBot';
    if (actorMember && !actorIsOwner) {
        if (id === actorMember.id) return 'yourself';
        if (highest(member) >= highest(actorMember)) return 'aboveActor';
    }
    return null;
}

/** True when `userId` is the live server owner or OWNER_IDS with owner power in `guild`. */
export function isOwnerHere(guild, userId) {
    return Boolean(userId && (guild?.ownerId === userId || deps.hasOwnerPower(userId, guild?.id)));
}

/** The text for a refusal code, in `tr`'s language. */
export function refusalText(code, tr = botText('en'), { name = '' } = {}) {
    const key = `enforcement.quarantine.refuse.${code}`;
    return tr.has(key) ? tr.t(key, { name }) : tr.t('enforcement.quarantine.refuse.failed');
}

/** A Release answer ('done', 'left', a releaseRefusal code …) in `tr`'s language. */
export function releaseText(code, tr = botText('en'), params = {}) {
    return tr.t(`enforcement.quarantine.release.${code}`, params);
}

/** A decision text (enforcement.quarantine.decide.<key>) in `tr`'s language. */
export function decideText(key, tr = botText('en'), params = {}) {
    return tr.t(`enforcement.quarantine.decide.${key}`, params);
}

/** The member's roles the quarantine takes (not @everyone, not managed, not the quarantine role) and the managed ones that stay. */
export function splitRoles(member, quarantineRoleId) {
    const guildId = member.guild?.id;
    const take = [];
    const keep = [];
    for (const role of member.roles?.cache?.values?.() || []) {
        if (role.id === guildId || role.id === quarantineRoleId) continue;
        (role.managed ? keep : take).push(role);
    }
    return { take, keep };
}

/** Saved quarantine record of a member, or null. Throws on a database error. */
export async function getQuarantine(guildId, userId) {
    return deps.getFromDb(quarantineKey(guildId, userId), null);
}

/** Every quarantine record of a server: [{ userId, ...record }], newest first. Throws on a database error. */
export async function listQuarantines(guildId) {
    const prefix = quarantineKey(guildId, '');
    const keys = await deps.listKeys(prefix);
    const out = [];
    for (const key of keys || []) {
        const userId = String(key).slice(prefix.length);
        if (!/^\d{17,20}$/.test(userId)) continue;
        const record = await getQuarantine(guildId, userId);
        if (record) out.push({ userId, ...record });
    }
    return out.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
}

/**
 * Adds the quarantine deny overwrite to every channel of the server that is missing it (channel
 * cache; channels that already have it cost nothing). Returns { updated, failed }.
 */
export async function ensureQuarantineOverwrites(guild, role) {
    let updated = 0;
    let failed = 0;
    const infoId = infoChannelIdOf(guild);
    for (const channel of guild.channels?.cache?.values?.() || []) {
        if (!channel) continue;
        try {
            if (await applyChannelOverwrite(channel, role, infoId)) updated += 1;
        } catch (error) {
            failed += 1;
            logger.warn(`Could not set the quarantine overwrite on channel ${channel.id}: ${error.message}`);
        }
    }
    if (updated) logger.info(`Applied quarantine overwrites to ${updated} channel(s) in guild ${guild.id}`);
    return { updated, failed };
}

/** A new channel gets the quarantine deny (channelCreate). Never throws. */
export async function applyQuarantineOverwriteToChannel(channel) {
    try {
        const role = channel?.guild ? quarantineRoleOf(channel.guild) : null;
        // Never denied in the info channel (it gets its read-only allow instead).
        if (role) await applyChannelOverwrite(channel, role, infoChannelIdOf(channel.guild));
    } catch (error) {
        logger.warn(`Could not apply the quarantine overwrite to new channel ${channel?.id}: ${error.message}`);
    }
}

/**
 * The alert's decision buttons (Release, Kick, Ban, Keep in quarantine), all disabled once decided.
 * Only deciders (isQuarantineDecider) may use them; everyone sees them.
 */
export function decisionRow(guildId, userId, { lang = 'en', disabled = false } = {}) {
    const tr = botText(lang);
    const button = (decision, style) => new ButtonBuilder().setCustomId(`${DECIDE_BUTTON}:${decision}:${guildId}:${userId}`)
        .setLabel(tr.t(`enforcement.quarantine.decide.button.${decision}`)).setStyle(style).setDisabled(Boolean(disabled));
    return new ActionRowBuilder().addComponents(
        button('release', ButtonStyle.Success), button('kick', ButtonStyle.Secondary), button('ban', ButtonStyle.Danger), button('keep', ButtonStyle.Secondary),
    );
}

/** Kept for callers of the first version: the decision row. */
export const releaseRow = decisionRow;

/** True for a component row that holds the quarantine decision buttons (or the first Release button). */
export function isDecisionRow(row) {
    return Boolean(row?.components?.some?.((c) => {
        const id = String(c.customId || c.custom_id || '');
        return id.startsWith(`${DECIDE_BUTTON}:`) || id.startsWith(`${RELEASE_BUTTON}:`);
    }));
}

/** The decider roles for a quarantine in `sourceGuildId`: the staff server's setting (where the alert is). */
export function deciderRoleIdsFor(sourceGuildId) {
    try {
        return deps.resolveSetting(staffGuildId(sourceGuildId), 'quarantineDeciderRoleIds') || [];
    } catch {
        return [];
    }
}

/**
 * Who may decide on a quarantine in `guild` (owner, 2026-11-13: only the owner or co-owner):
 * 'owner' (the server owner, live guild.ownerId, or OWNER_IDS with owner power here), 'role'
 * (`staffMember`, the clicker in the staff server, holds a decider role), or null. Ordinary
 * Administrators are not deciders. Pure apart from the settings read.
 */
export function isQuarantineDecider({ guild, userId, staffMember = null }) {
    if (!guild || !userId) return null;
    if (guild.ownerId === userId) return 'owner';
    if (deps.hasOwnerPower(userId, guild.id)) return 'owner';
    const ids = deciderRoleIdsFor(guild.id);
    return ids.some((id) => staffMember?.roles?.cache?.has?.(id)) ? 'role' : null;
}

/** What triggered a quarantine, in `tr`'s language. */
export function triggerText(record, tr) {
    if (record.trigger === 'raid') return tr.t('enforcement.quarantine.trigger.raid');
    if (record.trigger === 'staffGuard') return tr.t('enforcement.quarantine.trigger.staffGuard');
    if (record.trigger === 'automod') return tr.t('enforcement.quarantine.trigger.automod');
    return tr.t('enforcement.quarantine.trigger.manual', { name: record.by?.username || '?' });
}

const memberLine = (userId, username) => `<@${userId}> ${username} (\`${userId}\`)`;
const roleNames = (roles, tr) => truncate(roles.map((role) => role.name).join(', ') || tr.t('enforcement.quarantine.alert.none'), 1024);

/**
 * The alert's { content, title, fields } in one language (pure, for tests). `pingRoleIds` become
 * the role mentions at the top; `reasonText` the shown reason (the stored one by default).
 */
export function quarantineAlertContent({ member, record, removed = [], kept = [], dmDelivered = null, reasonText = null, pingRoleIds = [], overwriteFailures = 0 }, { lang = 'en' } = {}) {
    const tr = botText(lang);
    const username = member.user?.username || member.username || member.id;
    const pings = pingRoleIds.map((id) => `<@&${id}>`).join(' ');
    const fields = [
        { name: tr.t('enforcement.quarantine.alert.member'), value: memberLine(member.id, username) },
        { name: tr.t('enforcement.quarantine.alert.reason'), value: truncate(reasonText || record.reason || '-', 1024) },
        { name: tr.t('enforcement.quarantine.alert.trigger'), value: truncate(triggerText(record, tr), 1024) },
        { name: tr.t('enforcement.quarantine.alert.rolesRemoved'), value: roleNames(removed, tr) },
        ...(kept.length ? [{ name: tr.t('enforcement.quarantine.alert.rolesKept'), value: roleNames(kept, tr) }] : []),
        { name: tr.t('enforcement.quarantine.alert.dm'), value: dmDelivered ? tr.t('enforcement.quarantine.alert.dmDelivered') : tr.t('enforcement.quarantine.alert.dmFailed') },
        // Channels Mewvo could not lock (no Manage Permissions there): they may still see those.
        ...(overwriteFailures ? [{ name: tr.t('enforcement.quarantine.alert.channelsOpen'), value: tr.t('enforcement.quarantine.alert.channelsOpenValue', { count: String(overwriteFailures) }) }] : []),
    ];
    return {
        content: `${pings ? `${pings} ` : ''}${tr.t('enforcement.quarantine.alert.ping', { name: username })}`,
        title: tr.t('enforcement.quarantine.alert.title'),
        fields,
    };
}

/** The ping roles for the alert: the staff server's setting, only roles that exist there, at most MAX_PING_ROLES. */
function pingRolesFor(client, sourceGuildId) {
    const staffId = staffGuildId(sourceGuildId);
    let ids;
    try {
        ids = deps.resolveSetting(staffId, 'quarantinePingRoleIds') || [];
    } catch {
        return [];
    }
    const staffGuild = client?.guilds?.cache?.get(staffId);
    return ids.filter((id) => staffGuild?.roles?.cache?.has?.(id)).slice(0, MAX_PING_ROLES);
}

/** The member's quarantine DM (logged, re-renderable). Returns true when delivered; never throws. */
async function sendQuarantineDm(member, reason) {
    const guild = member.guild;
    let invite = null;
    try {
        invite = deps.appealInvite(guild.id) || null;
    } catch {
        invite = null;
    }
    return deps.sendDm(member.user, {
        key: 'enf.quarantine',
        params: { guildId: guild.id, serverName: safeServerName(guild.name), reason, invite },
        guildId: guild.id,
        member,
        label: 'quarantine',
    }).then(Boolean, (error) => {
        logger.info(`Quarantine DM to ${member.id} failed: ${error?.message || error}`);
        return false;
    });
}

/**
 * Quarantines `member`: saves their removable roles, replaces them with the quarantine role,
 * DMs them, alerts staff (head roles pinged, Release button) and writes the mod log.
 * options: by { id, username } (the moderator; null for automatic), automated, trigger
 * ('raid' | 'staffGuard' | 'manual'), extraComponents (more alert rows, e.g. the nuke buttons),
 * reasonText(tr) (the shown reason in a language; the stored reason stays English/as written).
 * Returns { ok: true, removed, kept, dmDelivered, alertPosted } or { ok: false, code } (nothing
 * changed). A database error on the record write throws (nothing changed).
 */
export async function quarantineMember(member, reason, options = {}) {
    // A manual quarantine: one at a time per moderator, so parallel requests cannot all pass the
    // mass-action guard on the same count.
    const actor = options.actorMember;
    if (actor && member?.guild) return Mutex.runExclusive(`massguard:q:${member.guild.id}:${actor.id}`, () => quarantineUnlocked(member, reason, options));
    return quarantineUnlocked(member, reason, options);
}

async function quarantineUnlocked(member, reason, { by = null, automated = false, trigger = 'manual', extraComponents = [], reasonText = null, actorMember = null, lang = 'en' } = {}) {
    const guild = member?.guild;
    if (!guild) return { ok: false, code: 'notInServer' };
    if (!deps.dbAvailable()) return { ok: false, code: 'database' };
    const role = quarantineRoleOf(guild);
    const roleProblem = quarantineRoleProblem(guild, role);
    if (roleProblem) return { ok: false, code: roleProblem };
    // A manual quarantine (`actorMember`): the moderator's hierarchy and the mass-action guard apply.
    const actorIsOwner = Boolean(actorMember && isOwnerHere(guild, actorMember.id));
    const refusal = targetRefusal(guild, member, { actorMember, actorIsOwner });
    if (refusal) return { ok: false, code: refusal };

    const key = quarantineKey(guild.id, member.id);
    if (await deps.getFromDb(key, null)) {
        // Already quarantined (e.g. a second raid hit): make sure the role is on, change nothing else.
        if (!member.roles.cache.has(role.id)) await member.roles.add(role, 'Quarantine (already recorded)').catch(() => {});
        return { ok: false, code: 'already' };
    }

    // Counted like a kick (throws the guard's refusal when blocked or over the limit; OWNER_IDS at home
    // exempt), and recorded before it is applied: a failed write stops it (fail closed).
    let warning = null;
    if (actorMember) {
        warning = (await deps.enforceMassActionGuard(guild, actorMember, 'quarantine', { lang }))?.warning ?? null;
        await deps.noteManualQuarantine(guild.id, actorMember.id);
    }

    const cleanReason = oneLine(reason).slice(0, REASON_MAX) || 'No reason given';
    const { take, keep } = splitRoles(member, role.id);
    const record = {
        roleId: role.id,
        roles: take.map((r) => r.id),
        reason: cleanReason,
        at: new Date().toISOString(),
        by: by ? { id: String(by.id), username: String(by.username || '').slice(0, 100) } : null,
        automated: Boolean(automated),
        trigger: QUARANTINE_TRIGGERS.includes(trigger) ? trigger : 'manual',
        alert: null,
    };
    // The record first: the roles are never taken without being saved.
    await deps.setInDb(key, record);
    const auditReason = truncate(`Quarantine${by ? ` by ${by.username}` : ''}: ${cleanReason}`, 512);
    try {
        await member.roles.set([...keep.map((r) => r.id), role.id], auditReason);
    } catch (error) {
        await deps.deleteFromDb(key).catch((e) => logger.error(`Quarantine record of ${member.id} not removed after a failed role change: ${e.message}`));
        logger.warn(`Quarantine of ${member.id} in ${guild.id} failed: ${error.message}`);
        return { ok: false, code: 'assignFailed', error };
    }
    logger.warn(`Quarantined ${member.id} in ${guild.id} (${record.trigger}): ${cleanReason}`);

    const overwrites = await ensureQuarantineOverwrites(guild, role).catch((error) => {
        logger.warn(`Quarantine overwrites in ${guild.id}: ${error.message}`);
        return { updated: 0, failed: 0 };
    });
    if (member.voice?.channelId) {
        await member.voice.disconnect('Quarantined').catch((error) => logger.warn(`Could not disconnect quarantined ${member.id} from voice: ${error.message}`));
    }

    const dmDelivered = await sendQuarantineDm(member, cleanReason);

    // The alert, in the staff server's language, pinging the head admin roles only.
    const post = textForGuild(staffGuildId(guild.id), { purpose: 'public' });
    const pingRoleIds = pingRolesFor(guild.client, guild.id);
    const alert = quarantineAlertContent({
        member, record, removed: take, kept: keep, dmDelivered, pingRoleIds, reasonText: reasonText ? reasonText(post) : null,
        overwriteFailures: overwrites.failed,
    }, { lang: post.lang });
    const message = await deps.postAlert(guild.client, 'staff', {
        guildId: guild.id, title: alert.title, fields: alert.fields, color: 'warning',
        content: alert.content, mentionRoleIds: pingRoleIds,
        components: [...extraComponents, decisionRow(guild.id, member.id, { lang: post.lang })].slice(0, 5),
    }).catch((error) => {
        logger.warn(`Quarantine alert for ${member.id} failed: ${error.message}`);
        return null;
    });
    if (message?.id && message.channelId) {
        record.alert = { channelId: message.channelId, messageId: message.id };
        try {
            if (await deps.getFromDb(key, null)) await deps.setInDb(key, record);
        } catch (error) {
            logger.warn(`Quarantine alert of ${member.id} not stored: ${error.message}`);
        }
    }

    await deps.postModLog(guild.client, 'quarantine', alert.fields, {
        guildId: guild.id, title: alert.title, subject: { id: member.id, username: member.user?.username || member.id }, automated: Boolean(automated),
    }).catch((error) => logger.warn(`Quarantine mod log for ${member.id} failed: ${error.message}`));

    return { ok: true, removed: take, kept: keep, dmDelivered, alertPosted: Boolean(message), record, warning };
}

/**
 * Why a decider may not release `record` (a refusal code), or null. Pure. The caller has checked
 * isQuarantineDecider. `isOwner`: the server owner or OWNER_IDS with owner power here (they pass
 * everything). A decider by role: never themselves, never saved roles at or above their own
 * highest role (the bot would hand out roles they could not give by hand).
 */
export function releaseRefusal({ guild, record, targetId, actorId, actorMember = null, isOwner = false, home = isMewvoServer(guild?.id) }) {
    if (!record) return 'none';
    if (isOwner) return null;
    if (actorId === targetId) return 'notYourself';
    // A staff guard quarantine in Mewvo's own servers: the owner only, like /staff restore (a rogue
    // co-owner must not hand the offender their admin roles back).
    if (record.trigger === 'staffGuard' && home) return 'ownerOnly';
    const top = highest(actorMember);
    const tooHigh = (record.roles || []).map((id) => guild.roles?.cache?.get(id)).filter((role) => role && (role.position ?? 0) >= top);
    if (tooHigh.length) return 'tooHigh';
    return null;
}

/** The saved roles that cannot be given back (above the actor), for the tooHigh text. */
export function tooHighRoles(guild, record, actorMember) {
    const top = highest(actorMember);
    return (record?.roles || []).map((id) => guild.roles?.cache?.get(id)).filter((role) => role && (role.position ?? 0) >= top);
}

/**
 * Edits the quarantine alert (when its message is known) to show who released the member and
 * disables its Release button. `message`: the alert itself (the button click), else the stored
 * one is fetched. Never throws.
 */
export async function markAlertReleased(client, guildId, userId, record, byName, { message = null, decision = 'release', disable = true } = {}) {
    try {
        let target = message;
        if (!target && record?.alert?.channelId) {
            const staffGuild = client?.guilds?.cache?.get(staffGuildId(guildId));
            const channel = staffGuild?.channels?.cache?.get(record.alert.channelId) || await staffGuild?.channels?.fetch?.(record.alert.channelId).catch(() => null);
            target = channel?.isTextBased?.() ? await channel.messages.fetch(record.alert.messageId).catch(() => null) : null;
        }
        if (!target) return false;
        const post = textForGuild(staffGuildId(guildId), { purpose: 'public' });
        const embed = target.embeds?.[0] ? EmbedBuilder.from(target.embeds[0]) : new EmbedBuilder().setTitle(post.t('enforcement.quarantine.alert.title'));
        const fieldName = post.t('enforcement.quarantine.decide.field');
        // One decision line: a later Keep (or the final decision) replaces the earlier one.
        const kept = (embed.data.fields || []).filter((f) => f.name !== fieldName);
        embed.setFields(kept.slice(0, 24));
        embed.addFields({
            name: fieldName,
            value: truncate(post.t('enforcement.quarantine.decide.value', { decision: post.t(`enforcement.quarantine.decide.done.${decision}`), name: byName, date: dateStamp(new Date()) }), 1024),
        });
        if (disable) embed.setColor(decision === 'release' ? 0x2ecc71 : 0xe74c3c);
        // The other rows (nuke buttons) stay; only the decision buttons are disabled (Keep leaves them on).
        const rows = (target.components || []).map((row) => (isDecisionRow(row) ? decisionRow(guildId, userId, { lang: post.lang, disabled: disable }) : row));
        await target.edit({ embeds: [embed], components: rows, allowedMentions: { parse: [] } });
        return true;
    } catch (error) {
        logger.warn(`Quarantine alert for ${userId} not updated: ${error.message}`);
        return false;
    }
}

/**
 * Releases `userId`: gives back the saved roles that still exist and are below Mewvo (managed
 * ones are skipped), removes the quarantine role, deletes the record, updates the alert and
 * writes the mod log. `by`: { id, username }; `ownerOverride` notes an OWNER_IDS release without
 * Administrator. Returns { ok: true, restored, skipped, left, record } or { ok: false, code }.
 * A Discord refusal of the role change throws (the record stays, so it can be tried again).
 */
export async function releaseQuarantine(guild, userId, options = {}) {
    return Mutex.runExclusive(`quarantine:${guild.id}:${userId}`, () => releaseUnlocked(guild, userId, options));
}

async function releaseUnlocked(guild, userId, { by, ownerOverride = false, message = null } = {}) {
    const key = quarantineKey(guild.id, userId);
    const record = await deps.getFromDb(key, null);
    if (!record) return { ok: false, code: 'none' };
    const member = await guild.members.fetch(userId).catch((error) => {
        if (error?.code === 10007 || error?.code === 10013) return null; // Unknown Member / Unknown User
        throw error; // a Discord hiccup must never be read as "left" (the saved roles would be lost)
    });
    const byName = `${by?.username || '?'}${ownerOverride ? ' (owner override)' : ''}`;
    if (!member) {
        // Left the server: nothing to give back; the record goes, so a rejoin is not quarantined again.
        await deps.deleteFromDb(key);
        await markAlertReleased(guild.client, guild.id, userId, record, byName, { message });
        await logRelease(guild, userId, userId, { record, restored: [], skipped: record.roles || [], byName, left: true });
        return { ok: true, restored: [], skipped: record.roles || [], left: true, record };
    }
    const top = highest(guild.members?.me);
    const restored = [];
    const skipped = [];
    for (const id of record.roles || []) {
        const role = guild.roles.cache.get(id);
        if (role && !role.managed && role.id !== guild.id && (role.position ?? 0) < top) restored.push(role);
        else skipped.push(id);
    }
    const quarantineRoleIds = [record.roleId, quarantineRoleOf(guild)?.id].filter((id) => id && member.roles.cache.has(id));
    const auditReason = truncate(`Quarantine lifted by ${byName}`, 512);
    const toAdd = restored.filter((role) => !member.roles.cache.has(role.id));
    if (toAdd.length) await member.roles.add(toAdd, auditReason);
    try {
        if (quarantineRoleIds.length) await member.roles.remove([...new Set(quarantineRoleIds)], auditReason);
        await deps.deleteFromDb(key);
    } catch (error) {
        // The roles are back, but the quarantine role or the record is not gone: say so (run Release again).
        throw Object.assign(error, { partial: true });
    }
    logger.info(`Quarantine of ${userId} in ${guild.id} lifted by ${byName}`);
    await markAlertReleased(guild.client, guild.id, userId, record, byName, { message });
    await logRelease(guild, userId, member.user?.username || userId, { record, restored, skipped, byName, left: false });
    return { ok: true, restored, skipped, left: false, record };
}

async function logRelease(guild, userId, username, { record, restored, skipped, byName, left }) {
    const tr = textForGuild(staffGuildId(guild.id), { purpose: 'public' });
    await deps.postModLog(guild.client, 'unquarantine', [
        { name: tr.t('enforcement.quarantine.alert.member'), value: memberLine(userId, username) },
        { name: tr.t('enforcement.quarantine.log.releasedBy'), value: truncate(byName, 1024) },
        { name: tr.t('enforcement.quarantine.log.rolesBack'), value: left ? tr.t('enforcement.quarantine.log.left') : roleNames(restored, tr) },
        ...(skipped.length && !left ? [{ name: tr.t('enforcement.quarantine.log.skipped'), value: String(skipped.length) }] : []),
        { name: tr.t('enforcement.quarantine.alert.reason'), value: truncate(record.reason || '-', 1024) },
    ], { guildId: guild.id, title: tr.t('enforcement.quarantine.log.releasedTitle'), subject: { id: userId, username } })
        .catch((error) => logger.warn(`Quarantine release mod log for ${userId} failed: ${error.message}`));
}

/**
 * Rejoin (guildMemberAdd): a member with a quarantine record gets the quarantine role back at
 * once. Returns true when a record exists (the join pipeline then gives no other roles back).
 * Throws on a database error (the caller logs it).
 */
export async function reapplyQuarantineOnJoin(member) {
    const record = await getQuarantine(member.guild.id, member.id);
    if (!record) return false;
    const role = member.guild.roles.cache.get(record.roleId) || quarantineRoleOf(member.guild);
    if (!role) {
        logger.warn(`Quarantined ${member.id} rejoined ${member.guild.id}, but the quarantine role is gone`);
        return true;
    }
    await member.roles.add(role, 'Rejoined while quarantined').catch((error) => {
        logger.warn(`Could not re-apply the quarantine role to ${member.id}: ${error.message}`);
    });
    await ensureQuarantineOverwrites(member.guild, role).catch(() => {});
    return true;
}

/**
 * The join pipeline's quarantine check, failing closed (security review 2026-11-13): 'quarantined'
 * (a record exists: the role is back), 'clear' (read fine, no record), or 'unknown' (database
 * down or the read failed). On 'unknown' the caller gives no role at all, so leaving and
 * rejoining during a database blip never shakes off a quarantine; where the server has a
 * quarantine role, staff get a short alert to look at the member. Never throws.
 */
export async function checkQuarantineOnJoin(member) {
    if (!deps.dbAvailable()) {
        void noteUnknownJoin(member, 'database not available').catch(() => {});
        return 'unknown';
    }
    try {
        return (await reapplyQuarantineOnJoin(member)) ? 'quarantined' : 'clear';
    } catch (error) {
        void noteUnknownJoin(member, error.message).catch(() => {});
        return 'unknown';
    }
}

const unknownJoinAlerts = new Map(); // guildId → last alert at (one per minute per server)

async function noteUnknownJoin(member, why) {
    logger.warn(`Could not check quarantine state for ${member.id} in ${member.guild.id} (${why}): no join roles given`);
    // Only where quarantine is in use (a role set): elsewhere a database blip is not a quarantine question.
    if (!quarantineRoleOf(member.guild)) return;
    const now = Date.now();
    if (now - (unknownJoinAlerts.get(member.guild.id) || 0) < 60_000) return;
    unknownJoinAlerts.set(member.guild.id, now);
    if (unknownJoinAlerts.size > 1000) unknownJoinAlerts.delete(unknownJoinAlerts.keys().next().value);
    const post = textForGuild(staffGuildId(member.guild.id), { purpose: 'public' });
    await deps.postAlert(member.guild.client, 'staff', {
        guildId: member.guild.id, color: 'warning',
        title: post.t('enforcement.quarantine.joinUnknown.title'),
        description: post.t('enforcement.quarantine.joinUnknown.text', { member: memberLine(member.id, member.user?.username || member.id) }),
    }).catch((error) => logger.warn(`Quarantine join alert for ${member.id} failed: ${error.message}`));
}

/**
 * Dashboard warnings for a chosen quarantine role (pure): it has permissions of its own (it
 * should have none), or it is not below Mewvo's highest role (Mewvo cannot give it).
 * Returns { hasPermissions, aboveBot }.
 */
export function quarantineRoleWarnings(guild, roleId) {
    const role = roleId ? guild?.roles?.cache?.get(roleId) : null;
    if (!role) return { hasPermissions: false, aboveBot: false };
    const bits = role.permissions?.bitfield ?? 0n;
    return {
        hasPermissions: BigInt(bits) !== 0n,
        aboveBot: (role.position ?? 0) >= highest(guild.members?.me),
    };
}

// ── The info message in the info channel ─────────────────────────────────

/** The info message (pure): an embed in `lang`. `invite` null drops the support sentence. */
export function quarantineInfoPayload({ serverName = '', invite = null }, { lang = 'en' } = {}) {
    const tr = botText(lang);
    const server = escapeMarkdown(String(serverName || '').replace(/\s+/g, ' ').trim().slice(0, 100)) || tr.t('enforcement.dm.thisServer');
    const lines = [
        tr.t('enforcement.quarantine.info.intro', { server }),
        '',
        `**${tr.t('enforcement.quarantine.info.whyTitle')}**`,
        tr.t('enforcement.quarantine.info.why'),
        '',
        `**${tr.t('enforcement.quarantine.info.doTitle')}**`,
        `• ${tr.t('enforcement.quarantine.info.wait')}`,
        ...(invite ? [`• ${tr.t('enforcement.quarantine.info.talk', { support: invite })}`] : []),
        `• ${tr.t('enforcement.quarantine.info.noAlts')}`,
        '',
        tr.t('enforcement.quarantine.info.rolesSaved'),
    ];
    return { embeds: [createEmbed({ title: tr.t('enforcement.quarantine.info.title'), description: truncate(lines.join('\n'), 4096), color: 'warning' })] };
}

function infoPayloadFor(guild) {
    let invite = null;
    try {
        invite = deps.appealInvite(guild.id) || null;
    } catch {
        invite = null;
    }
    const lang = textForGuild(guild.id, { purpose: 'public' }).lang;
    return quarantineInfoPayload({ serverName: guild.name, invite }, { lang });
}

/**
 * Posts the info message in the info channel (dashboard button), replacing the one posted
 * before, and makes the channel overwrites right (the setting may have changed). Returns
 * { channel, message, replaced }; throws an Error with `code` ('noChannel' | 'channelGone') when
 * there is nowhere to post, or the send / store error.
 */
export async function postQuarantineInfo(guild) {
    const channelId = infoChannelIdOf(guild);
    if (!channelId) throw Object.assign(new Error('No quarantine info channel is set'), { code: 'noChannel' });
    const channel = guild.channels?.cache?.get(channelId) || await guild.channels?.fetch?.(channelId).catch(() => null);
    if (!channel?.isTextBased?.()) throw Object.assign(new Error('The quarantine info channel is gone or not a text channel'), { code: 'channelGone' });
    const role = quarantineRoleOf(guild);
    if (role) await ensureQuarantineOverwrites(guild, role).catch((error) => logger.warn(`Quarantine overwrites in ${guild.id}: ${error.message}`));
    const previous = await deps.getFromDb(infoPostKey(guild.id), null);
    let replaced = false;
    if (previous?.messageId) {
        const oldChannel = guild.channels?.cache?.get(previous.channelId);
        const old = oldChannel?.messages?.fetch ? await oldChannel.messages.fetch(previous.messageId).catch(() => null) : null;
        if (old) replaced = await old.delete().then(() => true, () => false);
    }
    const message = await channel.send({ ...infoPayloadFor(guild), allowedMentions: { parse: [] } });
    await deps.setInDb(infoPostKey(guild.id), { channelId: channel.id, messageId: message.id, at: new Date().toISOString() });
    return { channel, message, replaced };
}

/** "Refresh posted messages": edits the info message in place in the server's language. Returns 0 or 1; never throws. */
export async function refreshQuarantineInfo(client, guild) {
    try {
        const posted = await deps.getFromDb(infoPostKey(guild.id), null);
        if (!posted?.messageId) return 0;
        const channel = guild.channels?.cache?.get(posted.channelId);
        const message = channel?.messages?.fetch ? await channel.messages.fetch(posted.messageId).catch(() => null) : null;
        if (!message) return 0;
        await message.edit({ ...infoPayloadFor(guild), allowedMentions: { parse: [] } });
        return 1;
    } catch (error) {
        logger.warn(`Could not refresh the quarantine info message of ${guild.id}: ${error.message}`);
        return 0;
    }
}

// ── Decisions: Release, Kick, Ban, Keep (deciders only) ──────────────────

/**
 * Runs a decider's choice on a quarantine. The caller has checked isQuarantineDecider (and, for
 * Release, releaseRefusal). decision: 'release' | 'kick' | 'ban' | 'keep'. `by`: { id, username };
 * `moderator`: the decider as a member of the quarantine's server (kick/ban: executeAction, the
 * same path as /enforcements: Administrator, hierarchy, DM before the kick/ban, case, mod log);
 * `reason` (ban: required; kick: the quarantine reason by default). After Release/Kick/Ban the
 * record is gone and the alert shows who decided what with its buttons disabled; Keep only
 * records the review (record.reviews) and notes it on the alert.
 * Returns { ok: true, decision, restored?, record?, result? } or { ok: false, code }. Throws a
 * user error from executeAction (refused kick/ban: the record stays).
 */
export async function decideQuarantine(guild, userId, options = {}) {
    if (!DECISIONS.includes(options.decision)) return { ok: false, code: 'unknownDecision' };
    // One decision at a time per member (Keep must never write back a record a Ban just removed).
    return Mutex.runExclusive(`quarantine:${guild.id}:${userId}`, () => decideUnlocked(guild, userId, options));
}

/**
 * The gates Release, Kick and Ban share (security review 2026-11-13), or null. Pure. Not for the
 * live server owner / OWNER_IDS here: a staff guard quarantine in Mewvo's own servers is
 * owner-only (like /staff restore), and no decider may act on someone whose SAVED roles reach
 * their own highest role (while quarantined the target holds only the quarantine role, so the
 * live hierarchy check of executeAction would let a demoted senior be kicked or banned).
 * Returns { code: 'ownerOnly' } | { code: 'tooHigh', roles } | null.
 */
export function decisionGate(guild, record, { actorIsOwner = false, moderator = null, home = isMewvoServer(guild?.id) } = {}) {
    if (!record || actorIsOwner) return null;
    if (record.trigger === 'staffGuard' && home) return { code: 'ownerOnly' };
    const roles = tooHighRoles(guild, record, moderator);
    return roles.length ? { code: 'tooHigh', roles } : null;
}

async function decideUnlocked(guild, userId, { decision, by, moderator = null, reason = '', ownerOverride = false, message = null, lang = 'en', actorIsOwner = null } = {}) {
    const key = quarantineKey(guild.id, userId);
    const byName = `${by?.username || '?'}${ownerOverride ? ' (owner override)' : ''}`;
    // Who the decider is, checked here so every caller gets the gates (Discord buttons, dashboard).
    const ownerHere = actorIsOwner ?? isOwnerHere(guild, by?.id || moderator?.id);
    if (decision !== 'keep') {
        const current = await deps.getFromDb(key, null);
        if (!current) return { ok: false, code: 'none' };
        const gate = decisionGate(guild, current, { actorIsOwner: ownerHere, moderator });
        if (gate) return { ok: false, ...gate };
    }
    if (decision === 'release') {
        const released = await releaseUnlocked(guild, userId, { by, ownerOverride, message });
        return released.ok ? { ...released, decision } : released;
    }
    const record = await deps.getFromDb(key, null);
    if (!record) return { ok: false, code: 'none' };
    if (decision === 'keep') {
        const reviewed = { ...record, reviews: [...(record.reviews || []), { by: by ? { id: String(by.id), username: String(by.username || '') } : null, at: new Date().toISOString() }].slice(-20) };
        await deps.setInDb(key, reviewed);
        await markAlertReleased(guild.client, guild.id, userId, record, byName, { message, decision: 'keep', disable: false });
        await logDecision(guild, userId, record, { decision, byName });
        return { ok: true, decision, record: reviewed };
    }
    // Kick or ban: the normal enforcement path, as the decider.
    const targetUser = (await guild.members.fetch(userId).catch(() => null))?.user || await guild.client?.users?.fetch?.(userId).catch(() => null);
    if (!targetUser) return { ok: false, code: 'notInServer' };
    const text = oneLine(reason).slice(0, REASON_MAX) || record.reason || 'Quarantine decision';
    const flow = {
        ...startFlow({ type: decision, moderatorId: moderator?.id || by?.id, targetUser }),
        reason: text, reasonSource: 'custom', reasonKey: CUSTOM_REASON_KEY, customReason: text,
        durationMs: null, unappealable: false, name: `${targetUser.username} ${decision}`, nameIsDefault: true,
    };
    const result = await deps.executeAction({ guild, moderator, targetUser, flow, lang });
    // The member is gone: the record goes (their saved roles too), so a rejoin after a kick starts clean.
    let recordCleared = true;
    try {
        await deps.deleteFromDb(key);
    } catch (error) {
        recordCleared = false;
        logger.error(`Quarantine record of ${userId} in ${guild.id} not removed after the ${decision}: ${error.message}`);
    }
    await markAlertReleased(guild.client, guild.id, userId, record, byName, { message, decision });
    await logDecision(guild, userId, record, { decision, byName, caseCode: result?.record?.case_code || null });
    return { ok: true, decision, result, record, recordCleared };
}

async function logDecision(guild, userId, record, { decision, byName, caseCode = null }) {
    const tr = textForGuild(staffGuildId(guild.id), { purpose: 'public' });
    const username = guild.members?.cache?.get?.(userId)?.user?.username || userId;
    await deps.postModLog(guild.client, decision === 'keep' ? 'quarantine' : 'unquarantine', [
        { name: tr.t('enforcement.quarantine.alert.member'), value: memberLine(userId, username) },
        { name: tr.t('enforcement.quarantine.decide.field'), value: truncate(tr.t('enforcement.quarantine.decide.value', { decision: tr.t(`enforcement.quarantine.decide.done.${decision}`), name: byName, date: dateStamp(new Date()) }), 1024) },
        ...(caseCode ? [{ name: tr.t('enforcement.quarantine.decide.case'), value: `\`${caseCode}\`` }] : []),
        { name: tr.t('enforcement.quarantine.alert.reason'), value: truncate(record.reason || '-', 1024) },
    ], { guildId: guild.id, title: tr.t(decision === 'keep' ? 'enforcement.quarantine.decide.keptTitle' : 'enforcement.quarantine.log.releasedTitle'), subject: { id: userId, username } })
        .catch((error) => logger.warn(`Quarantine decision mod log for ${userId} failed: ${error.message}`));
}
