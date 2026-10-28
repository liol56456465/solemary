// ownerRoutes.js — the Owner area of the dashboard: the bot's owners (OWNER_IDS) manage
// the bot itself.
//
//   GET  /dashboard/owner/profile                       username, avatar, banner, about me, presence
//   POST /dashboard/owner/profile/username|about|presence
//   POST /dashboard/owner/profile/avatar|banner         https URL or an uploaded image (multipart)
//   GET  /dashboard/owner/servers[?q=]                  every server the bot is in
//   GET  /dashboard/owner/servers/:id                   channels, roles, bot permissions (read-only)
//   POST /dashboard/owner/servers/:id/invite            1-use, 1-hour invite (owner/admin of that server only)
//   POST /dashboard/owner/servers/:id/leave/preview|leave   confirm step, never the main/support server
//   GET  /dashboard/owner/blacklist, POST …/add|remove  global blacklist (users, servers)
//   GET  /dashboard/owner/health, POST …/maintenance    process status, maintenance switch
//   GET  /dashboard/owner/announce, POST …/preview|send one message to every server's log channel
//
// Access: every request checks isBotOwner(session user) live (not the cached access
// decision); anyone else gets the normal 404 page. POSTs also need: 30/min per session,
// same origin + CSRF, DASHBOARD_EDIT_ENABLED, and a login younger than 12 hours. Every
// change writes a dashboard_audit row (module 'owner'). Leaving a server and announcing
// need a one-time confirm token (5 minutes, this session) plus a tick-box.

import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { readFileSync } from 'node:fs';
import { isBotOwner as configIsBotOwner } from '../../config/bot.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { logger } from '../../utils/logger.js';
import { getGuildConfig } from '../config/guildConfig.js';
import { resolveLogChannel } from '../loggingService.js';
import { getSetting, guildRole } from '../settings/guildSettings.js';
import { blacklistStore } from '../owner/blacklistService.js';
import {
    getStoredPresence, isMaintenanceOn, parsePresence, savePresence, setMaintenance,
} from '../owner/botStateService.js';
import { InputError, plainText, queryText, text } from './forms.js';
import { MAX_UPLOAD_BYTES, sniffImage } from './multipart.js';
import { path } from './html.js';
import { isSnowflake } from './security.js';
import {
    ABOUT_MAX, ANNOUNCE_MAX, USERNAME_MAX, announceConfirmPage, announcePage, announceResultPage, blacklistPage,
    healthPage, leaveConfirmPage, profilePage, serverPage, serversPage,
} from './ownerPages.js';

export const OWNER_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
export const INVITE_MAX_AGE_SECONDS = 3600;
const IMAGE_FETCH_TIMEOUT_MS = 10000;
const AUDIT_MODULE = 'owner';

let botVersion = null;
function readBotVersion() {
    if (botVersion !== null) return botVersion;
    try {
        botVersion = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version || '';
    } catch {
        botVersion = '';
    }
    return botVersion;
}

// ── Pure rules (tested) ───────────────────────────────────────────────────

/** True while the dashboard login is younger than 12 hours. */
export function isSessionFresh(session, now = Date.now(), maxAgeMs = OWNER_SESSION_MAX_AGE_MS) {
    const created = Number(session?.createdAt);
    return Number.isFinite(created) && created <= now && now - created < maxAgeMs;
}

/**
 * The invite options on a server page: the public vanity URL when the server has one;
 * the "Create invite" button only for that server's owner or an Administrator there.
 */
export function inviteOptions({ vanityCode = null, isGuildOwner = false, isAdmin = false } = {}) {
    return {
        vanityUrl: vanityCode ? `https://discord.gg/${encodeURIComponent(vanityCode)}` : null,
        canCreateInvite: Boolean(isGuildOwner || isAdmin),
    };
}

/** The bot may leave any server except the protected ones (main and support). */
export function canLeaveGuild(guildId, protectedGuildIds) {
    return Boolean(guildId) && !protectedGuildIds.filter(Boolean).includes(String(guildId));
}

