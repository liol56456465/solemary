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
        { label: 'Mod log channel', done: Boolean(settings.modLogChannelId), href: path('/enforcement'), hint: 'Mewvo writes every warning, mute, kick and ban there, so your staff can look back later.' },
        { label: 'Automod review channel', done: Boolean(settings.reviewChannelId), href: path('/automod'), hint: `When automod removes a message, it posts a short report there so staff can keep or undo it.${settings.modLogChannelId ? ' Until you choose one, it uses the mod log.' : ''}` },
        { label: 'Alerts channel', done: Boolean(settings.alertsChannelId), href: path('/automod'), hint: `For urgent warnings, like a raid (many accounts joining at once).${settings.modLogChannelId ? ' Until you choose one, it uses the mod log.' : ''}` },
        { label: 'Muted role', done: Boolean(settings.mutedRoleId || mutedRole), href: path('/enforcement'), hint: 'Mewvo creates it by itself the first time someone is muted. You can also pick your own role.' },
        { label: 'Appeals category', done: Boolean(settings.appealsCategoryId || config?.ticketCategoryId), href: path('/enforcement'), hint: 'When someone asks to have a punishment lifted, Mewvo opens a private channel for it in this category.' },
        { label: 'Ticket category', done: Boolean(config?.ticketCategoryId), href: path('/tickets'), hint: 'Tickets let members talk to staff privately. Choose the category their channels go in.' },
        { label: 'Ticket staff role', done: Boolean(config?.ticketStaffRoleId), href: path('/tickets'), hint: 'The role that can see and answer tickets.' },
        { label: 'Welcome channel', done: Boolean(welcome?.enabled && welcome?.channelId), href: path('/welcome'), hint: 'Mewvo greets new members in this channel.' },
        { label: 'Verification', done: Boolean(config?.verification?.enabled), href: path('/verification'), hint: 'New members press a button to show they are a real person before they can chat.' },
        { label: 'Birthday channel', done: Boolean(config?.birthdayChannelId), href: path('/birthdays'), hint: 'Mewvo wishes members a happy birthday there.' },
        { label: 'Banned role in the support server', done: Boolean(settings.bannedRoleId), href: path('/support'), hint: 'Banned members get this role in your support server, so they can still appeal there.' },
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
    if (rows === null) return html`<section class="plain-section"><h2>Recent dashboard changes</h2><p class="muted">Could not be loaded just now. Reload the page in a minute.</p></section>`;
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
    if (week === undefined) return html`<p class="error" role="alert">The chart could not be loaded just now. Reload the page in a minute.</p>`;
    const max = Math.max(1, ...week.map((d) => d.count));
    const total = week.reduce((sum, d) => sum + d.count, 0);
    const summary = week.map((d) => `${d.label} ${d.count}`).join(', ');
    return html`<div class="chart" role="img" aria-label="Enforcement actions per day: ${summary}">${week.map((d) => html`<div class="bar${d.today ? ' today' : ''}"><span class="bar-count">${d.count}</span><i class="h-${Math.round((d.count / max) * 10)}"></i><span class="bar-label">${d.label}</span></div>`)}</div>
<p class="kpi-sub">${total} action${total === 1 ? '' : 's'} in 7 days (UTC days, /test cases not counted).</p>`;
}

/** Recent enforcement actions as a table. */
function recentFeed(recent) {
    if (recent === undefined) return html`<p class="error" role="alert">The latest moderation could not be loaded just now. Reload the page in a minute.</p>`;
    if (!recent.length) return html`<p class="empty">No enforcement actions yet. They show up here after the first warn, mute, kick or ban.</p>`;
    return html`<div class="scroll"><table class="feed-table"><thead><tr><th>When</th><th>Action</th><th>Member</th><th>By</th><th>Reason</th><th>Case</th></tr></thead><tbody>${recent.slice(0, 8).map((row) => html`<tr><td>${timeTag(row.created_at)}</td><td>${typeBadge(row.type)}${row.is_test ? html` <span class="muted">(test)</span>` : ''}</td><td>${row.target_username}</td><td>${row.moderator_username}</td><td>${row.reason}</td><td><a href="${path(`/cases/${encodeURIComponent(row.case_code)}`)}"><code>${row.case_code}</code></a></td></tr>`)}</tbody></table></div>`;
}

/**
 * "Needs you": what waits for an admin, oldest first, each with one button: pending appeals,
 * open tickets, an active raid lockdown, and the next open setup steps.
 */
function needsYou(o, { csrf = '', canEndLockdown = false, limited = false, setupSteps = true } = {}) {
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
    for (const step of limited || !setupSteps ? [] : o.checklist.filter((item) => !item.done).slice(0, 2)) {
        items.push(html`<li><span class="what"><b>Set up: ${step.label}</b>${step.hint ? html`<small>${step.hint}</small>` : ''}</span><span></span><a class="btn small" href="${step.href}">Set up<span class="sr"> ${step.label}</span></a></li>`);
    }
    const failed = o.pendingAppeals === undefined || o.openTickets === undefined;
    const list = items.length
        ? html`<ul class="plain queue">${items}</ul>`
        : html`<p class="empty">Nothing needs you right now. Appeals, tickets and raid alerts show up here.</p>`;
    return html`${failed ? html`<p class="error" role="alert">Some of this could not be loaded just now. Reload the page in a minute.</p>` : ''}${list}`;
}

/** A plain section: a heading (with an optional count and link) and its content. */
function card(title, body, { link = null, note = null, className = '' } = {}) {
    return html`<section class="plain-section${className ? ` ${className}` : ''}"><h2>${title}${note ? html` <span class="muted">(${note})</span>` : ''}${link ? html` <a class="section-link" href="${link.href}">${link.text}</a>` : ''}</h2>${body}</section>`;
}

