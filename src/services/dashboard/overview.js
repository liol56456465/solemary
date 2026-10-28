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
import { getLockdownState } from '../automod/raidService.js';
import { SETTINGS } from '../settings/settingsRegistry.js';
import { getSetting, guildIdFor, settingSource } from '../settings/guildSettings.js';
import { formatDate, html, icon, layout, navItems, path, raw, timeTag, typeBadge } from './html.js';
import { moduleEntries, setupByModule } from './modulesPage.js';
import { valueText } from './audit.js';

const PENDING_APPEALS_CAP = 100;

async function countOpenTickets(guildId) {
    const { rows: [row] } = await query(
        `SELECT COUNT(*)::int AS count FROM ${T.tickets} WHERE guild_id = $1 AND data->>'status' = 'open'`, [guildId]);
    return Number(row?.count || 0);
}

/**
 * Active bans and mutes (same rule as case search's "active": not voided, not expired, not
 * a /test case): { ban, mute }.
 */
async function countActiveSanctions(guildId) {
    const { rows } = await query(
        `SELECT type, COUNT(*)::int AS count FROM ${T.cases}
         WHERE guild_id = $1 AND type IN ('ban', 'mute') AND status IN ('active', 'appeal_pending')
           AND voided_at IS NULL AND is_test = FALSE AND (expires_at IS NULL OR expires_at > NOW())
         GROUP BY type`, [guildId]);
    const counts = { ban: 0, mute: 0 };
    for (const row of rows) counts[row.type] = Number(row.count || 0);
    return counts;
}

/** Cases per UTC day for the last `days` days (oldest first, today last), /test cases left out. */
async function casesPerDay(guildId, days = 7) {
    const { rows } = await query(
        `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, COUNT(*)::int AS count FROM ${T.cases}
         WHERE guild_id = $1 AND is_test = FALSE
           AND created_at >= ((NOW() AT TIME ZONE 'UTC')::date - ($2::int - 1)) AT TIME ZONE 'UTC'
         GROUP BY day`, [guildId, days]);
    return Object.fromEntries(rows.map((row) => [row.day, Number(row.count || 0)]));
}

/** The last `days` UTC days as [{ day: 'YYYY-MM-DD', label, count, today }] from casesPerDay's map. */
export function weekSeries(counts, now = Date.now(), days = 7) {
    const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return Array.from({ length: days }, (_, i) => {
        const date = new Date(now - (days - 1 - i) * 86_400_000);
        const day = date.toISOString().slice(0, 10);
        return { day, label: i === days - 1 ? 'Today' : names[date.getUTCDay()], count: counts?.[day] || 0, today: i === days - 1 };
    });
}