/** What an announcement sends: plain text, no mention ever pings. */
export function announcePayload(message) {
    return { content: String(message), allowedMentions: { parse: [] } };
}

const CHANNEL_TYPE_LABEL = {
    [ChannelType.GuildText]: 'Text', [ChannelType.GuildVoice]: 'Voice', [ChannelType.GuildCategory]: 'Category',
    [ChannelType.GuildAnnouncement]: 'Announcement', [ChannelType.GuildStageVoice]: 'Stage', [ChannelType.GuildForum]: 'Forum',
    [ChannelType.GuildMedia]: 'Media', [ChannelType.AnnouncementThread]: 'Thread', [ChannelType.PublicThread]: 'Thread',
    [ChannelType.PrivateThread]: 'Private thread',
};

export function channelTypeLabel(type) {
    return CHANNEL_TYPE_LABEL[type] || 'Other';
}

/** Channels grouped by category (categories first by position, children by position), no threads. */
export function channelRows(guild) {
    const all = [...(guild?.channels?.cache?.values?.() || [])].filter((c) => !c.isThread?.());
    const byPos = (a, b) => (a.rawPosition ?? a.position ?? 0) - (b.rawPosition ?? b.position ?? 0);
    const categories = all.filter((c) => c.type === ChannelType.GuildCategory).sort(byPos);
    const rows = [];
    for (const c of all.filter((x) => x.type !== ChannelType.GuildCategory && !x.parentId).sort(byPos)) {
        rows.push({ name: c.name, type: channelTypeLabel(c.type), category: null });
    }
    for (const cat of categories) {
        rows.push({ name: cat.name, type: channelTypeLabel(cat.type), category: null });
        for (const c of all.filter((x) => x.parentId === cat.id && x.type !== ChannelType.GuildCategory).sort(byPos)) {
            rows.push({ name: c.name, type: channelTypeLabel(c.type), category: cat.name });
        }
    }
    return rows;
}

const canPost = (channel, me) => Boolean(channel?.isTextBased?.() && me
    && channel.permissionsFor?.(me)?.has?.([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]));

/** A channel where the bot may create an invite: system, rules, then the first text channel. */
export function pickInviteChannel(guild) {
    const me = guild?.members?.me;
    const ok = (c) => c && [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(c.type)
        && c.permissionsFor?.(me)?.has?.([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.CreateInstantInvite]);
    const text = [...(guild?.channels?.cache?.values?.() || [])]
        .filter((c) => c.type === ChannelType.GuildText)
        .sort((a, b) => (a.rawPosition ?? a.position ?? 0) - (b.rawPosition ?? b.position ?? 0));
    return [guild?.systemChannel, guild?.rulesChannel, ...text].find(ok) || null;
}

/**
 * Downloads an image from an https URL for the avatar / banner: no other protocol, no
 * localhost or IP-literal hosts, no redirects, 10 s, at most 8 MB, and it must really be a
 * PNG / JPEG / GIF / WebP (first bytes). Returns { data, type }.
 */
export async function fetchImageFromUrl(url, { fetchImpl = globalThis.fetch, maxBytes = MAX_UPLOAD_BYTES } = {}) {
    let parsed;
    try {
        parsed = new URL(String(url));
    } catch {
        throw new InputError('That is not a valid URL.');
    }
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'https:') throw new InputError('Only https image URLs are accepted.');
    if (host === 'localhost' || host.endsWith('.localhost') || /^[\d.]+$/.test(host) || host.includes(':') || host.startsWith('[')) {
        throw new InputError('Use an image URL with a public host name (no localhost or IP address).');
    }
    let response;
    try {
        response = await fetchImpl(parsed.href, { redirect: 'error', signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS) });
    } catch {
        throw new InputError('The image could not be downloaded (redirects are not followed).');
    }
    if (!response.ok) throw new InputError(`The image could not be downloaded (HTTP ${response.status}).`);
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw new InputError(`The image is larger than ${Math.floor(maxBytes / 1024 / 1024)} MB.`);
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > maxBytes) throw new InputError(`The image is larger than ${Math.floor(maxBytes / 1024 / 1024)} MB.`);
    const image = sniffImage(data);
    if (!image) throw new InputError('That URL is not a PNG, JPEG, GIF or WebP image.');
    return { data, type: image.type };
}

