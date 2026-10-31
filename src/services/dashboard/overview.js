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
import { allows } from './permissions.js';

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
    if (rows === null) return html`<section class="plain-section"><h2>Recent dashboard changes</h2><p class="muted">Unavailable (database).</p></section>`;
    const label = (key) => navItems().find((i) => i.key === key)?.label || key;
    const list = rows.length ? html`<div class="scroll"><table><thead><tr><th>When</th><th>Who</th><th>Page</th><th>Setting</th><th>Old</th><th>New</th></tr></thead><tbody>${rows.map((r) => html`<tr>
<td>${timeTag(r.created_at)}</td><td>${r.username || r.user_id || 'someone'}</td><td>${navItems().some((i) => i.key === r.module) ? html`<a href="${path(`/${r.module}`)}">${label(r.module)}</a>` : label(r.module)}</td>
<td><code>${r.key}</code></td><td class="value muted">${valueText(r.old)}</td><td class="value">${valueText(r.new)}</td></tr>`)}</tbody></table></div><p><a href="${path('/audit')}">Full audit log</a></p>`
        : html`<p class="empty">No dashboard changes yet.</p>`;
    return html`<section class="plain-section"><h2>Recent dashboard changes</h2>${list}</section>`;
}

/** The Overview page from collectOverview's result (+ the newest audit rows; null = audit store unavailable). */
/** A plain section (the old "tile"): heading with an optional link, then the content. `span` is ignored. */
export function tile(span, title, body, { link = null, className = '' } = {}) {
    return html`<section class="plain-section${className ? ` ${className}` : ''}">${title ? html`<h2>${title}${link ? html` <a class="section-link" href="${link.href}">${link.text}</a>` : ''}</h2>` : ''}${body}</section>`;
}

