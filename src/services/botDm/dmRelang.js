// dmRelang.js — when a member changes language (a language role through /language, the panel,
// Discord Onboarding or a staff role change), the bot's DMs to them about that server from the
// last 30 days (bot_dm_log, dmLog.js) are edited into the new language (owner, 2026-11-08).
//
//   debounce   every change (re)starts a quiet window of DEBOUNCE_MS per server + member; the
//              run happens once at its end, with the language the member has THEN (two changes
//              within a minute: one run, final language). A run still going stops at its next
//              DM when a newer change comes in (that newer run does the rest).
//   bounded    at most MAX_EDITS DMs per change, newest first; only DMs not in that language yet.
//   paced      one edit every PACE_MS (about 1.5 s) for the whole bot; runs go one at a time.
//   gone DMs   a deleted DM (10008) or DM channel (10003) loses its row; so does a DM that moved
//              on (the answered feedback survey, dmRenderers stillCurrent).
//   same shape the DM is re-rendered from its template (dmRenderers.js) with the stored params:
//              only our text changes; components are touched only when the template renders
//              them; attachments and embed timestamps stay.
// The member gets no new DM. Failures are logged and never thrown (a background job).

import { logger } from '../../utils/logger.js';
import { LANGUAGE_ROLES_KEY, resolveBotLanguage } from '../../utils/botText.js';
import { resolveSetting } from '../settings/guildSettings.js';
import { personalLanguageOf } from '../personalLanguage.js';
import { deleteDmLogRow, listDmGuildsForUser, listDmsToRelang, setDmLogLang } from './dmLog.js';
import { DM_RENDERERS, renderDm } from './dmRenderers.js';

export const DEBOUNCE_MS = 60 * 1000;
export const PACE_MS = 1500;
export const MAX_EDITS = 50;
const GONE_CODES = new Set([10003, 10008]);
const NO_MENTIONS = Object.freeze({ parse: [] });

/** Keeps each embed's timestamp from the message being edited (re-rendered embeds have none). */
export function keepEmbedTimestamps(payload, message) {
    if (!payload?.embeds?.length || !message?.embeds?.length) return payload;
    const embeds = payload.embeds.map((embed, i) => {
        const old = message.embeds[i]?.timestamp;
        if (!old || typeof embed?.setTimestamp !== 'function') return embed;
        return embed.setTimestamp(new Date(old));
    });
    return { ...payload, embeds };
}

/**
 * The re-editor. Everything it touches is injectable for the tests; the bot uses the default
 * instance (scheduleDmRelang below).
 */
export function createDmRelang({
    debounceMs = DEBOUNCE_MS,
    paceMs = PACE_MS,
    maxEdits = MAX_EDITS,
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); }),
    setTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
    clearTimer = (t) => clearTimeout(t),
    listRows = listDmsToRelang,
    deleteRow = deleteDmLogRow,
    setLang = setDmLogLang,
    render = renderDm,
    renderers = DM_RENDERERS,
    resolveLanguage = (guildId, member, userId = member?.id) => resolveBotLanguage({ guildId, member, userId, purpose: 'dm' }),
    hasPersonal = (userId) => Boolean(personalLanguageOf(userId)),
} = {}) {
    const timers = new Map();      // guildId:userId → timer
    const generation = new Map();  // guildId:userId → n (a newer change → a higher n)
    const personalChange = new Set(); // guildId:userId: a personal language change (set or cleared)
    let chain = Promise.resolve();
    let lastEditAt = -Infinity;

    const keyOf = (guildId, userId) => `${guildId}:${userId}`;
    const stale = (key, gen) => generation.get(key) !== gen;

    async function pace() {
        const wait = lastEditAt + paceMs - now();
        if (wait > 0) await sleep(wait);
        lastEditAt = now();
    }

    async function fetchMember(client, guildId, userId) {
        const guild = client?.guilds?.cache?.get?.(guildId);
        if (!guild) return null;
        const cached = guild.members?.cache?.get?.(userId);
        if (cached) return cached;
        return await guild.members?.fetch?.(userId).catch((error) => {
            if (error?.code === 10007) return null; // Unknown Member: left the server
            throw new Error(`member not fetchable right now (${error?.code ?? error?.message ?? 'error'})`);
        }) ?? null;
    }

    async function fetchMessage(client, row) {
        const channel = await client.channels.fetch(row.channel_id);
        return channel.messages.fetch(row.message_id);
    }

    async function dropRow(row, why) {
        await deleteRow(row.id).catch((error) => logger.debug(`DM log row could not be removed (${why}): ${error.message}`));
    }

    /** One run: returns { lang, edited, removed, skipped, stopped }. Never throws. */
    async function run(client, guildId, userId, gen) {
        const key = keyOf(guildId, userId);
        const result = { lang: null, edited: 0, removed: 0, skipped: 0, stopped: false };
        try {
            if (stale(key, gen)) return { ...result, stopped: true };
            const member = await fetchMember(client, guildId, userId);
            // Not in the server any more (or not fetchable now): no language role to go by; only
            // a personal language still decides (e.g. the DM about a ban from that server), and so
            // does clearing one (back to the server language).
            const personal = personalChange.delete(key);
            if (!member && !personal && !hasPersonal(userId)) return result;
            const lang = resolveLanguage(guildId, member, userId);
            result.lang = lang;
            const rows = await listRows({ guildId, userId, lang, limit: maxEdits });
            for (const row of rows) {
                if (stale(key, gen)) { result.stopped = true; break; }
                const renderer = renderers[row.template_key];
                if (!renderer) { result.skipped += 1; continue; }
                await pace();
                if (stale(key, gen)) { result.stopped = true; break; }
                let message;
                try {
                    message = await fetchMessage(client, row);
                } catch (error) {
                    if (GONE_CODES.has(error?.code)) {
                        await dropRow(row, 'deleted');
                        result.removed += 1;
                    } else {
                        logger.debug(`DM ${row.template_key} to ${userId} not fetched for a language change: ${error?.message || error}`);
                        result.skipped += 1;
                    }
                    continue;
                }
                if (renderer.stillCurrent && !renderer.stillCurrent(message)) {
                    await dropRow(row, 'moved on');
                    result.removed += 1;
                    continue;
                }
                try {
                    const payload = keepEmbedTimestamps(await render(row.template_key, row.params || {}, lang), message);
                    await message.edit({ ...payload, allowedMentions: NO_MENTIONS });
                    result.edited += 1;
                } catch (error) {
                    if (GONE_CODES.has(error?.code)) {
                        await dropRow(row, 'deleted');
                        result.removed += 1;
                    } else {
                        logger.debug(`DM ${row.template_key} to ${userId} not edited for a language change: ${error?.message || error}`);
                        result.skipped += 1;
                    }
                    continue;
                }
                await setLang(row.id, lang).catch((error) => logger.debug(`DM log language not updated: ${error.message}`));
            }
            if (result.edited || result.removed) {
                logger.info(`Language change: ${result.edited} DM(s) edited into ${lang}, ${result.removed} gone (server ${guildId})`);
            }
        } catch (error) {
            logger.warn(`Language change: DMs of a member in ${guildId} not re-edited: ${error?.message || error}`);
        }
        return result;
    }

    /**
     * A member's language may have changed: (re)starts the quiet window; returns the promise of
     * the run that follows (tests). Never throws.
     */
    function schedule(client, guildId, userId, { personal = false } = {}) {
        if (!client || !guildId || !userId) return Promise.resolve(null);
        const key = keyOf(String(guildId), String(userId));
        if (personal) personalChange.add(key);
        const gen = (generation.get(key) || 0) + 1;
        generation.set(key, gen);
        const previous = timers.get(key);
        if (previous) {
            clearTimer(previous.timer);
            previous.resolve(null); // superseded: the newer change runs instead
        }
        return new Promise((resolve) => {
            const entry = { resolve, timer: null };
            entry.timer = setTimer(() => {
                if (timers.get(key) === entry) timers.delete(key);
                const job = chain.then(() => run(client, String(guildId), String(userId), gen));
                chain = job.catch(() => {});
                job.then((out) => {
                    if (generation.get(key) === gen) generation.delete(key);
                    resolve(out);
                }, () => resolve(null));
            }, debounceMs);
            timers.set(key, entry);
        });
    }

    return { schedule, run, pending: () => timers.size };
}