/** A Discord API refusal as a message for the page (rate limits, invalid names, …). */
function isDiscordError(error) {
    return /DiscordAPIError|RateLimitError|HTTPError/.test(String(error?.name || error?.constructor?.name || '')) || Number.isInteger(error?.rawError?.code);
}
async function discordCall(fn) {
    try {
        return await fn();
    } catch (error) {
        if (isDiscordError(error)) throw new InputError(`Discord refused: ${plainText(error.message || 'unknown error')}`);
        throw error;
    }
}

/** The channel an announcement goes to: alerts → mod log (main server), else the logging channel. */
async function defaultAnnounceChannelId(client, guild) {
    if (guildRole(guild.id) === 'main') {
        const id = getSetting(guild.id, 'alertsChannelId') || getSetting(guild.id, 'modLogChannelId');
        if (id) return id;
    }
    const config = await getGuildConfig(client, guild.id).catch(() => null);
    return resolveLogChannel(config, 'audit');
}

export const defaultOwnerDeps = {
    isBotOwner: configIsBotOwner,
    blacklist: blacklistStore,
    getStoredPresence, savePresence, setMaintenance, isMaintenanceOn, parsePresence,
    fetchImage: (url) => fetchImageFromUrl(url),
    announceChannelId: defaultAnnounceChannelId,
    protectedGuildIds: () => [enforcementConfig.mainGuildId, enforcementConfig.supportGuildId],
    dbStatus: (client) => client.db?.getStatus?.() || null,
};

// ── Handlers ──────────────────────────────────────────────────────────────

