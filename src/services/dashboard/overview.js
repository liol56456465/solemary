// overview.js — the dashboard's Overview page (read-only), the module on/off states
// for the sidebar, and the read-only display of registry settings.
//
// Every number is gathered separately: one failing source shows "unavailable" and
// never breaks the page.

import { getGuildConfig } from '../config/guildConfig.js';
import { getWelcomeConfig } from '../../utils/database.js';
import { listPendingAppeals } from '../enforcement/appealService.js';
import { searchCaseRecords } from '../enforcement/caseSearchService.js';
import { findMutedRole } from '../enforcement/muteService.js';
import { formatDuration } from '../enforcement/format.js';
import { query, T } from '../enforcement/db.js';
import { openCards } from '../automod/reviewRegistry.js';
import { getLockdownState } from '../automod/raidService.js';
import { SETTINGS } from '../settings/settingsRegistry.js';
import { getSetting, guildIdFor, settingSource } from '../settings/guildSettings.js';
import { formatDate, html, layout, path } from './html.js';

const PENDING_APPEALS_CAP = 100;

async function countOpenTickets(guildId) {
    const { rows: [row] } = await query(
        `SELECT COUNT(*)::int AS count FROM ${T.tickets} WHERE guild_id = $1 AND data->>'status' = 'open'`, [guildId]);
    return Number(row?.count || 0);
}

export const defaultOverviewData = {
    countOpenTickets,
    listPendingAppeals,
    searchCaseRecords,
    openCards,
    getLockdownState,
    findMutedRole,
    getGuildConfig: (client, guildId) => getGuildConfig(client, guildId),
    getWelcomeConfig: (client, guildId) => getWelcomeConfig(client, guildId),
};

/** undefined when the source failed (shown as "unavailable"). */
async function attempt(fn) {
    try {
        return await fn();
    } catch {
        return undefined;
    }
}

/**
 * On/off per sidebar module, from the guild config, the welcome config and (optional)
 * the automod settings, join-to-create config and application settings.
 */
export function moduleStatesFrom(config, welcome, extra = {}) {
    const states = {};
    if (config) {
        states.logging = Boolean(config.logging?.enabled);
        states.tickets = Boolean(config.ticketCategoryId);
        // No saved leveling config means the defaults, which are on (services/leveling/leveling.js).
        states.leveling = config.leveling ? config.leveling.enabled !== false : true;
        states.verification = Boolean(config.verification?.enabled || config.verification?.autoVerify?.enabled);
        states.birthdays = Boolean(config.birthdayChannelId);
    }
    if (welcome) states.welcome = Boolean(welcome.enabled && welcome.channelId);
    if (extra.automod) states.automod = extra.automod.enabled !== false;
    if (extra.joinToCreate) states.joinToCreate = Boolean(extra.joinToCreate.enabled);
    if (extra.applications) states.applications = extra.applications.enabled === true;
    return states;
}

/** The checklist of things not set up yet: [{ label, done, href, hint }]. */
export function gettingStarted({ config, welcome, settings, mutedRole }) {
    const items = [
        { label: 'Mod log channel', done: Boolean(settings.modLogChannelId), href: path('/enforcement'), hint: 'every enforcement action is recorded there; review and alerts fall back to it' },
        { label: 'Automod review channel', done: Boolean(settings.reviewChannelId), href: path('/automod'), hint: settings.modLogChannelId ? 'uses the mod log until set' : 'automod cards have nowhere to go' },
        { label: 'Alerts channel', done: Boolean(settings.alertsChannelId), href: path('/automod'), hint: settings.modLogChannelId ? 'uses the mod log until set' : 'raid and guard alerts have nowhere to go' },
        { label: 'Muted role', done: Boolean(settings.mutedRoleId || mutedRole), href: path('/enforcement'), hint: 'created automatically on the first mute' },
        { label: 'Appeals category', done: Boolean(settings.appealsCategoryId || config?.ticketCategoryId), href: path('/enforcement'), hint: 'appeal and report channels are opened there' },
        { label: 'Ticket category', done: Boolean(config?.ticketCategoryId), href: path('/tickets'), hint: '/ticket setup in Discord' },
        { label: 'Ticket staff role', done: Boolean(config?.ticketStaffRoleId), href: path('/tickets'), hint: '/ticket setup' },
        { label: 'Welcome channel', done: Boolean(welcome?.enabled && welcome?.channelId), href: path('/welcome'), hint: 'Welcome & goodbye' },
        { label: 'Verification', done: Boolean(config?.verification?.enabled), href: path('/verification'), hint: '/verification setup in Discord' },
        { label: 'Birthday channel', done: Boolean(config?.birthdayChannelId), href: path('/birthdays'), hint: 'Birthdays' },
        { label: 'Banned role in the support server', done: Boolean(settings.bannedRoleId), href: path('/support'), hint: 'members banned here get it there' },
    ];
    return items;
}

