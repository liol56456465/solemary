// overview.js — the dashboard's Overview page (read-only), the module on/off states
// for the sidebar, and the read-only display of registry settings.
//
// Every number is gathered separately: one failing source shows "unavailable" and
// never breaks the page.

import { ticketStaffRoleIds } from '../../utils/ticket/staffRoles.js';
import { getGuildConfig } from '../config/guildConfig.js';
import { getWelcomeConfig } from '../../utils/database.js';
import { listPendingAppeals } from '../enforcement/appealService.js';
import { searchCaseRecords } from '../enforcement/caseSearchService.js';
import { findMutedRole } from '../enforcement/muteService.js';
import { formatDuration } from '../enforcement/format.js';
import { query, T } from '../enforcement/db.js';
import { getLockdownState } from '../automod/raidService.js';
import { SETTINGS, neutralValue } from '../settings/settingsRegistry.js';
import {
    getSetting, guildIdFor, isOtherGuild, resolveSetting, resolvedSource, settingGuildId, settingSource,
} from '../settings/guildSettings.js';
import { html, icon, layout, navItems, navLabel, path, raw, timeTag, typeBadge } from './html.js';
import { currentText, dashboardText } from './language.js';
import { moduleEntries, setupByModule } from './modulesPage.js';
import { valueText } from './audit.js';
import { allows } from './permissions.js';
import { botPermissionReport, memberReach, reachOk, rolesToCheck } from './botPermissions.js';
import { LANGUAGES } from '../site/i18n.js';
import { detectedServerLanguage } from '../../utils/botText.js';
import { listPostFailures } from '../automod/postFailures.js';
import { getAppealPanelPosting } from '../enforcement/appealPanelService.js';
import { serverDataCard } from './serverDataPages.js';

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
    getAppealPanelPosting,
    listPostFailures: (guildId, now) => listPostFailures(guildId, now),
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

/**
 * True when this is the home (main) server and a support server is configured: only then do
 * the support-server steps (banned role, appeal panels) apply.
 */
export function hasSupportServer(guildId, env = process.env) {
    const main = guildIdFor('main', env);
    return Boolean(guildId && main && guildId === main && guildIdFor('support', env));
}

/** The moderator role id from the guild config (an id, or { id } from older configs). */
const modRoleIdOf = (value) => (value && typeof value === 'object' ? value.id || null : value || null);

/** The essentials of a checklist (what the progress counts). */
export const essentialSteps = (checklist) => (checklist || []).filter((item) => item.group !== 'optional');
/** The optional steps of a checklist (features a server may not want). */
export const optionalSteps = (checklist) => (checklist || []).filter((item) => item.group === 'optional');

/**
 * The checklist: [{ key, group, label, done, href, hint }], label and hint in the request's
 * language (overview.setup.<key>; `tr` overrides). group 'essential' (what every server needs
 * before members can be moderated safely; the progress counts only these, first) or 'optional'
 * (features a server may not want).
 *   reach         memberReach() result: the role position step (first); null/undefined leaves it out
 *   permissions   botPermissionReport() result; null/undefined (not checkable) leaves the step out
 *   language      { saved, code, detected }: the bot language step; undefined leaves it out
 *   home          one of Mewvo's own servers: appeals go to the Mewvo support server there, so the
 *                 appeals step is the appeals category; elsewhere it is "where members appeal"
 *                 (appealsHome chosen on Enforcement & appeals)
 *   appealPanel   the last appeal panel posting, null = never; undefined (unreadable) leaves it out
 *   supportServer hasSupportServer(): without it the banned role and appeal panel steps are left out
 */