export function createOwnerHandlers(core) {
    const {
        client, guildId, settings, sessions, audits, confirms, sendHtml, fail, shellOf, checkPost, postLimiter,
    } = core;
    const o = { ...defaultOwnerDeps, ...(core.owner || {}) };
    const protectedIds = () => (typeof o.protectedGuildIds === 'function' ? o.protectedGuildIds() : o.protectedGuildIds);
    const actorOf = (req) => ({ userId: req.dashboard.session.userId, username: req.dashboard.session.username });
    const isOwner = (req) => Boolean(req?.dashboard?.session && o.isBotOwner(req.dashboard.session.userId));
    const page = (req) => ({ ...shellOf(req), editEnabled: settings.editEnabled });
    const notFound = (req, res) => fail(res, 404, 'Not found', 'There is no such page.', req);

    /** After requireUser: bot owners only, checked live; everyone else sees the plain 404. */
    function requireOwner(req, res, next) {
        if (!isOwner(req)) return notFound(req, res);
        return next();
    }

    async function audit(req, changes) {
        await audits.writeRows(guildId, actorOf(req), AUDIT_MODULE, changes)
            .catch((error) => logger.error(`Dashboard audit write failed (owner): ${error.message}`));
    }

    async function flash(req, message) {
        await sessions.setFlash?.(req.dashboard.session.id, plainText(message));
    }

    const takeFlash = (req) => req.dashboard.flash || null;

    /**
     * Every Owner POST: owner (live) → rate limit → same origin + CSRF → edit switch →
     * login younger than 12 h → run. Input errors and Discord refusals re-render the page.
     */
    function ownerPost(run, { rerender }) {
        return async (req, res) => {
            if (!isOwner(req)) return notFound(req, res);
            const session = req.dashboard.session;
            if (!postLimiter.allow(session.idHash)) {
                res.set('Retry-After', '60');
                return fail(res, 429, 'Slow down', 'Too many changes in the last minute. Wait a moment and try again.', req);
            }
            if (!checkPost(req)) return fail(res, 403, 'Not allowed', 'This form did not come from this dashboard (security token or origin mismatch). Reload the page and try again.', req);
            if (!settings.editEnabled) return fail(res, 403, 'Editing is off', 'Editing from the dashboard is turned off (DASHBOARD_EDIT_ENABLED). Nothing was changed.', req);
            if (!isSessionFresh(session)) {
                return fail(res, 401, 'Log in again', `Owner changes need a login from the last 12 hours. Log out, then open ${path('')} to log in again. Nothing was changed.`, req);
            }
            try {
                return await run(req, res);
            } catch (error) {
                if (!(error instanceof InputError) && error?.type !== 'validation') throw error;
                const message = plainText(error.userMessage || error.message);
                logger.info(`Dashboard owner ${req.path || ''} refused for ${session.userId}: ${message}`);
                return rerender(req, res, error.status === 403 ? 403 : 400, message);
            }
        };
    }

    // ── Bot profile ──────────────────────────────────────────────────────

    async function loadProfile() {
        await client.application?.fetch?.().catch(() => null);
        const user = client.user;
        if (user?.banner === undefined) await user?.fetch?.(true).catch(() => null);
        const presenceNow = user?.presence;
        const stored = await o.getStoredPresence().catch(() => null);
        const activity = presenceNow?.activities?.[0];
        return {
            id: user?.id || null,
            username: user?.username || null,
            avatarUrl: user?.displayAvatarURL?.({ size: 128, extension: 'png' }) || null,
            bannerUrl: user?.bannerURL?.({ size: 600 }) || null,
            about: client.application?.description || '',
            presence: stored || { status: presenceNow?.status || 'online', activityType: activity ? 'custom' : 'none', activityText: activity?.state || activity?.name || '' },
        };
    }

    async function renderProfile(req, res, status = 200, error = null) {
        return sendHtml(res, status, profilePage({ ...page(req), profile: await loadProfile(), flash: status === 200 ? takeFlash(req) : null, error }));
    }
    const profile = (req, res) => renderProfile(req, res);
    const rerenderProfile = (req, res, status, message) => renderProfile(req, res, status, message);

    const username = ownerPost(async (req, res) => {
        const name = text(req.body, 'username', 100);
        if (name.length < 2 || name.length > USERNAME_MAX) throw new InputError(`A username has 2 to ${USERNAME_MAX} characters.`);
        const old = client.user?.username || null;
        if (name === old) throw new InputError('That is already the username.');
        await discordCall(() => client.user.setUsername(name));
        await audit(req, [{ key: 'profile.username', old, new: name }]);
        await flash(req, `Username changed to ${name}.`);
        return res.redirect(303, path('/owner/profile'));
    }, { rerender: rerenderProfile });

    const about = ownerPost(async (req, res) => {
        const description = String(req.body?.about ?? '').replace(/\r\n/g, '\n').trim();
        if (typeof req.body?.about !== 'string') throw new InputError('Enter the about me text.');
        if (description.length > ABOUT_MAX) throw new InputError(`About me is longer than ${ABOUT_MAX} characters.`);
        if (!client.application?.edit) throw new InputError('The bot application is not available right now. Try again in a moment.');
        const old = client.application.description || '';
        await discordCall(() => client.application.edit({ description }));
        await audit(req, [{ key: 'profile.about', old, new: description }]);
        await flash(req, 'About me saved.');
        return res.redirect(303, path('/owner/profile'));
    }, { rerender: rerenderProfile });

    const presence = ownerPost(async (req, res) => {
        const parsed = o.parsePresence({ status: text(req.body, 'status', 20), activityType: text(req.body, 'activityType', 20), activityText: text(req.body, 'activityText', 200) });
        if (typeof parsed === 'string') throw new InputError(parsed);
        const old = await o.getStoredPresence().catch(() => null);
        await o.savePresence(client, parsed);
        await audit(req, [{ key: 'profile.presence', old, new: parsed }]);
        await flash(req, 'Status saved; it stays after a restart.');
        return res.redirect(303, path('/owner/profile'));
    }, { rerender: rerenderProfile });

    /** The image from the form (upload first, else the URL), checked by its first bytes. */
    async function imageFrom(req) {
        const file = req.upload?.file || null;
        if (file) {
            const image = sniffImage(file.data);
            if (!image) throw new InputError('That file is not a PNG, JPEG, GIF or WebP image.');
            return { data: file.data, type: image.type, source: `upload (${image.type}, ${file.data.length} bytes)` };
        }
        const url = text(req.body, 'url', 500);
        if (!url) throw new InputError('Give an https image URL or choose a file.');
        const image = await o.fetchImage(url);
        return { ...image, source: url };
    }

    const imageAction = (kind) => ownerPost(async (req, res) => {
        const image = await imageFrom(req);
        await discordCall(() => (kind === 'avatar' ? client.user.setAvatar(image.data) : client.user.setBanner(image.data)));
        await audit(req, [{ key: `profile.${kind}`, old: null, new: image.source }]);
        await flash(req, `${kind === 'avatar' ? 'Avatar' : 'Banner'} changed.`);
        return res.redirect(303, path('/owner/profile'));
    }, { rerender: rerenderProfile });

    // ── Servers ──────────────────────────────────────────────────────────

    async function ownerName(ownerId) {
        if (!ownerId) return null;
        const cached = client.users?.cache?.get?.(ownerId);
        const user = cached || await client.users?.fetch?.(ownerId).catch(() => null);
        return user ? (user.globalName || user.username || null) : null;
    }

    function iconOf(guild) {
        try {
            return guild.iconURL?.({ size: 64, extension: 'png' }) || null;
        } catch {
            return null;
        }
    }

    async function serverRow(guild) {
        return {
            id: guild.id, name: guild.name, iconUrl: iconOf(guild), ownerId: guild.ownerId || null,
            ownerName: await ownerName(guild.ownerId), memberCount: guild.memberCount ?? null,
            joinedAt: guild.joinedTimestamp ? new Date(guild.joinedTimestamp) : guild.joinedAt || null,
        };
    }

    async function servers(req, res) {
        const q = queryText(req.query, 'q', 100).toLowerCase();
        const all = [...(client.guilds?.cache?.values?.() || [])];
        const matching = q ? all.filter((g) => g.id === q || String(g.name || '').toLowerCase().includes(q)) : all;
        matching.sort((a, b) => String(a.name).localeCompare(String(b.name), 'en', { sensitivity: 'base' }));
        const rows = await Promise.all(matching.slice(0, 200).map(serverRow));
        return sendHtml(res, 200, serversPage({ ...page(req), rows, total: all.length, q: queryText(req.query, 'q', 100), flash: takeFlash(req) }));
    }

    function guildParam(req) {
        const id = typeof req.params?.id === 'string' ? req.params.id : '';
        return isSnowflake(id) ? client.guilds?.cache?.get?.(id) || null : null;
    }

    /** Is the dashboard user that server's owner, or an Administrator there (fetched fresh)? */
    async function viewerRights(guild, userId) {
        if (guild.ownerId === userId) return { isGuildOwner: true, isAdmin: true };
        const member = await guild.members?.fetch?.({ user: userId, force: true }).catch(() => null);
        return { isGuildOwner: false, isAdmin: Boolean(member?.permissions?.has?.(PermissionFlagsBits.Administrator)) };
    }

    async function renderServer(req, res, status = 200, error = null) {
        const guild = guildParam(req);
        if (!guild) return fail(res, 404, 'Server not found', 'The bot is not in a server with that ID.', req);
        const rights = await viewerRights(guild, req.dashboard.session.userId);
        const roles = [...(guild.roles?.cache?.values?.() || [])]
            .sort((a, b) => (b.position ?? 0) - (a.position ?? 0))
            .map((r) => ({ name: r.name, color: r.hexColor || '#000000', members: r.members?.size ?? 0 }));
        const detail = {
            ...await serverRow(guild),
            channels: channelRows(guild),
            roles,
            permissions: guild.members?.me?.permissions?.toArray?.() || [],
            membersCached: !guild.memberCount || (guild.members?.cache?.size || 0) >= guild.memberCount,
            canLeave: canLeaveGuild(guild.id, protectedIds()),
            ...inviteOptions({ vanityCode: guild.vanityURLCode || null, ...rights }),
        };
        return sendHtml(res, status, serverPage({ ...page(req), detail, flash: status === 200 ? takeFlash(req) : null, error }));
    }
    const server = (req, res) => renderServer(req, res);
    const rerenderServer = (req, res, status, message) => renderServer(req, res, status, message);

    const invite = ownerPost(async (req, res) => {
        const guild = guildParam(req);
        if (!guild) throw new InputError('The bot is not in a server with that ID.');
        const rights = await viewerRights(guild, req.dashboard.session.userId);
        if (!inviteOptions(rights).canCreateInvite) throw new InputError('Only the owner of that server or an Administrator there can create an invite here.', 403);
        const channel = pickInviteChannel(guild);
        if (!channel) throw new InputError('The bot has no channel there where it may create invites.');
        const created = await discordCall(() => channel.createInvite({
            maxUses: 1, maxAge: INVITE_MAX_AGE_SECONDS, unique: true,
            reason: `Dashboard (Owner area): invite for ${req.dashboard.session.username} (${req.dashboard.session.userId})`,
        }));
        await audit(req, [{ key: `servers.${guild.id}.invite`, old: null, new: { code: created.code, channelId: channel.id, maxUses: 1, maxAgeSeconds: INVITE_MAX_AGE_SECONDS } }]);
        await flash(req, `Invite created (1 use, expires in 1 hour): https://discord.gg/${created.code}`);
        return res.redirect(303, path(`/owner/servers/${guild.id}`));
    }, { rerender: rerenderServer });

    const leavePreview = ownerPost(async (req, res) => {
        const guild = guildParam(req);
        if (!guild) throw new InputError('The bot is not in a server with that ID.');
        if (!canLeaveGuild(guild.id, protectedIds())) throw new InputError('The main and the support server cannot be left from here.', 403);
        const { token, hash } = confirms.issue({ session: req.dashboard.session.idHash, subject: `leave:${guild.id}`, payload: { guildId: guild.id } });
        return sendHtml(res, 200, leaveConfirmPage({ ...page(req), guild: { id: guild.id, name: guild.name, memberCount: guild.memberCount }, token, hash }));
    }, { rerender: rerenderServer });

    const leave = ownerPost(async (req, res) => {
        const id = typeof req.params?.id === 'string' ? req.params.id : '';
        if (!canLeaveGuild(id, protectedIds())) throw new InputError('The main and the support server cannot be left from here.', 403);
        const payload = confirms.consume(text(req.body, 'token', 100), { session: req.dashboard.session.idHash, subject: `leave:${id}`, hash: text(req.body, 'fh', 100) });
        if (!payload) throw new InputError('This confirmation expired or was already used. Nothing was done; start again.');
        if (text(req.body, 'confirm', 5) !== '1') throw new InputError('Tick the box to confirm. Nothing was done; start again.');
        const guild = guildParam(req);
        if (!guild) throw new InputError('The bot is not in a server with that ID.');
        const name = guild.name;
        await discordCall(() => guild.leave());
        await audit(req, [{ key: `servers.${id}.leave`, old: { name }, new: null }]);
        logger.warn(`Dashboard owner ${req.dashboard.session.userId} made the bot leave ${name} (${id})`);
        await flash(req, `The bot left ${name}.`);
        return res.redirect(303, path('/owner/servers'));
    }, { rerender: rerenderServer });

    // ── Blacklist ────────────────────────────────────────────────────────

    async function renderBlacklist(req, res, status = 200, error = null, values = {}) {
        const { active, removed } = await o.blacklist.list();
        const names = new Map();
        for (const row of [...active, ...removed]) {
            if (names.has(row.target_id)) continue;
            const name = row.kind === 'guild'
                ? client.guilds?.cache?.get?.(row.target_id)?.name
                : client.users?.cache?.get?.(row.target_id)?.username;
            if (name) names.set(row.target_id, name);
        }
        return sendHtml(res, status, blacklistPage({ ...page(req), active, removed, names, flash: status === 200 ? takeFlash(req) : null, error, values }));
    }
    const blacklist = (req, res) => renderBlacklist(req, res);
    const rerenderBlacklist = (req, res, status, message) => renderBlacklist(req, res, status, message, {
        kind: queryText(req.body, 'kind', 10), id: queryText(req.body, 'id', 25), reason: queryText(req.body, 'reason', 300),
    });

    const blacklistAdd = ownerPost(async (req, res) => {
        const entry = { kind: text(req.body, 'kind', 10), targetId: text(req.body, 'id', 25), reason: text(req.body, 'reason', 400) };
        const row = await o.blacklist.add({ ...entry, actor: actorOf(req) }, { isOwner: o.isBotOwner, protectedGuildIds: protectedIds() });
        await audit(req, [{ key: `blacklist.${row.kind}.${row.target_id}`, old: null, new: { reason: row.reason, id: String(row.id) } }]);
        await flash(req, `${row.kind === 'guild' ? 'Server' : 'User'} ${row.target_id} is blacklisted.`);
        return res.redirect(303, path('/owner/blacklist'));
    }, { rerender: rerenderBlacklist });

    const blacklistRemove = ownerPost(async (req, res) => {
        const row = await o.blacklist.remove(text(req.body, 'entry', 20), actorOf(req));
        if (!row) throw new InputError('That entry is not on the blacklist any more (reload the page).');
        await audit(req, [{ key: `blacklist.${row.kind}.${row.target_id}`, old: { reason: row.reason, id: String(row.id) }, new: null }]);
        await flash(req, `${row.kind === 'guild' ? 'Server' : 'User'} ${row.target_id} removed from the blacklist.`);
        return res.redirect(303, path('/owner/blacklist'));
    }, { rerender: rerenderBlacklist });

    // ── Health and maintenance ───────────────────────────────────────────

    function collectHealth() {
        const status = o.dbStatus(client);
        return {
            uptimeSeconds: process.uptime(),
            gatewayUptimeMs: Number.isFinite(client.uptime) ? client.uptime : null,
            ping: client.ws?.ping,
            memory: process.memoryUsage(),
            node: process.version,
            version: readBotVersion(),
            servers: client.guilds?.cache?.size ?? 0,
            database: status ? { connected: status.connectionType !== 'none' && !status.isDegraded, type: status.connectionType, degraded: Boolean(status.isDegraded) } : null,
            maintenance: o.isMaintenanceOn(),
        };
    }

    async function renderHealth(req, res, status = 200, error = null) {
        return sendHtml(res, status, healthPage({ ...page(req), health: collectHealth(), flash: status === 200 ? takeFlash(req) : null, error }));
    }
    const health = (req, res) => renderHealth(req, res);

    const maintenance = ownerPost(async (req, res) => {
        const wanted = text(req.body, 'enabled', 5);
        if (!['on', 'off'].includes(wanted)) throw new InputError('Choose on or off.');
        const old = o.isMaintenanceOn();
        const enabled = await o.setMaintenance(wanted === 'on');
        await audit(req, [{ key: 'maintenance', old, new: enabled }]);
        logger.warn(`Dashboard owner ${req.dashboard.session.userId} turned maintenance ${enabled ? 'ON' : 'off'}`);
        await flash(req, enabled ? 'Maintenance is on: only bot owners can run commands.' : 'Maintenance is off.');
        return res.redirect(303, path('/owner/health'));
    }, { rerender: (req, res, status, message) => renderHealth(req, res, status, message) });

    // ── Announce ─────────────────────────────────────────────────────────

    /** Every server: its log channel when the bot can post there, else why it is skipped. */
    async function announceTargets() {
        const sendable = [];
        const skipped = [];
        for (const guild of client.guilds?.cache?.values?.() || []) {
            const base = { guildId: guild.id, guildName: guild.name };
            const channelId = await Promise.resolve().then(() => o.announceChannelId(client, guild)).catch(() => null);
            if (!channelId) {
                skipped.push({ ...base, why: 'no log channel configured' });
                continue;
            }
            const channel = guild.channels?.cache?.get?.(channelId) || null;
            if (!channel) skipped.push({ ...base, why: 'the log channel no longer exists' });
            else if (!canPost(channel, guild.members?.me)) skipped.push({ ...base, why: `the bot cannot post in #${channel.name}` });
            else sendable.push({ ...base, channelId: channel.id, channelName: channel.name });
        }
        return { sendable, skipped };
    }

    async function renderAnnounce(req, res, status = 200, error = null) {
        return sendHtml(res, status, announcePage({ ...page(req), targets: await announceTargets(), message: status === 200 ? '' : String(req.body?.message ?? '').slice(0, ANNOUNCE_MAX), error }));
    }
    const announce = (req, res) => renderAnnounce(req, res);
    const rerenderAnnounce = (req, res, status, message) => renderAnnounce(req, res, status, message);

    function announceText(form) {
        const message = typeof form?.message === 'string' ? form.message.replace(/\r\n/g, '\n').trim() : '';
        if (!message) throw new InputError('Write the message.');
        if (message.length > ANNOUNCE_MAX) throw new InputError(`The message is longer than ${ANNOUNCE_MAX} characters.`);
        return message;
    }

    const announcePreview = ownerPost(async (req, res) => {
        const message = announceText(req.body);
        const targets = await announceTargets();
        const { token, hash } = confirms.issue({ session: req.dashboard.session.idHash, subject: 'announce', payload: { message, targets } });
        return sendHtml(res, 200, announceConfirmPage({ ...page(req), message, targets, token, hash }));
    }, { rerender: rerenderAnnounce });

    const announceSend = ownerPost(async (req, res) => {
        const payload = confirms.consume(text(req.body, 'token', 100), { session: req.dashboard.session.idHash, subject: 'announce', hash: text(req.body, 'fh', 100) });
        if (!payload) throw new InputError('This confirmation expired or was already used. Nothing was sent; preview again.');
        if (text(req.body, 'confirm', 5) !== '1') throw new InputError('Tick the box to confirm. Nothing was sent; preview again.');
        const result = { sent: [], failed: [], skipped: [...payload.targets.skipped] };
        for (const target of payload.targets.sendable) {
            const guild = client.guilds?.cache?.get?.(target.guildId);
            const channel = guild?.channels?.cache?.get?.(target.channelId);
            if (!guild || !channel || !canPost(channel, guild.members?.me)) {
                result.failed.push({ ...target, why: 'the channel is gone or the bot can no longer post there' });
                continue;
            }
            try {
                await channel.send(announcePayload(payload.message));
                result.sent.push(target);
            } catch (error) {
                result.failed.push({ ...target, why: plainText(error.message || 'Discord refused') });
            }
        }
        await audit(req, [{ key: 'announce', old: null, new: {
            length: payload.message.length, sent: result.sent.map((t) => t.guildId), failed: result.failed.map((t) => t.guildId), skipped: result.skipped.map((t) => t.guildId),
        } }]);
        logger.info(`Dashboard owner ${req.dashboard.session.userId} announced to ${result.sent.length} server(s) (${result.failed.length} failed)`);
        return sendHtml(res, 200, announceResultPage({ ...page(req), result }));
    }, { rerender: rerenderAnnounce });

    const index = (req, res) => res.redirect(302, path('/owner/profile'));

    return {
        requireOwner, index, profile, username, about, presence, avatar: imageAction('avatar'), banner: imageAction('banner'),
        servers, server, invite, leavePreview, leave, blacklist, blacklistAdd, blacklistRemove,
        health, maintenance, announce, announcePreview, announceSend,
    };
}
