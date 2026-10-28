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
import { formatDate, html, icon, layout, navItems, path, raw, timeTag } from './html.js';
import { moduleEntries } from './modulesPage.js';
import { valueText } from './audit.js';

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
        { label: 'Ticket category', done: Boolean(config?.ticketCategoryId), href: path('/tickets'), hint: 'set up the ticket panel' },
        { label: 'Ticket staff role', done: Boolean(config?.ticketStaffRoleId), href: path('/tickets'), hint: 'ticket settings' },
        { label: 'Welcome channel', done: Boolean(welcome?.enabled && welcome?.channelId), href: path('/welcome'), hint: 'Welcome & goodbye' },
        { label: 'Verification', done: Boolean(config?.verification?.enabled), href: path('/verification'), hint: 'set up the verification panel' },
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

/**
 * One stat tile: short label, value and an optional note. `dot` (on, off, warn, bad) puts a small
 * status dot before the value; the value itself stays in the normal text colour. `title` is the
 * long name, shown on hover and read by screen readers.
 */
function stat(label, value, { dot = '', note = '', href = null, title = '' } = {}) {
    return html`<li class="stat"${title ? html` title="${title}"` : ''}><span class="label">${label}${title ? html`<span class="sr"> (${title})</span>` : ''}</span><span class="value${dot ? ' has-dot' : ''}">${dot ? html`<span class="dot dot-${dot}" aria-hidden="true"></span>` : ''}${value}</span>${note ? html`<span class="note">${note}</span>` : ''}${href ? html`<a class="stat-link" href="${href}"><span class="sr">Open ${label}</span></a>` : ''}</li>`;
}

/** A compact module summary (name + on/off dot); the full cards and switches are on the Modules page. */
function moduleSummary(moduleStates) {
    const entries = moduleEntries(moduleStates);
    const known = entries.filter((e) => e.on !== null);
    return html`<p class="muted">${known.filter((e) => e.on).length} of ${known.length} modules with an on/off state are on.</p>
<ul class="module-chips">${entries.map((e) => html`<li><a href="${path(`/${e.key}`)}">${e.on === null ? '' : html`<span class="dot ${e.on ? 'dot-on' : 'dot-off'}"><span class="sr">${e.on ? 'on' : 'off'}</span></span>`}${e.label}</a></li>`)}</ul>
<p class="card-foot"><a href="${path('/modules')}">Manage modules</a></p>`;
}

/** The newest dashboard changes (audit rows): who, which module and setting, old → new, when. */
function recentChangesSection(rows) {
    if (rows === null) return html`<section class="card"><h2>Recent dashboard changes</h2><p class="muted">Unavailable (database).</p></section>`;
    const label = (key) => navItems().find((i) => i.key === key)?.label || key;
    const list = rows.length ? html`<ul class="activity">${rows.map((r) => html`<li>
<span class="avatar-initials" aria-hidden="true">${String(r.username || '?').slice(0, 1).toUpperCase()}</span>
<span class="activity-text"><strong>${r.username || r.user_id || 'someone'}</strong> changed <code>${r.key}</code> in ${navItems().some((i) => i.key === r.module) ? html`<a href="${path(`/${r.module}`)}">${label(r.module)}</a>` : label(r.module)}
<span class="activity-values muted">${valueText(r.old)} → ${valueText(r.new)}</span></span>
<span class="activity-time muted">${timeTag(r.created_at)}</span></li>`)}</ul><p class="card-foot"><a href="${path('/audit')}">Full audit log</a></p>`
        : html`<p class="empty">No dashboard changes yet.</p>`;
    return html`<section class="card"><h2>Recent dashboard changes</h2>${list}</section>`;
}