export function gettingStarted({ config, welcome, settings, mutedRole, permissions, reach, language, appealPanel, supportServer = false, home = true }, tr = currentText()) {
    const fallback = settings.modLogChannelId ? ` ${tr.t('overview.setup.fallback')}` : '';
    const appealsCategory = ['appeals', Boolean(settings.appealsCategoryId || config?.ticketCategoryId), '/enforcement'];
    const appealsChosen = Boolean(settings.appealsHomeSaved) && (settings.appealsHome !== 'own' || Boolean(settings.appealsInvite));
    const essential = [
        ...(reach ? [['rolePosition', reachOk(reach), '/setup?step=rolePosition', reachHint(reach, tr)]] : []),
        ...(permissions ? [['permissions', Boolean(permissions.ok), '/setup?step=permissions']] : []),
        ...(language ? [['language', Boolean(language.saved), '/bot-language', languageHint(language, tr)]] : []),
        ['modLog', Boolean(settings.modLogChannelId), '/enforcement'],
        ['logChannel', Boolean(config?.logging?.channels?.audit), '/logging'],
        ['review', Boolean(settings.reviewChannelId), '/automod', fallback],
        home ? appealsCategory : ['appealsHome', appealsChosen, '/enforcement'],
        ...(supportServer && appealPanel !== undefined ? [['appealPanel', Boolean(appealPanel), '/enforcement']] : []),
        ...(supportServer ? [['bannedRole', Boolean(settings.bannedRoleId), '/support']] : []),
    ];
    const optional = [
        // The moderator role is set with the bot settings on the Commands page (its own card).
        ['modRole', Boolean(modRoleIdOf(config?.modRole)), '/commands#s-bot-settings'],
        ['alerts', Boolean(settings.alertsChannelId), '/automod', fallback],
        ['muted', Boolean(settings.mutedRoleId || mutedRole), '/enforcement'],
        ...(home ? [] : [appealsCategory]),
        ['welcome', Boolean(welcome?.enabled && welcome?.channelId), '/welcome'],
        ['ticketCategory', Boolean(config?.ticketCategoryId), '/tickets'],
        ['ticketStaff', ticketStaffRoleIds(config).length > 0, '/tickets'],
        ['verification', Boolean(config?.verification?.enabled), '/verification'],
        // Leveling runs by default; level-up posts wait for an admin (off outside Mewvo's own servers).
        ['leveling', Boolean(config?.leveling), '/leveling'],
        ['birthdays', Boolean(config?.birthdayChannelId), '/birthdays'],
    ];
    const item = (group) => ([key, done, href, more = '']) => ({
        key, group, label: tr.t(`overview.setup.${key}.label`), done, href: path(href),
        hint: more && key !== 'review' && key !== 'alerts' ? more : `${tr.t(`overview.setup.${key}.hint`)}${more}`,
        ...(key === 'permissions' ? { report: permissions } : {}),
        ...(key === 'rolePosition' ? { reach } : {}),
        ...(key === 'language' ? { languageCode: language.saved ? language.code : language.detected || language.code } : {}),
    });
    return [...essential.map(item('essential')), ...optional.map(item('optional'))];
}

const languageNameOf = (code, tr) => LANGUAGES.find((l) => l.code === code)?.name || tr.t('overview.setup.language.english');

/** The language step's line: the saved language, the detected one (not saved yet), or English. */
function languageHint(language, tr) {
    if (language.saved) return tr.t('overview.setup.language.saved', { language: languageNameOf(language.code, tr) });
    if (language.detected && language.detected !== 'en') return tr.t('overview.setup.language.detected', { language: languageNameOf(language.detected, tr) });
    return tr.t('overview.setup.language.hint');
}

/** The role position step's line: how many members Mewvo cannot moderate and which roles. */
export function reachHint(reach, tr) {
    if (!reach || reachOk(reach)) return tr.t('overview.setup.rolePosition.hint');
    return `${reachTitle(reach, tr)}. ${reachFix(reach, tr)}`;
}

/**
 * Nobody counted, but the member cache is incomplete and roles members can hold sit at or above
 * Mewvo's: not verified, so it names those roles instead of saying "all fine".
 */
const rolesAboveOnly = (reach) => Boolean(reach) && reach.count === 0 && !reachOk(reach);

/** "Their top role (@Members) is at or above Mewvo's role. Drag … higher in Server Settings → Roles." */
function reachFix(reach, tr) {
    const botRole = reach.botRole || tr.t('overview.perms.botRoleFallback');
    if (rolesAboveOnly(reach)) return tr.t('overview.perms.rolesAboveFix', { botRole });
    const roles = reach.roles.map((r) => `@${r.name}`).join(', ');
    return tr.t('overview.perms.reachFix', { roles, botRole });
}

/** "12", or "at least 12" when the member cache is incomplete. */
function reachCount(reach, tr) {
    const n = tr.fmtNumber(reach.count);
    return reach.partial ? tr.t('overview.perms.atLeast', { count: n }) : n;
}

/** "Members Mewvo can't moderate: 12" (the row title on the permissions card). */
export function reachTitle(reach, tr) {
    if (rolesAboveOnly(reach)) return tr.t('overview.perms.rolesAbove', { roles: reach.rolesAbove.map((r) => `@${r.name}`).join(', ') });
    return tr.t('overview.perms.reach', { count: reachCount(reach, tr) });
}

/** One registry setting as the dashboard of `guildId` shows it: { guildId (whose row, or null), value, source }. */
function viewedSetting(guildId, entry, env) {
    const owner = settingGuildId(guildId, entry.key, env);
    if (!isOtherGuild(guildId, env)) {
        return { guildId: owner, value: getSetting(owner, entry.key, env), source: settingSource(owner, entry.key, env) };
    }
    if (!owner) return { guildId: null, value: neutralValue(entry), source: 'default' };
    return { guildId: owner, value: resolveSetting(owner, entry.key, env), source: resolvedSource(owner, entry.key, env) };
}

/**
 * The guild settings the checklist looks at (mod log, review, alerts, muted role, appeals category,
 * banned role, warning roles), as the dashboard of `guildId` sees them (home servers: as before).
 */
