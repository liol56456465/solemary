// incidentRoutes.js: GET /dashboard/incidents (the list) and /dashboard/incidents/:id (one
// incident minute by minute). Administrator-only through the permission table
// (page:incidents is not MODERATOR); read-only, so no POST. A database error gives a 503
// page that says so, never an empty timeline. An id of another server is a 404.

import { logger } from '../../utils/logger.js';
import { getLockdownState } from '../automod/raidService.js';
import { buildTimeline, timelineStore } from '../automod/incidentTimeline.js';
import { incidentDetailPage, incidentListPage } from './incidentPages.js';

/** The data the pages read; replaceable in tests. */
export const defaultIncidents = {
    list: (guildId) => timelineStore().list(guildId),
    get: (guildId, id) => timelineStore().get(guildId, id),
    events: (id) => timelineStore().events(id),
    sources: (guildId, incident) => timelineStore().sources(guildId, incident),
    /** The id of the running incident, or null. */
    activeId: async (guildId) => {
        const state = await getLockdownState(guildId);
        return state?.active && state.timelineId ? String(state.timelineId) : null;
    },
};

/** Names of the ids on the page from the bot's cache only (no Discord requests). */
export function namesFrom(client, guildId, ids) {
    const guild = client?.guilds?.cache?.get(guildId);
    const names = new Map();
    for (const id of ids) {
        if (!id || names.has(id)) continue;
        const name = guild?.members?.cache?.get(id)?.user?.username || client?.users?.cache?.get(id)?.username;
        if (name) names.set(id, name);
    }
    return names;
}

export function createIncidentHandlers({ client, guildId, incidents = defaultIncidents, sendHtml, shellOf, notFound }) {
    // undefined = the lockdown state could not be read (not the same as "no lockdown").
    const activeId = () => Promise.resolve().then(() => incidents.activeId(guildId)).catch((error) => {
        logger.warn(`Dashboard raid timeline: lockdown state: ${error.message}`);
        return undefined;
    });

    async function list(req, res) {
        let rows = null;
        try {
            rows = await incidents.list(guildId);
        } catch (error) {
            logger.warn(`Dashboard raid timeline list: ${error.message}`);
        }
        const running = rows ? await activeId() : null;
        return sendHtml(res, rows ? 200 : 503, incidentListPage({ ...shellOf(req), rows, activeId: running ?? null, stateUnread: Boolean(rows) && running === undefined }));
    }

    async function detail(req, res) {
        const id = typeof req.params?.id === 'string' ? req.params.id : '';
        if (!/^\d{1,18}$/.test(id)) return notFound(req, res);
        let timeline = null;
        try {
            const incident = await incidents.get(guildId, id);
            if (!incident) return notFound(req, res);
            const [events, sources, running] = await Promise.all([
                incidents.events(incident.id), incidents.sources(guildId, incident), activeId(),
            ]);
            const active = running === undefined ? null : !incident.ended_at && running === String(incident.id);
            timeline = buildTimeline({ incident, events, sources, active });
        } catch (error) {
            logger.warn(`Dashboard raid timeline ${id}: ${error.message}`);
            return sendHtml(res, 503, incidentDetailPage({ ...shellOf(req), timeline: null }));
        }
        const ids = [timeline.header.endedBy, timeline.header.released?.by];
        for (const minute of timeline.minutes) for (const item of minute.items) ids.push(item.targetId, item.actorId);
        return sendHtml(res, 200, incidentDetailPage({ ...shellOf(req), timeline, names: namesFrom(client, guildId, ids) }));
    }

    return { list, detail };
}