/** The Overview page from collectOverview's result (+ the newest audit rows; null = audit store unavailable). */
export function overviewPage({ session, access = null, moduleStates = {}, overview: o, recentChanges = [] }) {
    const todo = o.checklist.filter((item) => !item.done);
    const pendingText = o.pendingAppeals >= PENDING_APPEALS_CAP ? `${PENDING_APPEALS_CAP}+` : o.pendingAppeals;
    const lockdown = o.lockdown === undefined ? html`<span class="muted">Unavailable</span>` : o.lockdown.active ? 'Active' : 'Off';
    // One row of equal tiles: short labels, a status dot where the value is a state.
    const stats = html`<ul class="stats">
${stat('Bot', o.bot.ready ? 'Online' : 'Offline', { dot: o.bot.ready ? 'on' : 'bad', note: o.bot.ping !== null ? `${o.bot.ping} ms ping` : '' })}
${stat('Database', o.database ? (o.database.connected ? 'Connected' : 'Degraded') : html`<span class="muted">Unknown</span>`, { dot: o.database ? (o.database.connected ? 'on' : 'bad') : 'off', note: o.database?.type || '' })}
${stat('Members', o.guild?.memberCount ?? '—', { note: o.guild?.online != null ? `${o.guild.online} online` : '' })}
${stat('Open tickets', show(o.openTickets))}
${stat('Appeals', show(o.pendingAppeals, html`<a href="${path('/appeals')}">${pendingText}</a>`), { dot: o.pendingAppeals > 0 ? 'warn' : '', note: 'pending', title: 'Pending appeals' })}
${stat('Review cards', show(o.openReviewCards), { note: 'since restart', title: 'Open automod review cards' })}
${stat('Lockdown', lockdown, { dot: o.lockdown?.active ? 'bad' : o.lockdown ? 'off' : '', note: o.lockdown?.active && o.lockdown.since ? `since ${formatDate(o.lockdown.since)}` : '', title: 'Raid lockdown' })}
</ul>`;
    // Open items first; a check icon for done ones (the word is there for screen readers).
    const doneCount = o.checklist.length - todo.length;
    const ordered = [...todo, ...o.checklist.filter((item) => item.done)];
    const checklist = html`<div class="progress-row"><progress value="${doneCount}" max="${o.checklist.length || 1}" aria-label="Setup progress"></progress><span class="muted">${doneCount} of ${o.checklist.length} done</span></div>
<ul class="checklist">${ordered.map((item) => html`<li class="${item.done ? 'is-done' : ''}">${icon(item.done ? 'check' : 'circle', `icon check-icon ${item.done ? 'ok' : 'muted'}`)}<span class="sr">${item.done ? 'done' : 'to do'}:</span>
<span><a href="${item.href}">${item.label}</a>${item.done ? '' : html`<span class="checklist-hint">${item.hint}</span>`}</span></li>`)}</ul>`;
    const recent = o.recent === undefined ? html`<p class="muted">Unavailable (database).</p>` : o.recent.length ? html`<div class="table-wrap"><table><thead><tr><th>Case</th><th>Type</th><th>Member</th><th>Moderator</th><th>Reason</th><th>When</th></tr></thead><tbody>
${o.recent.map((row) => html`<tr><td><a href="${path(`/cases/${encodeURIComponent(row.case_code)}`)}"><code>${row.case_code}</code></a></td><td><span class="type type-${row.type}">${row.type}</span>${row.is_test ? html` <span class="muted">(test)</span>` : ''}</td><td>${row.target_username} <span class="muted">${row.target_user_id}</span></td><td>${row.moderator_username}</td><td class="clip">${row.reason}</td><td class="nowrap">${timeTag(row.created_at)}</td></tr>`)}
</tbody></table></div><p class="card-foot"><a href="${path('/cases')}">All cases</a></p>` : html`<p class="empty">No cases yet.</p>`;
    const body = html`<div class="page-head"><h1>Overview</h1>${o.guild ? html`<p class="muted">${o.guild.name}</p>` : ''}</div>
${stats}
<details class="card section" data-key="getting-started"${todo.length ? raw(' open') : ''}><summary><h2>Getting started${todo.length ? html` <span class="count">${todo.length} to do</span>` : html` <span class="state state-on">all set</span>`}</h2></summary><div class="section-body">${checklist}</div></details>
<section class="card"><h2>Recent enforcement actions</h2>${recent}</section>
${recentChangesSection(recentChanges)}
<section class="card"><h2>Modules</h2>${moduleSummary(moduleStates)}</section>`;
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