function setupSettings(guildId, env = process.env) {
    const settings = {};
    for (const key of ['modLogChannelId', 'reviewChannelId', 'alertsChannelId', 'mutedRoleId', 'appealsCategoryId', 'bannedRoleId', 'warnRoleIds', 'appealsInvite']) {
        settings[key] = viewedSetting(guildId, SETTINGS.find((e) => e.key === key), env).value;
    }
    // Chosen on purpose (saved), not just the default: the "where members appeal" and language steps.
    const appealsHome = viewedSetting(guildId, SETTINGS.find((e) => e.key === 'appealsHome'), env);
    settings.appealsHome = appealsHome.value;
    settings.appealsHomeSaved = appealsHome.source === 'database';
    const language = viewedSetting(guildId, SETTINGS.find((e) => e.key === 'botLanguage'), env);
    settings.botLanguage = language.value;
    settings.botLanguageSaved = language.source === 'database';
    return settings;
}

/** The language step's state: saved (and which), else what Mewvo detected from the server's Discord language. */
function languageState(guild, guildId, settings, env = process.env) {
    const detected = isOtherGuild(guildId, env) ? detectedServerLanguage(guildId, { locale: guild?.preferredLocale ?? null }) : null;
    return { saved: Boolean(settings.botLanguageSaved), code: settings.botLanguage || 'en', detected };
}

/** Members Mewvo cannot moderate (role position, member cache only); null = cannot be checked. */
function reachFor(guild) {
    try {
        return memberReach(guild);
    } catch {
        return null;
    }
}

/** Mewvo's permissions for the features that are on (botPermissions.js); null = cannot be checked. */
function permissionsFor(guild, { config, welcome, settings, mutedRole }) {
    try {
        const report = botPermissionReport(guild, {
            moduleStates: config ? moduleStatesFrom(config, welcome) : {},
            roles: rolesToCheck(guild, { mutedRoleId: settings.mutedRoleId, mutedRole, warnRoleIds: settings.warnRoleIds }),
        });
        return report ? { ...report, reach: reachFor(guild) } : null;
    } catch {
        return null;
    }
}

/**
 * Only the Getting-started checklist (Modules page "Set up / Needs setup" lines).
 * null when the guild config could not be read: no line is better than a wrong one.
 */
export async function collectChecklist({ client, guildId, data = defaultOverviewData }) {
    const guild = client.guilds?.cache?.get(guildId) || null;
    const [config, welcome, mutedRole, appealPanel] = await Promise.all([
        attempt(() => data.getGuildConfig(client, guildId)),
        attempt(() => data.getWelcomeConfig(client, guildId)),
        attempt(() => (guild ? data.findMutedRole(guild) : null)),
        attempt(() => data.getAppealPanelPosting(guildId)),
    ]);
    if (config === undefined) return null;
    // Another server's settings not readable (database down): no checklist rather than a wrong one.
    let settings;
    try {
        settings = setupSettings(guildId);
    } catch {
        return null;
    }
    const permissions = permissionsFor(guild, { config, welcome, settings, mutedRole });
    return gettingStarted({
        config, welcome, settings, mutedRole, permissions, reach: permissions?.reach, language: languageState(guild, guildId, settings),
        appealPanel, supportServer: hasSupportServer(guildId), home: !isOtherGuild(guildId),
    });
}

/** Everything the Overview page shows. `data` is injectable for tests. */
export async function collectOverview({ client, guildId, data = defaultOverviewData, now = Date.now() }) {
    const guild = client.guilds?.cache?.get(guildId) || null;
    const dbStatus = client.db?.getStatus?.() || null;
    const [config, welcome, openTickets, sanctions, pending, recent, lockdown, mutedRole, perDay, appealPanel] = await Promise.all([
        attempt(() => data.getGuildConfig(client, guildId)),
        attempt(() => data.getWelcomeConfig(client, guildId)),
        attempt(() => data.countOpenTickets(guildId)),
        attempt(() => data.countActiveSanctions(guildId)),
        attempt(() => data.listPendingAppeals(PENDING_APPEALS_CAP, guildId)),
        attempt(() => data.searchCaseRecords(guildId, {}, { page: 0, pageSize: 10 })),
        attempt(() => data.getLockdownState(guildId)),
        attempt(() => (guild ? data.findMutedRole(guild) : null)),
        attempt(() => data.casesPerDay(guildId, 7)),
        attempt(() => data.getAppealPanelPosting(guildId)),
    ]);
    const postFailures = (await attempt(() => data.listPostFailures(guildId, now))) || [];
    // Joined this week: only when the member cache holds (nearly) everyone; otherwise unknown.
    const members = guild?.members?.cache;
    const joinedThisWeek = members && guild.memberCount && members.size >= guild.memberCount * 0.9
        ? [...members.values()].filter((m) => m.joinedTimestamp && m.joinedTimestamp >= now - 7 * 86_400_000).length
        : null;
    const presences = guild?.presences?.cache;
    const online = presences && presences.size > 0
        ? [...presences.values()].filter((p) => p.status && p.status !== 'offline').length
        : null;
    const settings = setupSettings(guildId);
    const permissions = permissionsFor(guild, { config, welcome, settings, mutedRole });
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
        checklist: gettingStarted({
            config, welcome, settings, mutedRole, permissions, reach: permissions?.reach, language: languageState(guild, guildId, settings),
            appealPanel, supportServer: hasSupportServer(guildId), home: !isOtherGuild(guildId),
        }),
        permissions,
        postFailures: Array.isArray(postFailures)
            ? postFailures.map((f) => ({ ...f, channelName: guild?.channels?.cache?.get(f.channelId)?.name || f.channelName || null }))
            : [],
        moduleStates: moduleStatesFrom(config, welcome),
    };
}