export const defaultOverviewData = {
    casesPerDay,
    countOpenTickets,
    countActiveSanctions,
    listPendingAppeals,
    searchCaseRecords,
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

/** The guild settings the checklist looks at (mod log, review, alerts, muted role, appeals category, banned role). */
function setupSettings() {
    const settings = {};
    for (const key of ['modLogChannelId', 'reviewChannelId', 'alertsChannelId', 'mutedRoleId', 'appealsCategoryId', 'bannedRoleId']) {
        settings[key] = getSetting(guildIdFor(SETTINGS.find((e) => e.key === key).guild), key);
    }
    return settings;
}

/**
 * Only the Getting-started checklist (Modules page "Set up / Needs setup" lines).
 * null when the guild config could not be read: no line is better than a wrong one.
 */
export async function collectChecklist({ client, guildId, data = defaultOverviewData }) {
    const guild = client.guilds?.cache?.get(guildId) || null;
    const [config, welcome, mutedRole] = await Promise.all([
        attempt(() => data.getGuildConfig(client, guildId)),
        attempt(() => data.getWelcomeConfig(client, guildId)),
        attempt(() => (guild ? data.findMutedRole(guild) : null)),
    ]);
    if (config === undefined) return null;
    return gettingStarted({ config, welcome, settings: setupSettings(), mutedRole });
}

/** Everything the Overview page shows. `data` is injectable for tests. */
export async function collectOverview({ client, guildId, data = defaultOverviewData, now = Date.now() }) {
    const guild = client.guilds?.cache?.get(guildId) || null;
    const dbStatus = client.db?.getStatus?.() || null;
    const [config, welcome, openTickets, sanctions, pending, recent, lockdown, mutedRole, perDay] = await Promise.all([
        attempt(() => data.getGuildConfig(client, guildId)),
        attempt(() => data.getWelcomeConfig(client, guildId)),
        attempt(() => data.countOpenTickets(guildId)),
        attempt(() => data.countActiveSanctions(guildId)),
        attempt(() => data.listPendingAppeals(PENDING_APPEALS_CAP, guildId)),
        attempt(() => data.searchCaseRecords(guildId, {}, { page: 0, pageSize: 10 })),
        attempt(() => data.getLockdownState(guildId)),
        attempt(() => (guild ? data.findMutedRole(guild) : null)),
        attempt(() => data.casesPerDay(guildId, 7)),
    ]);
    // Joined this week: only when the member cache holds (nearly) everyone; otherwise unknown.
    const members = guild?.members?.cache;
    const joinedThisWeek = members && guild.memberCount && members.size >= guild.memberCount * 0.9
        ? [...members.values()].filter((m) => m.joinedTimestamp && m.joinedTimestamp >= now - 7 * 86_400_000).length
        : null;
    const presences = guild?.presences?.cache;
    const online = presences && presences.size > 0
        ? [...presences.values()].filter((p) => p.status && p.status !== 'offline').length
        : null;
    const settings = setupSettings();
    return {
        now,
        bot: { ready: Boolean(client.isReady?.()), ping: Number.isFinite(client.ws?.ping) && client.ws.ping >= 0 ? Math.round(client.ws.ping) : null },
        database: dbStatus ? { connected: dbStatus.connectionType !== 'none' && !dbStatus.isDegraded, type: dbStatus.connectionType, degraded: Boolean(dbStatus.isDegraded) } : null,
        guild: guild ? { name: guild.name, memberCount: guild.memberCount ?? null, online } : null,
        openTickets,
        week: perDay === undefined ? undefined : weekSeries(perDay, now),
        joinedThisWeek,
        activeBans: sanctions?.ban,
        activeMutes: sanctions?.mute,
        pendingAppeals: pending === undefined ? undefined : pending.length,
        pendingList: pending === undefined ? undefined : pending.slice(0, 5),
        lockdown: lockdown === undefined ? undefined : { active: Boolean(lockdown?.active), since: lockdown?.startedAt || lockdown?.since || null },
        recent: recent?.rows,
        checklist: gettingStarted({ config, welcome, settings, mutedRole }),
        moduleStates: moduleStatesFrom(config, welcome),
    };
}

const show = (value, text = value) => (value === undefined ? html`<span class="muted">unavailable</span>` : text);

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
/** A bento tile: optional title row (with a link) and content; `span` = columns of 12. */
function tile(span, title, body, { link = null, className = '' } = {}) {
    return html`<section class="tile span-${span}${className ? ` ${className}` : ''}">${title ? html`<h2 class="tile-title">${title}${link ? html`<a href="${link.href}">${link.text}</a>` : ''}</h2>` : ''}${body}</section>`;
}

/** A KPI tile: label, big number, one line under it. */
function kpi(label, value, sub, { dark = false, href = null } = {}) {
    const number = href && value !== undefined ? html`<a class="kpi-num" href="${href}">${show(value)}</a>` : html`<span class="kpi-num">${show(value)}</span>`;
    return tile(3, label, html`${number}<p class="kpi-sub">${sub}</p>`, { className: `kpi${dark ? ' kpi-dark' : ''}` });
}

/** Actions per day as bars (height in 10 % steps: CSS classes, no inline styles), with a text alternative. */
function weekChart(week) {
    if (week === undefined) return html`<p class="error" role="alert">The chart could not be loaded (database). Reload the page to try again.</p>`;
    const max = Math.max(1, ...week.map((d) => d.count));
    const total = week.reduce((sum, d) => sum + d.count, 0);
    const summary = week.map((d) => `${d.label} ${d.count}`).join(', ');
    return html`<div class="chart" role="img" aria-label="Enforcement actions per day: ${summary}">${week.map((d) => html`<div class="bar${d.today ? ' today' : ''}"><span class="bar-count">${d.count}</span><i class="h-${Math.round((d.count / max) * 10)}"></i><span class="bar-label">${d.label}</span></div>`)}</div>
<p class="kpi-sub">${total} action${total === 1 ? '' : 's'} in 7 days (UTC days, /test cases not counted).</p>`;
}

/** The setup ring: an SVG circle (presentation attributes only, CSP-safe) and the next open steps. */
function setupTile(checklist) {
    const done = checklist.filter((item) => item.done).length;
    const total = checklist.length || 1;
    const todo = checklist.filter((item) => !item.done);
    const arc = ((done / total) * 100).toFixed(1);
    const ring = html`<svg class="ring" width="104" height="104" viewBox="0 0 36 36" role="img" aria-label="${done} of ${checklist.length} setup steps done"><circle cx="18" cy="18" r="15.9155" fill="none" class="ring-track" stroke-width="3.2"></circle>${done ? html`<circle cx="18" cy="18" r="15.9155" fill="none" class="ring-value" stroke-width="3.2" stroke-dasharray="${arc} 100" stroke-linecap="round" transform="rotate(-90 18 18)"></circle>` : ''}<text x="18" y="20.6" text-anchor="middle" class="ring-text">${done}/${checklist.length}</text></svg>`;
    const next = todo.length
        ? html`<ul class="steps">${todo.slice(0, 4).map((item) => html`<li>${icon('circle', 'icon check-icon muted')}<span>${item.label}</span><a href="${item.href}">Set up<span class="sr"> ${item.label}</span></a></li>`)}</ul>`
        : html`<p class="steps-done">${icon('check', 'icon check-icon ok')} Everything is set up.</p>`;
    return html`<div class="setup">${ring}${next}</div>${todo.length > 4 ? html`<p class="kpi-sub"><a href="#all-steps">${todo.length - 4} more step${todo.length - 4 === 1 ? '' : 's'}</a></p>` : ''}`;
}

/** Recent enforcement actions as a feed: badge, who and by whom, reason + case, when. */
function recentFeed(recent) {
    if (recent === undefined) return html`<p class="error" role="alert">Recent actions could not be loaded (database). Reload the page to try again.</p>`;
    if (!recent.length) return html`<p class="empty">No enforcement actions yet. They show up here after the first warn, mute, kick or ban.</p>`;
    return html`<ul class="feed">${recent.slice(0, 5).map((row) => html`<li>${typeBadge(row.type)}<span class="feed-text"><b>${row.target_username}</b> by ${row.moderator_username}${row.is_test ? html` <span class="muted">(test)</span>` : ''}
<small>${row.reason} · case <a href="${path(`/cases/${encodeURIComponent(row.case_code)}`)}"><code>${row.case_code}</code></a></small></span>${timeTag(row.created_at)}</li>`)}</ul>`;
}

/** Every settings module as a chip with its state in words (same rule as the Modules page). */
function modulesTile(moduleStates, checklist) {
    const setup = setupByModule(checklist);
    return html`<div class="mod-chips">${moduleEntries(moduleStates).map((e) => {
        const todo = setup.get(e.key)?.todo;
        const state = e.on === false ? ['off', 'Off'] : todo ? ['warn', 'Setup'] : e.on === true ? ['on', 'On'] : null;
        return html`<a href="${path(`/${e.key}`)}" title="${e.label}">${icon(e.key)}<span class="mod-name">${e.label}</span>${state ? html`<span class="state-word is-${state[0]}"><span class="dot dot-${state[0]}" aria-hidden="true"></span>${state[1]}</span>` : ''}</a>`;
    })}</div>`;
}

/**
 * "Needs you": what waits for an admin, oldest first, each with one button: pending appeals,
 * open tickets, an active raid lockdown, and the next open setup steps.
 */
function needsYou(o) {
    const items = [];
    if (o.lockdown?.active) {
        items.push(html`<li><span class="kind kind-bad" aria-hidden="true">RL</span><span class="what"><b>Raid lockdown is active</b><small>${o.lockdown.since ? html`Since ${formatDate(o.lockdown.since)}` : 'New members are held at the door'}</small></span><span></span><a class="btn primary small" href="${path('/automod')}">Automod</a></li>`);
    }
    for (const appeal of o.pendingList || []) {
        items.push(html`<li><span class="kind kind-appeal" aria-hidden="true">AP</span><span class="what"><b>${appeal.type ? `${appeal.type[0].toUpperCase()}${appeal.type.slice(1)} appeal` : 'Appeal'} from ${appeal.username}</b><small>Case <code>${appeal.case_code}</code>${appeal.name ? ` · ${appeal.name}` : ''}${appeal.is_test ? ' · test case' : ''}</small></span>${timeTag(appeal.created_at)}<a class="btn primary small" href="${path(`/appeals/${encodeURIComponent(appeal.case_code)}`)}">Review<span class="sr"> appeal ${appeal.case_code}</span></a></li>`);
    }
    if (o.pendingAppeals > (o.pendingList || []).length) {
        items.push(html`<li><span class="kind kind-appeal" aria-hidden="true">+</span><span class="what"><b>${o.pendingAppeals - o.pendingList.length} more appeal${o.pendingAppeals - o.pendingList.length === 1 ? '' : 's'} waiting</b></span><span></span><a class="btn small" href="${path('/appeals')}">All appeals</a></li>`);
    }
    if (o.openTickets > 0) {
        items.push(html`<li><span class="kind kind-ticket" aria-hidden="true">TK</span><span class="what"><b>${o.openTickets} open ticket${o.openTickets === 1 ? '' : 's'}</b><small>Answered in their Discord channels</small></span><span></span><a class="btn small" href="${path('/tickets')}">Tickets</a></li>`);
    }
    for (const step of o.checklist.filter((item) => !item.done).slice(0, 2)) {
        items.push(html`<li><span class="kind kind-setup" aria-hidden="true">SU</span><span class="what"><b>Set up: ${step.label}</b>${step.hint ? html`<small>${step.hint}</small>` : ''}</span><span></span><a class="btn small" href="${step.href}">Set up<span class="sr"> ${step.label}</span></a></li>`);
    }
    const failed = o.pendingAppeals === undefined || o.openTickets === undefined;
    const list = items.length
        ? html`<ul class="plain queue">${items}</ul>`
        : html`<p class="empty">${icon('check', 'icon check-icon ok')} Nothing needs you right now.</p>`;
    return html`${failed ? html`<p class="error" role="alert">Some items could not be loaded (database). Reload the page to try again.</p>` : ''}${list}`;
}

/** A card with a header row (title, optional count and link) and a body. */
function card(title, body, { link = null, note = null, className = '' } = {}) {
    return html`<section class="card ov-card${className ? ` ${className}` : ''}"><header class="card-head"><h2>${title}</h2>${note ? html`<span class="card-note">${note}</span>` : ''}${link ? html`<a class="card-link" href="${link.href}">${link.text}</a>` : ''}</header><div class="card-body">${body}</div></section>`;
}

/** The Overview page (v5) from collectOverview's result (+ the newest audit rows; null = audit store unavailable). */
export function overviewPage({ session, access = null, moduleStates = {}, overview: o, recentChanges = [] }) {
    const todo = o.checklist.filter((item) => !item.done);
    const pendingText = o.pendingAppeals >= PENDING_APPEALS_CAP ? `${PENDING_APPEALS_CAP}+` : o.pendingAppeals;
    const sanctions = o.activeBans === undefined || o.activeMutes === undefined ? undefined : o.activeBans + o.activeMutes;
    const server = session?.server;
    const name = o.guild?.name || server?.name || 'your server';
    const waiting = (o.pendingAppeals || 0) + (o.openTickets || 0) + (o.lockdown?.active ? 1 : 0);
    const head = html`<header class="hello"><div class="hello-text"><h1>Welcome back, ${session?.username || 'admin'}</h1><p class="help">${name}${o.guild?.memberCount != null ? ` · ${o.guild.memberCount} members` : ''} · ${waiting ? `${waiting} thing${waiting === 1 ? '' : 's'} waiting` : 'nothing waiting'}</p></div>
<div class="hello-actions"><a class="btn secondary" href="${path('/cases')}">${icon('cases')}Cases</a><a class="btn primary" href="${path('/users')}">${icon('enforcement')}Moderate a member</a></div></header>`;
    const system = html`<ul class="health">
<li><span>Bot</span><span class="state-word is-${o.bot.ready ? 'on' : 'bad'}"><span class="dot dot-${o.bot.ready ? 'on' : 'bad'}" aria-hidden="true"></span>${o.bot.ready ? `Online${o.bot.ping !== null ? ` · ${o.bot.ping} ms` : ''}` : 'Offline'}</span></li>
<li><span>Database</span>${o.database ? html`<span class="state-word is-${o.database.connected ? 'on' : 'bad'}"><span class="dot dot-${o.database.connected ? 'on' : 'bad'}" aria-hidden="true"></span>${o.database.connected ? 'Connected' : 'Degraded'}</span>` : html`<span class="state-word is-off"><span class="dot dot-off" aria-hidden="true"></span>Unknown</span>`}</li>
<li><span>Automod</span>${Object.hasOwn(moduleStates, 'automod') ? html`<span class="state-word is-${moduleStates.automod ? 'on' : 'off'}"><span class="dot dot-${moduleStates.automod ? 'on' : 'off'}" aria-hidden="true"></span>${moduleStates.automod ? 'On' : 'Off'}</span>` : html`<span class="muted">unknown</span>`}</li>
<li><span>Raid lockdown</span>${o.lockdown === undefined ? html`<span class="muted">unavailable</span>` : html`<span class="state-word is-${o.lockdown.active ? 'bad' : 'off'}"><span class="dot dot-${o.lockdown.active ? 'bad' : 'off'}" aria-hidden="true"></span>${o.lockdown.active ? 'Active' : 'Off'}</span>`}</li></ul>`;
    const metric = (label, value, sub, href = null) => html`<div class="metric"><p class="metric-label">${label}</p>${href && value !== undefined ? html`<a class="metric-value" href="${href}">${show(value)}</a>` : html`<p class="metric-value">${show(value)}</p>`}<p class="metric-sub">${sub}</p></div>`;
    const memberSub = o.joinedThisWeek != null ? html`<span class="up">+${o.joinedThisWeek}</span> this week` : o.guild?.online != null ? `${o.guild.online} online` : 'in the server';
    const metrics = html`<div class="metrics">
${metric('Members', o.guild?.memberCount ?? '—', memberSub, path('/users'))}
${metric('Active sanctions', sanctions, sanctions === undefined ? 'unavailable' : `${o.activeBans} ban${o.activeBans === 1 ? '' : 's'} · ${o.activeMutes} mute${o.activeMutes === 1 ? '' : 's'}`, path('/cases'))}
${metric('Pending appeals', o.pendingAppeals === undefined ? undefined : pendingText, o.pendingAppeals > 0 ? 'need a decision' : 'nothing waiting', path('/appeals'))}
${metric('Open tickets', o.openTickets, 'waiting for staff')}</div>`;
    // Full checklist (all steps) at the bottom, open while anything is left.
    const ordered = [...todo, ...o.checklist.filter((item) => item.done)];
    const allSteps = html`<ul class="checklist">${ordered.map((item) => html`<li class="${item.done ? 'is-done' : ''}">${icon(item.done ? 'check' : 'circle', `icon check-icon ${item.done ? 'ok' : 'muted'}`)}<span class="sr">${item.done ? 'done' : 'to do'}:</span>
<span class="checklist-text">${item.label}${item.done ? '' : html`<span class="checklist-hint">${item.hint}</span>`}</span>${item.done
        ? html`<span class="checklist-state">Done</span>`
        : html`<a class="setup-link" href="${item.href}">Set up<span class="sr"> ${item.label}</span></a>`}</li>`)}</ul>`;
    const body = html`${head}
<div class="ov">
<div class="ov-main">
${card('Needs you', needsYou(o), { note: waiting ? `${waiting} open` : null, link: { href: path('/appeals'), text: 'Appeals →' }, className: 'needs-you' })}
${card('Moderation · last 7 days', weekChart(o.week), { link: { href: path('/cases'), text: 'All cases →' } })}
${card('Latest actions', recentFeed(o.recent), { link: { href: path('/cases'), text: 'All cases →' } })}
</div>
<div class="ov-side">
<section class="card ov-card">${metrics}</section>
${card('Bot health', system)}
${card('Setup', setupTile(o.checklist), { link: todo.length ? { href: '#all-steps', text: 'All steps →' } : null })}
</div>
</div>
${card('Modules', modulesTile(moduleStates, o.checklist), { link: { href: path('/modules'), text: 'Manage →' } })}
${recentChangesSection(recentChanges)}
<details class="card section" id="all-steps" data-key="getting-started"${todo.length ? raw(' open') : ''}><summary><h2>All setup steps${todo.length ? html` <span class="count">${todo.length} to do</span>` : html` <span class="state state-on">all set</span>`}</h2></summary><div class="section-body">${allSteps}</div></details>`;
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