/** Everything the Overview page shows. `data` is injectable for tests. */
export async function collectOverview({ client, guildId, data = defaultOverviewData, now = Date.now() }) {
    const guild = client.guilds?.cache?.get(guildId) || null;
    const dbStatus = client.db?.getStatus?.() || null;
    const [config, welcome, openTickets, pending, recent, lockdown, mutedRole] = await Promise.all([
        attempt(() => data.getGuildConfig(client, guildId)),
        attempt(() => data.getWelcomeConfig(client, guildId)),
        attempt(() => data.countOpenTickets(guildId)),
        attempt(() => data.listPendingAppeals(PENDING_APPEALS_CAP, guildId)),
        attempt(() => data.searchCaseRecords(guildId, {}, { page: 0, pageSize: 10 })),
        attempt(() => data.getLockdownState(guildId)),
        attempt(() => (guild ? data.findMutedRole(guild) : null)),
    ]);
    const cards = await attempt(() => data.openCards({ includeCompact: true }).filter((card) => !card.guildId || card.guildId === guildId));
    const presences = guild?.presences?.cache;
    const online = presences && presences.size > 0
        ? [...presences.values()].filter((p) => p.status && p.status !== 'offline').length
        : null;
    const settings = {};
    for (const key of ['modLogChannelId', 'reviewChannelId', 'alertsChannelId', 'mutedRoleId', 'appealsCategoryId', 'bannedRoleId']) {
        settings[key] = getSetting(guildIdFor(SETTINGS.find((e) => e.key === key).guild), key);
    }
    return {
        now,
        bot: { ready: Boolean(client.isReady?.()), ping: Number.isFinite(client.ws?.ping) && client.ws.ping >= 0 ? Math.round(client.ws.ping) : null },
        database: dbStatus ? { connected: dbStatus.connectionType !== 'none' && !dbStatus.isDegraded, type: dbStatus.connectionType, degraded: Boolean(dbStatus.isDegraded) } : null,
        guild: guild ? { name: guild.name, memberCount: guild.memberCount ?? null, online } : null,
        openTickets,
        pendingAppeals: pending === undefined ? undefined : pending.length,
        openReviewCards: cards === undefined ? undefined : cards.length,
        lockdown: lockdown === undefined ? undefined : { active: Boolean(lockdown?.active), since: lockdown?.startedAt || lockdown?.since || null },
        recent: recent?.rows,
        checklist: gettingStarted({ config, welcome, settings, mutedRole }),
        moduleStates: moduleStatesFrom(config, welcome),
    };
}

const show = (value, text = value) => (value === undefined ? html`<span class="muted">unavailable</span>` : text);