const show = (value, text = value, tr = currentText()) => (value === undefined ? html`<span class="muted">${tr.t('overview.unavailable')}</span>` : text);

/** The newest dashboard changes (audit rows): who, which module and setting, old → new, when. */
function recentChangesSection(rows, tr) {
    const t = (key, params) => tr.t(`overview.${key}`, params);
    const link = { href: path('/audit'), text: t('cards.fullAudit') };
    if (rows === null) return card(t('cards.changes'), html`<p class="muted">${t('changes.failed')}</p>`, { className: 'ov-full' });
    const label = (key) => { const item = navItems().find((i) => i.key === key); return item ? navLabel(item, tr) : key; };
    const list = rows.length ? html`<div class="scroll"><table><thead><tr><th>${t('table.when')}</th><th>${t('table.who')}</th><th>${t('table.page')}</th><th>${t('table.setting')}</th><th>${t('table.old')}</th><th>${t('table.new')}</th></tr></thead><tbody>${rows.map((r) => html`<tr>
<td>${timeTag(r.created_at)}</td><td>${r.username || r.user_id || t('table.someone')}</td><td>${navItems().some((i) => i.key === r.module) ? html`<a href="${path(`/${r.module}`)}">${label(r.module)}</a>` : label(r.module)}</td>
<td><code>${r.key}</code></td><td class="value muted">${valueText(r.old)}</td><td class="value">${valueText(r.new)}</td></tr>`)}</tbody></table></div>`
        : html`<p class="empty">${t('changes.empty')}</p>`;
    return card(t('cards.changes'), list, { link: rows.length ? link : null, className: 'ov-full' });
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
function weekChart(week, tr) {
    const t = (key, params) => tr.t(`overview.${key}`, params);
    if (week === undefined) return html`<p class="error" role="alert">${t('chart.failed')}</p>`;
    const max = Math.max(1, ...week.map((d) => d.count));
    const total = week.reduce((sum, d) => sum + d.count, 0);
    // weekSeries gives English day names; other languages name the day themselves.
    const dayLabel = (d) => (d.today ? t('chart.today') : tr.lang === 'en' ? d.label : tr.weekday(new Date(`${d.day}T00:00:00Z`)));
    const summary = week.map((d) => `${dayLabel(d)} ${tr.fmtNumber(d.count)}`).join(', ');
    return html`<div class="chart" role="img" aria-label="${t('chart.label', { summary })}">${week.map((d) => html`<div class="bar${d.today ? ' today' : ''}"><span class="bar-count">${tr.fmtNumber(d.count)}</span><i class="h-${Math.round((d.count / max) * 10)}"></i><span class="bar-label">${dayLabel(d)}</span></div>`)}</div>
<p class="kpi-sub">${tr.tp('overview.chart.total', total)}</p>`;
}

/** Recent enforcement actions as a table. */
function recentFeed(recent, tr) {
    const t = (key, params) => tr.t(`overview.${key}`, params);
    if (recent === undefined) return html`<p class="error" role="alert">${t('feed.failed')}</p>`;
    if (!recent.length) return html`<p class="empty">${t('feed.empty')}</p>`;
    return html`<div class="scroll"><table class="feed-table"><thead><tr><th>${t('table.when')}</th><th>${t('table.action')}</th><th>${t('table.member')}</th><th>${t('table.by')}</th><th>${t('table.reason')}</th><th>${t('table.case')}</th></tr></thead><tbody>${recent.slice(0, 8).map((row) => html`<tr><td>${timeTag(row.created_at)}</td><td>${typeBadge(row.type)}${row.is_test ? html` <span class="muted">${t('table.test')}</span>` : ''}</td><td>${row.target_username}</td><td>${row.moderator_username}</td><td>${row.reason}</td><td><a href="${path(`/cases/${encodeURIComponent(row.case_code)}`)}"><code>${row.case_code}</code></a></td></tr>`)}</tbody></table></div>`;
}

/**
 * "Mewvo's permissions" (botPermissions.js report): every server permission the features that are on
 * need, ✓ or missing with one line on how to fix it, then the roles Mewvo must sit above.
 * Read-only. Also the first step of Setup step by step (helpPages.js).
 */
export function permissionsList(report, tr = currentText()) {
    const t = (key, params) => tr.t(`overview.perms.${key}`, params);
    if (!report) return html`<p class="muted">${t('cannotCheck')}</p>`;
    const botRole = report.botRole || t('botRoleFallback');
    const name = (perm) => t(`perm.${perm}`);
    const features = (keys) => keys.map((key) => t(`feature.${key}`)).join(', ');
    const missing = report.permissions.filter((p) => !p.ok);
    const granted = report.permissions.filter((p) => p.ok);
    const roleRows = report.roles.map((r) => html`<li class="perm-row is-missing">${icon('warn')}<span class="checklist-text"><b>${t('roleAbove', { role: r.name })}</b><span class="checklist-hint">${t('roleAboveFix', { botRole, role: r.name })}</span></span></li>`);
    const row = (p) => html`<li class="perm-row${p.ok ? ' is-ok' : ' is-missing'}">${icon(p.ok ? 'check' : 'warn')}<span class="checklist-text"><b>${name(p.name)}</b> <span class="${p.ok ? 'ok-text' : 'bad'}">${t(p.ok ? 'on' : 'missing')}</span><span class="checklist-hint">${p.ok
        ? t('usedBy', { list: features(p.features) })
        : t('fix', { role: botRole, perm: name(p.name), list: features(p.features) })}</span></span></li>`;
    // Role position: members whose top role is at or above Mewvo's (member cache only, botPermissions.js memberReach).
    const reach = report.reach && !reachOk(report.reach) ? report.reach : null;
    const reachRow = reach
        ? html`<li class="perm-row is-missing">${icon('warn')}<span class="checklist-text"><b>${reachTitle(reach, tr)}</b><span class="checklist-hint">${reachFix(reach, tr)}</span></span></li>`
        : '';
    const allOk = report.ok && !reach;
    const summary = allOk
        ? html`<p class="ok-text">${t('allOk')}</p>`
        : html`<p class="bad">${t('someMissing', { count: tr.fmtNumber(missing.length + report.roles.length + (reach ? 1 : 0)) })}</p>`;
    const intro = html`<p class="muted">${t('intro')}</p>`;
    // The problems stay in view; what is already on folds away.
    const fine = granted.length
        ? html`<details class="sub" data-key="bot-perms"><summary>${t('showList')}</summary>${allOk ? intro : ''}<ul class="checklist perm-list">${granted.map(row)}</ul></details>`
        : '';
    return allOk ? html`${summary}${fine}` : html`${summary}${intro}<ul class="checklist perm-list">${reachRow}${roleRows}${missing.map(row)}</ul>${fine}`;
}

/** The fix page for a failed staff post's purpose (where its channel is picked). */
const FAILURE_PAGE = { modlog: '/enforcement', alerts: '/automod', review: '/automod' };

/** "Mewvo couldn't post to #mod-log: missing Send Messages (3 times today)" lines for Needs you. */
function postFailureItems(failures, tr) {
    const t = (key, params) => tr.t(`overview.needs.postFailed.${key}`, params);
    return (failures || []).slice(0, 5).map((f) => {
        const purpose = f.purpose === 'alerts' ? 'alerts' : 'modlog';
        const channel = f.channelName || f.channelId || '';
        const perms = (f.missing || []).map((perm) => tr.t(`overview.perms.perm.${perm}`)).join(', ');
        const title = f.reason === 'notSet' ? t(`notSet.${purpose}`)
            : f.reason === 'missing' ? t('missing', { channel })
                : f.reason === 'perms' && perms ? t('perms', { channel, perms })
                    : t('refused', { channel });
        const fix = f.reason === 'perms' ? t('fixPerms') : f.reason === 'other' ? t('fixOther') : t('fixChannel');
        return html`<li><span class="what"><b>${title}</b><small>${tr.tp('overview.needs.postFailed.times', f.count)} ${fix}</small></span><span></span><a class="btn small" href="${path(FAILURE_PAGE[f.purpose] || '/enforcement')}">${t('fixIt')}<span class="sr"> ${title}</span></a></li>`;
    });
}

/**
 * "Needs you": what waits for an admin, oldest first, each with one button: pending appeals,
 * open tickets, an active raid lockdown, and the next open setup steps.
 */
function needsYou(o, { csrf = '', canEndLockdown = false, limited = false, setupSteps = true } = {}, tr = currentText()) {
    const t = (key, params) => tr.t(`overview.needs.${key}`, params);
    const items = [];
    if (o.lockdown?.active) {
        // Administrators end it right here (POST /automod/lockdown-end, back to the Overview); others get the link.
        const endButton = canEndLockdown && csrf
            ? html`<form method="post" action="${path('/automod/lockdown-end')}" class="inline-form" data-confirm="${t('endConfirm')}"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="back" value="overview"><button type="submit" class="btn small danger">${t('endLockdown')}</button></form>`
            : limited ? '' : html`<a class="btn primary small" href="${path('/automod')}">${navLabel({ key: 'automod' }, tr)}</a>`;
        items.push(html`<li><span class="what"><b>${t('lockdown')}</b><small>${o.lockdown.since ? t('since', { date: tr.fmtDateTime(o.lockdown.since) }) : t('heldAtDoor')}</small></span><span></span>${endButton}</li>`);
    }
    // Staff posts Mewvo could not make today (postFailures.js); fixing them is Administrator work.
    if (!limited) items.push(...postFailureItems(o.postFailures, tr));
    const TYPED = new Set(['ban', 'kick', 'mute', 'warn']);
    for (const appeal of o.pendingList || []) {
        const title = TYPED.has(appeal.type) ? t(`typedAppealFrom.${appeal.type}`, { name: appeal.username }) : t('appealFrom', { name: appeal.username });
        items.push(html`<li><span class="what"><b>${title}</b><small>${tr.ti('overview.needs.case', { code: html`<code>${appeal.case_code}</code>` })}${appeal.name ? ` · ${appeal.name}` : ''}${appeal.is_test ? ` · ${t('testCase')}` : ''}</small></span>${timeTag(appeal.created_at)}<a class="btn primary small" href="${path(`/appeals/${encodeURIComponent(appeal.case_code)}`)}">${t('review')}<span class="sr"> ${t('reviewLabel', { code: appeal.case_code })}</span></a></li>`);
    }
    if (o.pendingAppeals > (o.pendingList || []).length) {
        items.push(html`<li><span class="what"><b>${tr.tp('overview.needs.moreAppeals', o.pendingAppeals - o.pendingList.length)}</b></span><span></span><a class="btn small" href="${path('/appeals')}">${t('allAppeals')}</a></li>`);
    }
    if (o.openTickets > 0 && !limited) {
        items.push(html`<li><span class="what"><b>${tr.tp('overview.needs.openTickets', o.openTickets)}</b><small>${t('ticketsWhere')}</small></span><span></span><a class="btn small" href="${path('/tickets')}">${t('tickets')}</a></li>`);
    }
    for (const step of limited || !setupSteps ? [] : o.checklist.filter((item) => !item.done).slice(0, 2)) {
        items.push(html`<li><span class="what"><b>${t('setUpStep', { label: step.label })}</b>${step.hint ? html`<small>${step.hint}</small>` : ''}</span><span></span><a class="btn small" href="${step.href}">${t('setUp')}<span class="sr"> ${step.label}</span></a></li>`);
    }
    const failed = o.pendingAppeals === undefined || o.openTickets === undefined;
    const list = items.length
        ? html`<ul class="plain queue">${items}</ul>`
        : html`<p class="empty">${t('empty')}</p>`;
    return html`${failed ? html`<p class="error" role="alert">${t('failed')}</p>` : ''}${list}`;
}

/**
 * An Overview card (v6): bold title (with an optional count) and an optional link on the
 * right, then its content. `className` places it in the grid (ov-wide: two columns, ov-full: the row).
 */
function card(title, body, { link = null, note = null, className = '' } = {}) {
    return html`<section class="tile-card ov-card${className ? ` ${className}` : ''}"><header class="card-top card-top-row"><h2>${title}${note ? html` <span class="muted">(${note})</span>` : ''}</h2>${link ? html`<a class="card-link" href="${link.href}">${link.text}</a>` : ''}</header><div class="section-body">${body}</div></section>`;
}

/** One number tile: label, the number (a link when `href`), one line under it. `undefined` = could not be read. */
function stat(label, value, sub = '', { href = null } = {}, tr = currentText()) {
    const number = value === undefined ? html`<span class="stat-value is-unknown">${tr.t('overview.unavailable')}</span>`
        : href ? html`<a class="stat-value" href="${href}">${value}</a>` : html`<span class="stat-value">${value}</span>`;
    return html`<div class="stat"><p class="stat-label">${label}</p>${number}${sub ? html`<p class="stat-sub">${sub}</p>` : ''}</div>`;
}

// Quick links: the pages staff open most, each with one plain line (only the ones this level may open).
// The line under each: overview.quick.<key>.
const QUICK_LINKS = ['cases', 'users', 'appeals', 'inbox', 'automod', 'enforcement', 'audit', 'modules'];

/** The Overview page (v6, cards) from collectOverview's result (+ the newest audit rows; null = audit store unavailable). */
export function overviewPage({ session, access = null, moduleStates = {}, overview: o, recentChanges = [], editEnabled = false, handover = null, canEditHandover = false, flash = null, serverData = null }) {
    // Moderator level (permissions.js): no setup, modules, tickets or audit parts (those pages are Administrator-only).
    const tr = dashboardText(session?.lang);
    const t = (key, params) => tr.t(`overview.${key}`, params);
    const limited = Boolean(access?.allowed) && !allows(access, 'page:modules');
    const todo = o.checklist.filter((item) => !item.done);
    const pendingText = o.pendingAppeals >= PENDING_APPEALS_CAP ? `${tr.fmtNumber(PENDING_APPEALS_CAP)}+` : tr.fmtNumber(o.pendingAppeals);
    const server = session?.server;
    const name = o.guild?.name || server?.name || t('yourServer');
    const failures = limited ? 0 : Math.min(5, (o.postFailures || []).length);
    const waiting = (o.pendingAppeals || 0) + (o.openTickets || 0) + (o.lockdown?.active ? 1 : 0) + failures;
    const healthy = o.bot.ready && (!o.database || o.database.connected);
    const status = !o.bot.ready ? t('status.offline')
        : o.database && !o.database.connected ? t('status.dbDown')
            : t('status.ok');
    const automodWord = Object.hasOwn(moduleStates, 'automod') ? ` ${t(moduleStates.automod ? 'status.automodOn' : 'status.automodOff')}` : '';
    const head = html`<header class="page-head"><h1>${navLabel({ key: 'overview' }, tr)}</h1>
<p class="facts-line">${name}. <span class="${healthy ? 'ok-text' : 'bad'}">${status}</span>${automodWord}${o.lockdown?.active ? html` <span class="bad">${t('status.lockdown')}</span>` : ''}</p></header>`;
    // The numbers, as four tiles (a word instead of a number when a source failed).
    const num = (value) => (value === undefined ? undefined : tr.fmtNumber(value));
    const members = o.guild?.memberCount != null ? o.guild.memberCount : undefined;
    const stats = html`<div class="stat-grid">
${stat(t('stats.members'), num(members), o.joinedThisWeek != null ? t('stats.joined', { count: tr.fmtNumber(o.joinedThisWeek) }) : '', {}, tr)}
${stat(t('stats.banned'), num(o.activeBans), o.activeMutes === undefined ? '' : t('stats.muted', { count: tr.fmtNumber(o.activeMutes) }), { href: path('/cases?status=active') }, tr)}
${stat(t('stats.appeals'), o.pendingAppeals === undefined ? undefined : pendingText, o.pendingAppeals === undefined ? '' : o.pendingAppeals ? t('stats.appealsOldest') : t('stats.appealsNone'), { href: path('/appeals') }, tr)}
${stat(t('stats.tickets'), num(o.openTickets), limited ? '' : t('stats.ticketsWhere'), {}, tr)}</div>`;
    // Getting started: the essentials first (the progress counts only these), then the optional
    // features; open steps listed with why they matter, done ones in one line per group.
    const essentials = essentialSteps(o.checklist);
    const optional = optionalSteps(o.checklist);
    const essentialTodo = essentials.filter((item) => !item.done);
    const guided = essentialTodo.length * 2 > essentials.length
        ? html`<p class="setup-start">${t('start.new')} <a class="btn primary" href="${path('/setup')}">${t('start.button')}</a> ${t('start.after')} <a href="${path('/help')}">${t('start.words')}</a></p>`
        : html`<p class="muted"><a href="${path('/setup')}">${t('start.oneStep')}</a> · <a href="${path('/help')}">${t('start.words')}</a></p>`;
    const stepList = (items) => html`<ol class="checklist">${items.map((item) => html`<li><span class="checklist-text"><b>${item.label}</b><br><span class="checklist-hint">${item.hint}</span></span> <a class="setup-link btn small" href="${item.href}">${t('needs.setUp')}<span class="sr"> ${item.label}</span></a></li>`)}</ol>`;
    const doneLine = (items) => (items.length ? html`<p class="muted">${t('start.done', { list: items.map((item) => item.label).join(', ') })}</p>` : '');
    const group = (title, line, items) => {
        const open = items.filter((item) => !item.done);
        const finished = items.filter((item) => item.done);
        if (!items.length) return '';
        return html`<h3 class="checklist-group">${title}</h3><p class="muted">${line}</p>${open.length ? stepList(open) : ''}${doneLine(finished)}`;
    };
    const steps = html`${guided}<p class="muted">${t('start.progress', { done: tr.fmtNumber(essentials.length - essentialTodo.length), total: tr.fmtNumber(essentials.length) })}</p>
${group(t('start.essentials'), t('start.essentialsLine'), essentials)}
${group(t('start.optional'), t('start.optionalLine'), optional)}`;
    const note = handover?.text
        ? html`<blockquote class="handover-text">${handover.text}</blockquote><p class="muted">${t('handover.writtenBy', { name: handover.byName || handover.by, date: handover.at ? tr.fmtDateTime(new Date(handover.at)) : '' })}</p>`
        : html`<p class="muted">${tr.tx('overview.handover.empty')}</p>`;
    const noteForm = canEditHandover && session?.csrf
        ? html`<form method="post" action="${path('/handover')}" class="settings-form handover-form" data-dirty><input type="hidden" name="csrf" value="${session.csrf}">
<label class="wide">${t('handover.label')}<textarea name="text" rows="2" maxlength="1000" placeholder="${t('handover.placeholder')}">${handover?.text || ''}</textarea></label>
<div class="form-actions"><button class="primary" type="submit"${tr.lang === 'en' ? '' : raw(' data-save')}>${t('handover.save')}</button><span class="hint">${t('handover.hint')}</span></div></form>` : '';
    const links = QUICK_LINKS.map((key) => navItems().find((i) => i.key === key))
        .filter((item) => item && (!access?.allowed || allows(access, `page:${item.key}`)));
    const quick = html`<ul class="quick-links">${links.map((item) => html`<li><a href="${path(`/${item.key}`)}">${navLabel(item, tr)}</a><span>${t(`quick.${item.key}`)}</span></li>`)}</ul>`;
    // Rows pair cards of similar height: Needs you + the note, Getting started + the links, the chart + the
    // latest cases. The grid fills holes (dense), so narrow cards still pair up on two columns.
    // Mewvo's permissions (Administrator levels only: moderators cannot change roles): first when
    // something is missing, else further down.
    const permsMissing = o.permissions ? o.permissions.missing.length + o.permissions.roles.length + (o.permissions.reach && !reachOk(o.permissions.reach) ? 1 : 0) : 0;
    const permsCard = limited || o.permissions === undefined ? ''
        : card(t('perms.title'), permissionsList(o.permissions, tr), { note: permsMissing ? tr.fmtNumber(permsMissing) : null, className: 'ov-wide bot-perms' });
    const body = html`${head}
${flash ? html`<p class="flash" role="status">${flash}</p>` : ''}
${stats}
<div class="ov-grid">
${permsMissing ? permsCard : ''}
${card(t('cards.needs'), needsYou(o, { csrf: session?.csrf, canEndLockdown: Boolean(editEnabled && access?.canAct), limited, setupSteps: false }, tr), { note: waiting ? tr.fmtNumber(waiting) : null, className: 'ov-wide needs-you' })}
${card(t('cards.note'), html`${note}${noteForm}`)}
${limited || !todo.length ? '' : card(t('cards.start'), steps, { className: 'ov-wide getting-started' })}
${links.length ? card(t('cards.goTo'), quick, { className: 'ov-links' }) : ''}
${permsMissing ? '' : permsCard}
${card(t('cards.week'), weekChart(o.week, tr))}
${card(t('cards.latest'), recentFeed(o.recent, tr), { link: { href: path('/cases'), text: t('cards.allCases') }, className: 'ov-wide' })}
${limited ? '' : recentChangesSection(recentChanges, tr)}
${serverDataCard(serverData, { csrf: session?.csrf, tr })}
</div>`;
    return layout({ title: navLabel({ key: 'overview' }, tr), active: 'overview', session, access, moduleStates, body, lang: tr.lang });
}

// ── Registry settings, read-only ──────────────────────────────────────────

function resolveId(client, guildId, kind, id) {
    const guild = client.guilds?.cache?.get(guildId);
    if (kind === 'role') {
        const role = guild?.roles?.cache?.get(id);
        return role ? html`@${role.name} <span class="muted">${id}</span>` : html`<span class="warn">${currentText().t('overview.value.notFound', { id })}</span>`;
    }
    const channel = guild?.channels?.cache?.get(id);
    return channel ? html`#${channel.name} <span class="muted">${id}</span>` : html`<span class="warn">${currentText().t('overview.value.notFound', { id })}</span>`;
}

function displayValue(client, guildId, entry, value) {
    const tr = currentText();
    if (entry.sensitive) return html`<span class="muted">${tr.t('overview.value.hidden')}</span>`;
    if (value === null || value === undefined || value === '') return html`<span class="muted">${tr.t('overview.value.notSet')}</span>`;
    switch (entry.kind) {
        case 'channel': case 'category': case 'role':
            return resolveId(client, guildId, entry.kind === 'role' ? 'role' : 'channel', value);
        case 'list':
            if (!value.length) return html`<span class="muted">${tr.t('overview.value.none')}</span>`;
            if (entry.itemKind === 'string') return tr.tp('overview.value.words', value.length);
            return value.map((id, i) => html`${i ? ', ' : ''}${resolveId(client, guildId, entry.itemKind, id)}`);
        case 'duration':
            return formatDuration(Number(value));
        case 'boolean':
            return tr.t(value ? 'overview.value.on' : 'overview.value.off');
        case 'json':
            return entry.describe ? entry.describe(value) : tr.t('overview.value.set');
        default:
            return `${value}${entry.unit ? ` ${entry.unit}` : ''}`;
    }
}

/**
 * Rows for settingsSection(): every registry setting of a module, with its current value and
 * source, as the dashboard of `guildId` (default: the main server) sees it.
 */
export function settingsRowsFor(client, module, guildId = guildIdFor('main'), env = process.env) {
    return SETTINGS.filter((entry) => entry.module === module).map((entry) => {
        const viewed = viewedSetting(guildId, entry, env);
        return {
            key: entry.key,
            label: entry.label,
            display: displayValue(client, viewed.guildId, entry, viewed.value),
            source: viewed.source,
        };
    });
}