const defaultRelang = createDmRelang();

/** The bot's re-editor (events/guildMemberUpdate.js, handlers/languageRoles.js). */
export function scheduleDmRelang(client, guildId, userId, options) {
    return defaultRelang.schedule(client, guildId, userId, options);
}

/**
 * A member changed their personal language (/language without a role, the website): their DMs
 * about every server with logged DMs (and `guildId`, where they made the change) are re-edited
 * the same way as after a language-role change. Each server's run still applies that server's
 * order (a language role there comes first). Returns the number of servers scheduled; never throws.
 */
export async function schedulePersonalRelang(client, userId, guildId = null, { listGuilds = listDmGuildsForUser, schedule = scheduleDmRelang } = {}) {
    if (!client || !userId) return 0;
    let guilds = [];
    try {
        guilds = await listGuilds(userId);
    } catch (error) {
        logger.warn(`Personal language change: the DM log of ${userId} could not be read (${error?.message || error}); only the current server is re-edited.`);
    }
    const all = new Set([...(guildId ? [String(guildId)] : []), ...guilds.map(String)]);
    for (const id of all) schedule(client, id, userId, { personal: true });
    return all.size;
}

/**
 * guildMemberUpdate: did this role change touch a language role of the server? A partial old
 * member (roles before unknown) counts when the member has a language role now. `map`: the
 * server's languageRoles ({ code: roleId }). Pure.
 */
export function languageRoleChanged(oldMember, newMember, map) {
    const ids = Object.values(map || {}).filter(Boolean).map(String);
    if (!ids.length || !newMember?.roles?.cache) return false;
    const now = (id) => newMember.roles.cache.has(id);
    if (!oldMember || oldMember.partial || !oldMember.roles?.cache) return ids.some(now);
    return ids.some((id) => oldMember.roles.cache.has(id) !== now(id));
}

/**
 * Called by events/guildMemberUpdate.js on a role change (Onboarding, a staff change, /language):
 * schedules the re-edit when a language role changed. Never throws; a settings read error means
 * nothing is scheduled.
 */
export function onMemberRolesChanged(oldMember, newMember, { resolve = resolveSetting, schedule = scheduleDmRelang } = {}) {
    try {
        const guildId = newMember?.guild?.id;
        if (!guildId) return false;
        let map;
        try {
            map = resolve(String(guildId), LANGUAGE_ROLES_KEY);
        } catch {
            return false;
        }
        if (!languageRoleChanged(oldMember, newMember, map)) return false;
        schedule(newMember.client, guildId, newMember.id);
        return true;
    } catch (error) {
        logger.debug(`Language change check failed: ${error?.message || error}`);
        return false;
    }
}