/** The Overview page from collectOverview's result. */
export function overviewPage({ session, access = null, moduleStates = {}, overview: o }) {
    const todo = o.checklist.filter((item) => !item.done);
    const pendingText = o.pendingAppeals >= PENDING_APPEALS_CAP ? `${PENDING_APPEALS_CAP}+` : o.pendingAppeals;
    const body = html`<h1>Overview${o.guild ? html` <span class="muted">· ${o.guild.name}</span>` : ''}</h1>
<ul class="stats">
<li><span class="label">Bot</span><span class="value ${o.bot.ready ? 'ok' : 'bad'}">${o.bot.ready ? 'online' : 'offline'}</span>${o.bot.ping !== null ? html`<span class="muted">${o.bot.ping} ms ping</span>` : ''}</li>
<li><span class="label">Database</span>${o.database ? html`<span class="value ${o.database.connected ? 'ok' : 'bad'}">${o.database.connected ? 'connected' : 'degraded'}</span><span class="muted">${o.database.type}</span>` : html`<span class="value muted">unknown</span>`}</li>
<li><span class="label">Members</span><span class="value">${o.guild?.memberCount ?? '—'}</span>${o.guild?.online != null ? html`<span class="muted">${o.guild.online} online</span>` : ''}</li>
<li><span class="label">Open tickets</span><span class="value">${show(o.openTickets)}</span></li>
<li><span class="label">Pending appeals</span><span class="value ${o.pendingAppeals > 0 ? 'warn' : ''}">${show(o.pendingAppeals, html`<a href="${path('/appeals')}">${pendingText}</a>`)}</span></li>
<li><span class="label">Open automod review cards</span><span class="value">${show(o.openReviewCards)}</span><span class="muted">since the last restart</span></li>
<li><span class="label">Raid lockdown</span>${o.lockdown === undefined ? html`<span class="value muted">unavailable</span>` : html`<span class="value ${o.lockdown.active ? 'bad' : 'ok'}">${o.lockdown.active ? 'active' : 'off'}</span>${o.lockdown.active && o.lockdown.since ? html`<span class="muted">since ${formatDate(o.lockdown.since)}</span>` : ''}`}</li>
</ul>
<h2>Getting started${todo.length ? html` <span class="muted">(${todo.length} to do)</span>` : ''}</h2>
<ul class="checklist">${o.checklist.map((item) => html`<li><span class="mark ${item.done ? 'ok' : 'warn'}">${item.done ? 'done' : 'to do'}</span><span><a href="${item.href}">${item.label}</a>${item.done ? '' : html` <span class="muted">— ${item.hint}</span>`}</span></li>`)}</ul>
<h2>Recent enforcement actions</h2>
${o.recent === undefined ? html`<p class="muted">Unavailable (database).</p>` : o.recent.length ? html`<div class="scroll"><table><thead><tr><th>Case</th><th>Type</th><th>Member</th><th>Moderator</th><th>Reason</th><th>Date</th></tr></thead><tbody>
${o.recent.map((row) => html`<tr><td><a href="${path(`/cases/${encodeURIComponent(row.case_code)}`)}"><code>${row.case_code}</code></a></td><td>${row.type}${row.is_test ? html` <span class="muted">(test)</span>` : ''}</td><td>${row.target_username} <span class="muted">${row.target_user_id}</span></td><td>${row.moderator_username}</td><td>${row.reason}</td><td>${formatDate(row.created_at)}</td></tr>`)}
</tbody></table></div><p><a href="${path('/cases')}">All cases</a></p>` : html`<p class="muted">No cases yet.</p>`}`;
    return layout({ title: 'Overview', active: 'overview', session, access, moduleStates, body });
}

// ── Registry settings, read-only ──────────────────────────────────────────

function resolveId(client, guildId, kind, id) {
    const guild = client.guilds?.cache?.get(guildId);
    if (kind === 'role') {
        const role = guild?.roles?.cache?.get(id);
        return role ? html`@${role.name} <span class="muted">${id}</span>` : html`<span class="warn">${id} (not found)</span>`;
    }
    const channel = guild?.channels?.cache?.get(id);
    return channel ? html`#${channel.name} <span class="muted">${id}</span>` : html`<span class="warn">${id} (not found)</span>`;
}

function displayValue(client, guildId, entry, value) {
    if (entry.sensitive) return html`<span class="muted">hidden</span>`;
    if (value === null || value === undefined || value === '') return html`<span class="muted">not set</span>`;
    switch (entry.kind) {
        case 'channel': case 'category': case 'role':
            return resolveId(client, guildId, entry.kind === 'role' ? 'role' : 'channel', value);
        case 'list':
            if (!value.length) return html`<span class="muted">none</span>`;
            if (entry.itemKind === 'string') return `${value.length} word${value.length === 1 ? '' : 's'}`;
            return value.map((id, i) => html`${i ? ', ' : ''}${resolveId(client, guildId, entry.itemKind, id)}`);
        case 'duration':
            return formatDuration(Number(value));
        case 'boolean':
            return value ? 'on' : 'off';
        default:
            return `${value}${entry.unit ? ` ${entry.unit}` : ''}`;
    }
}

/** Rows for settingsSection(): every registry setting of a module, with its current value and source. */
export function settingsRowsFor(client, module, env = process.env) {
    return SETTINGS.filter((entry) => entry.module === module).map((entry) => {
        const guildId = guildIdFor(entry.guild, env);
        const value = getSetting(guildId, entry.key, env);
        return {
            key: entry.key,
            label: entry.label,
            display: displayValue(client, guildId, entry, value),
            source: settingSource(guildId, entry.key, env),
        };
    });
}