/** The Overview page (v5) from collectOverview's result (+ the newest audit rows; null = audit store unavailable). */
export function overviewPage({ session, access = null, moduleStates = {}, overview: o, recentChanges = [], editEnabled = false, handover = null, canEditHandover = false, flash = null }) {
    // Moderator level (permissions.js): no setup, modules, tickets or audit parts (those pages are Administrator-only).
    const limited = Boolean(access?.allowed) && !allows(access, 'page:modules');
    const todo = o.checklist.filter((item) => !item.done);
    const pendingText = o.pendingAppeals >= PENDING_APPEALS_CAP ? `${PENDING_APPEALS_CAP}+` : o.pendingAppeals;
    const sanctions = o.activeBans === undefined || o.activeMutes === undefined ? undefined : o.activeBans + o.activeMutes;
    const server = session?.server;
    const name = o.guild?.name || server?.name || 'your server';
    const waiting = (o.pendingAppeals || 0) + (o.openTickets || 0) + (o.lockdown?.active ? 1 : 0);
    const unknown = 'not available right now';
    const facts = [
        o.guild?.memberCount != null ? `${o.guild.memberCount} members${o.joinedThisWeek != null ? `, ${o.joinedThisWeek} joined this week` : ''}` : null,
        sanctions === undefined ? `banned and muted: ${unknown}` : `${o.activeBans} banned and ${o.activeMutes} muted right now`,
        o.pendingAppeals === undefined ? `appeals: ${unknown}` : html`<a href="${path('/appeals')}">${pendingText} appeal${o.pendingAppeals === 1 ? '' : 's'} waiting</a>`,
        o.openTickets === undefined ? `tickets: ${unknown}` : `${o.openTickets} open ticket${o.openTickets === 1 ? '' : 's'}`,
    ].filter(Boolean);
    const healthy = o.bot.ready && (!o.database || o.database.connected);
    const status = !o.bot.ready ? 'Mewvo is offline: commands and automod are not working right now.'
        : o.database && !o.database.connected ? 'Mewvo is online, but its database is not responding, so some things will not save.'
            : 'Mewvo is online and working.';
    const automodWord = Object.hasOwn(moduleStates, 'automod') ? ` Automod is ${moduleStates.automod ? 'on' : 'off'}.` : '';
    const head = html`<header class="page-head"><h1>Overview</h1><p class="facts-line">${name}: ${facts.map((f, i) => html`${i ? ' · ' : ''}${f}`)}</p>
<p class="facts-line"><span class="${healthy ? 'ok-text' : 'bad'}">${status}</span>${automodWord}${o.lockdown?.active ? html` <span class="bad">A raid lockdown is active.</span>` : ''}</p></header>`;
    // Getting started: every setup step, numbered, open ones first, each with why it matters.
    const done = o.checklist.filter((item) => item.done);
    const guided = todo.length * 2 > o.checklist.length
        ? html`<p class="setup-start">New to this? <a class="btn primary" href="${path('/setup')}">Set up Mewvo step by step</a> It goes through the steps below one at a time. <a href="${path('/help')}">What do these words mean?</a></p>`
        : html`<p class="muted"><a href="${path('/setup')}">One step at a time</a> · <a href="${path('/help')}">What do these words mean?</a></p>`;
    const steps = html`${guided}<p class="muted">${done.length} of ${o.checklist.length} done. Each step takes a minute; the link opens the right page.</p>
<ol class="checklist">${todo.map((item) => html`<li><span class="checklist-text"><b>${item.label}</b><br><span class="checklist-hint">${item.hint}</span></span> <a class="setup-link btn small" href="${item.href}">Set up<span class="sr"> ${item.label}</span></a></li>`)}</ol>
${done.length ? html`<p class="muted">Done: ${done.map((item) => item.label).join(', ')}.</p>` : ''}`;
    const note = handover?.text
        ? html`<blockquote class="handover-text">${handover.text}</blockquote><p class="muted">Written by ${handover.byName || handover.by}, ${handover.at ? formatDate(new Date(handover.at)) : ''}</p>`
        : html`<p class="muted">A short message for whoever moderates next, like "keep an eye on #general tonight". Everyone on staff sees it here.</p>`;
    const noteForm = canEditHandover && session?.csrf
        ? html`<form method="post" action="${path('/handover')}" class="settings-form handover-form" data-dirty><input type="hidden" name="csrf" value="${session.csrf}">
<label class="wide">Note<textarea name="text" rows="2" maxlength="1000" placeholder="Keep an eye on #general tonight">${handover?.text || ''}</textarea></label>
<div class="form-actions"><button class="primary" type="submit">Save note</button><span class="hint">To remove the note, empty the box and save.</span></div></form>` : '';
    const body = html`${head}
${flash ? html`<p class="flash" role="status">${flash}</p>` : ''}
${limited || !todo.length ? '' : card('Getting started', steps, { className: 'getting-started' })}
${card('Needs your attention', needsYou(o, { csrf: session?.csrf, canEndLockdown: Boolean(editEnabled && access?.canAct), limited, setupSteps: false }), { note: waiting ? `${waiting}` : null })}
${card('Moderation in the last 7 days', weekChart(o.week), { link: { href: path('/cases'), text: 'See all cases' } })}
${card('Latest moderation', recentFeed(o.recent), { link: { href: path('/cases'), text: 'See all cases' } })}
${card('Note for the next shift', html`${note}${noteForm}`)}
${limited ? '' : recentChangesSection(recentChanges)}`;
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