/** One fact in a facts row: "Label  value  (note)". No big numbers. */
export function kpi(label, value, sub, { href = null } = {}) {
    const number = href && value !== undefined ? html`<a href="${href}">${show(value)}</a>` : show(value);
    return html`<div class="fact"><dt>${label}</dt><dd><b>${number}</b>${sub ? html` <span class="muted">${sub}</span>` : ''}</dd></div>`;
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

/** The next open setup steps as a plain list. */
function setupTile(checklist) {
    const done = checklist.filter((item) => item.done).length;
    const todo = checklist.filter((item) => !item.done);
    if (!todo.length) return html`<p>Everything is set up.</p>`;
    return html`<p class="muted">${done} of ${checklist.length} steps done.</p><ul class="steps">${todo.slice(0, 4).map((item) => html`<li><span>${item.label}</span> <a href="${item.href}">Set up<span class="sr"> ${item.label}</span></a></li>`)}</ul>${todo.length > 4 ? html`<p><a href="#all-steps">${todo.length - 4} more</a></p>` : ''}`;
}

/** Recent enforcement actions as a table. */
function recentFeed(recent) {
    if (recent === undefined) return html`<p class="error" role="alert">Recent actions could not be loaded (database). Reload the page to try again.</p>`;
    if (!recent.length) return html`<p class="empty">No enforcement actions yet. They show up here after the first warn, mute, kick or ban.</p>`;
    return html`<div class="scroll"><table class="feed-table"><thead><tr><th>When</th><th>Action</th><th>Member</th><th>By</th><th>Reason</th><th>Case</th></tr></thead><tbody>${recent.slice(0, 8).map((row) => html`<tr><td>${timeTag(row.created_at)}</td><td>${typeBadge(row.type)}${row.is_test ? html` <span class="muted">(test)</span>` : ''}</td><td>${row.target_username}</td><td>${row.moderator_username}</td><td>${row.reason}</td><td><a href="${path(`/cases/${encodeURIComponent(row.case_code)}`)}"><code>${row.case_code}</code></a></td></tr>`)}</tbody></table></div>`;
}

/**
 * "Needs you": what waits for an admin, oldest first, each with one button: pending appeals,
 * open tickets, an active raid lockdown, and the next open setup steps.
 */
function needsYou(o, { csrf = '', canEndLockdown = false, limited = false } = {}) {
    const items = [];
    if (o.lockdown?.active) {
        // Administrators end it right here (POST /automod/lockdown-end, back to the Overview); others get the link.
        const endButton = canEndLockdown && csrf
            ? html`<form method="post" action="${path('/automod/lockdown-end')}" class="inline-form" data-confirm="End the raid lockdown? The verification level goes back to what it was and paused invites and DMs resume."><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="back" value="overview"><button type="submit" class="btn small danger">End lockdown</button></form>`
            : limited ? '' : html`<a class="btn primary small" href="${path('/automod')}">Automod</a>`;
        items.push(html`<li><span class="what"><b>Raid lockdown is active</b><small>${o.lockdown.since ? html`Since ${formatDate(o.lockdown.since)}` : 'New members are held at the door'}</small></span><span></span>${endButton}</li>`);
    }
    for (const appeal of o.pendingList || []) {
        items.push(html`<li><span class="what"><b>${appeal.type ? `${appeal.type[0].toUpperCase()}${appeal.type.slice(1)} appeal` : 'Appeal'} from ${appeal.username}</b><small>Case <code>${appeal.case_code}</code>${appeal.name ? ` · ${appeal.name}` : ''}${appeal.is_test ? ' · test case' : ''}</small></span>${timeTag(appeal.created_at)}<a class="btn primary small" href="${path(`/appeals/${encodeURIComponent(appeal.case_code)}`)}">Review<span class="sr"> appeal ${appeal.case_code}</span></a></li>`);
    }
    if (o.pendingAppeals > (o.pendingList || []).length) {
        items.push(html`<li><span class="what"><b>${o.pendingAppeals - o.pendingList.length} more appeal${o.pendingAppeals - o.pendingList.length === 1 ? '' : 's'} waiting</b></span><span></span><a class="btn small" href="${path('/appeals')}">All appeals</a></li>`);
    }
    if (o.openTickets > 0 && !limited) {
        items.push(html`<li><span class="what"><b>${o.openTickets} open ticket${o.openTickets === 1 ? '' : 's'}</b><small>Answered in their Discord channels</small></span><span></span><a class="btn small" href="${path('/tickets')}">Tickets</a></li>`);
    }
    for (const step of limited ? [] : o.checklist.filter((item) => !item.done).slice(0, 2)) {
        items.push(html`<li><span class="what"><b>Set up: ${step.label}</b>${step.hint ? html`<small>${step.hint}</small>` : ''}</span><span></span><a class="btn small" href="${step.href}">Set up<span class="sr"> ${step.label}</span></a></li>`);
    }
    const failed = o.pendingAppeals === undefined || o.openTickets === undefined;
    const list = items.length
        ? html`<ul class="plain queue">${items}</ul>`
        : html`<p class="empty">Nothing needs you right now.</p>`;
    return html`${failed ? html`<p class="error" role="alert">Some items could not be loaded (database). Reload the page to try again.</p>` : ''}${list}`;
}

/** A plain section: a heading (with an optional count and link) and its content. */
function card(title, body, { link = null, note = null, className = '' } = {}) {
    return html`<section class="plain-section${className ? ` ${className}` : ''}"><h2>${title}${note ? html` <span class="muted">(${note})</span>` : ''}${link ? html` <a class="section-link" href="${link.href}">${link.text}</a>` : ''}</h2>${body}</section>`;
}

/** The Overview page (v5) from collectOverview's result (+ the newest audit rows; null = audit store unavailable). */
export function overviewPage({ session, access = null, moduleStates = {}, overview: o, recentChanges = [], editEnabled = false }) {
    // Moderator level (permissions.js): no setup, modules, tickets or audit parts (those pages are Administrator-only).
    const limited = Boolean(access?.allowed) && !allows(access, 'page:modules');
    const todo = o.checklist.filter((item) => !item.done);
    const pendingText = o.pendingAppeals >= PENDING_APPEALS_CAP ? `${PENDING_APPEALS_CAP}+` : o.pendingAppeals;
    const sanctions = o.activeBans === undefined || o.activeMutes === undefined ? undefined : o.activeBans + o.activeMutes;
    const server = session?.server;
    const name = o.guild?.name || server?.name || 'your server';
    const waiting = (o.pendingAppeals || 0) + (o.openTickets || 0) + (o.lockdown?.active ? 1 : 0);
    const word = (ok, yes, no) => (ok ? yes : no);
    const facts = [
        o.guild?.memberCount != null ? `${o.guild.memberCount} members${o.joinedThisWeek != null ? ` (${o.joinedThisWeek} joined this week)` : ''}` : null,
        sanctions === undefined ? 'sanctions unavailable' : `${o.activeBans} active ban${o.activeBans === 1 ? '' : 's'}, ${o.activeMutes} mute${o.activeMutes === 1 ? '' : 's'}`,
        o.pendingAppeals === undefined ? 'appeals unavailable' : html`<a href="${path('/appeals')}">${pendingText} pending appeal${o.pendingAppeals === 1 ? '' : 's'}</a>`,
        o.openTickets === undefined ? 'tickets unavailable' : `${o.openTickets} open ticket${o.openTickets === 1 ? '' : 's'}`,
    ].filter(Boolean);
    const status = [
        `Bot ${word(o.bot.ready, `online${o.bot.ping !== null ? ` (${o.bot.ping} ms)` : ''}`, 'offline')}`,
        `database ${o.database ? word(o.database.connected, 'connected', 'degraded') : 'unknown'}`,
        Object.hasOwn(moduleStates, 'automod') ? `automod ${word(moduleStates.automod, 'on', 'off')}` : null,
        o.lockdown?.active ? 'raid lockdown ACTIVE' : null,
    ].filter(Boolean);
    const head = html`<header class="page-head"><h1>Overview</h1><p class="facts-line">${name} · ${facts.map((f, i) => html`${i ? ' · ' : ''}${f}`)}</p>
<p class="facts-line muted"><span class="${o.bot.ready && (!o.database || o.database.connected) ? '' : 'bad'}">${status.join(', ')}.</span></p></header>`;
    // Full checklist (all steps) at the bottom, open while anything is left.
    const ordered = [...todo, ...o.checklist.filter((item) => item.done)];
    const allSteps = html`<ul class="checklist">${ordered.map((item) => html`<li class="${item.done ? 'is-done' : ''}"><span class="checklist-text">${item.done ? 'Done: ' : ''}${item.label}${item.done ? '' : html` <span class="checklist-hint">${item.hint}</span>`}</span>${item.done
        ? ''
        : html` <a class="setup-link" href="${item.href}">Set up<span class="sr"> ${item.label}</span></a>`}</li>`)}</ul>`;
    const body = html`${head}
${card('To do', needsYou(o, { csrf: session?.csrf, canEndLockdown: Boolean(editEnabled && access?.canAct), limited }), { note: waiting ? `${waiting}` : null })}
${card('Last 7 days', weekChart(o.week), { link: { href: path('/cases'), text: 'All cases' } })}
${card('Latest actions', recentFeed(o.recent), { link: { href: path('/cases'), text: 'All cases' } })}
${limited ? '' : html`${card('Setup', setupTile(o.checklist))}
${recentChangesSection(recentChanges)}
<details class="plain-section" id="all-steps" data-key="getting-started"${todo.length ? raw(' open') : ''}><summary><h2>All setup steps${todo.length ? html` <span class="muted">(${todo.length} to do)</span>` : ''}</h2></summary>${allSteps}</details>`}`;
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
        case 'json':
            return entry.describe ? entry.describe(value) : 'set';
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
