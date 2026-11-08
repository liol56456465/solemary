// ownerPages.js — the Owner area pages (bot owners only): overview, bot profile, servers,
// server detail, leave confirm, user lookup, blacklist, health and maintenance, command sync
// (compare + re-register confirm), announce (compose, confirm, result), activity (the owner
// audit rows). Pure: data in, HTML out, everything escaped by the `html` template. No inline
// styles or scripts (CSP).

import { formatDate, html, layout, path, queryString, timeTag } from './html.js';
import { currentText, dashboardText } from './language.js';
import { actionForm, confirmButtons } from './enforcementPages.js';
import { auditValue, isAllowedImageUrl } from './pages.js';
import { kpi, tile } from './overview.js';
import { ACTIVITY_TEXT_MAX, STATUSES } from '../owner/botStateService.js';
import { BLACKLIST_REASON_MAX } from '../owner/blacklistService.js';
import { countedWarnsText } from '../enforcement/flowBuilder.js';
import {
    KEY_DURATIONS, KEY_VALIDITY, MAX_KEYS_PER_BATCH, NOTE_MAX, PAID_PLANS, PERIODS, keyStatus, orderCurrency, planName,
} from '../billing/premiumService.js';
import { euros, formatPrice } from '../../config/site/plans.js';

export const USERNAME_MAX = 32;
export const ABOUT_MAX = 400;
export const ANNOUNCE_MAX = 2000;
const STATUS_LABEL = { online: 'owner.profile.statusOnline', idle: 'owner.profile.statusIdle', dnd: 'owner.profile.statusDnd', invisible: 'owner.profile.statusInvisible' };
const ACTIVITY_LABEL = { none: 'owner.profile.activityNone', playing: 'owner.profile.activityPlaying', listening: 'owner.profile.activityListening', watching: 'owner.profile.activityWatching', competing: 'owner.profile.activityCompeting', custom: 'owner.profile.activityCustom' };

function shell({ title, active, session, access, moduleStates, body }) {
    return layout({ title, active, session, access, moduleStates, body });
}

function notices({ flash = null, error = null, editEnabled = true }) {
    return html`${flash ? html`<p class="flash" role="status">${flash}</p>` : ''}
${error ? html`<p class="error" role="alert">${error}</p>` : ''}
${!editEnabled ? html`<p class="notice">${currentText().t('owner.common.readOnly')}</p>` : ''}`;
}

const opt = (value, label, current) => html`<option value="${value}"${value === current ? html` selected` : ''}>${label}</option>`;
const img = (url, alt, size, className = 'avatar-sm') => (url && isAllowedImageUrl(url)
    ? html`<img class="${className}" src="${url}" alt="${alt}" width="${size}" height="${size}" loading="lazy" referrerpolicy="no-referrer">` : '');
const stateWord = (tone, label) => html`<span class="state-word is-${tone}"><span class="dot dot-${tone}" aria-hidden="true"></span>${label}</span>`;

// ── Bot profile ───────────────────────────────────────────────────────────

/** profile: { username, id, avatarUrl, bannerUrl, about, presence: { status, activityType, activityText } }. */
export function profilePage({ session, access = null, moduleStates = {}, profile, flash = null, error = null, editEnabled = true }) {
    const csrf = session.csrf;
    const tr = dashboardText(session?.lang);
    const p = profile.presence || { status: 'online', activityType: 'none', activityText: '' };
    const imageForm = (kind, label) => actionForm(csrf, `/owner/profile/${kind}`, html`<div class="grid">
<label class="wide">${tr.t('owner.profile.imageUrl')}<input name="url" type="url" maxlength="500" placeholder="https://…"></label>
<label class="wide">${tr.t('owner.profile.upload')}<input type="file" name="image" accept="image/png,image/jpeg,image/gif,image/webp"></label></div>`,
    { submit: label, multipart: true, enabled: editEnabled });
    const body = html`<header class="page-head"><h1>${tr.t('owner.profile.title')}</h1><p class="muted">${tr.t('owner.profile.help')}</p></header>
${notices({ flash, error, editEnabled })}
<section class="card"><h2>${tr.t('owner.profile.now')}</h2><dl>
<dt>${tr.t('owner.profile.username')}</dt><dd>${profile.username || '-'} <span class="muted">${profile.id || ''}</span></dd>
<dt>${tr.t('owner.profile.avatar')}</dt><dd>${img(profile.avatarUrl, tr.t('owner.profile.currentAvatar'), 64) || html`<span class="muted">${tr.t('owner.profile.default')}</span>`}</dd>
<dt>${tr.t('owner.profile.banner')}</dt><dd>${profile.bannerUrl && isAllowedImageUrl(profile.bannerUrl) ? html`<img src="${profile.bannerUrl}" alt="${tr.t('owner.profile.currentBanner')}" width="300" height="106" loading="lazy" referrerpolicy="no-referrer">` : html`<span class="muted">${tr.t('owner.common.none')}</span>`}</dd>
<dt>${tr.t('owner.profile.about')}</dt><dd>${profile.about || html`<span class="muted">${tr.t('owner.profile.empty')}</span>`}</dd>
<dt>${tr.t('owner.profile.status')}</dt><dd>${STATUS_LABEL[p.status] ? tr.t(STATUS_LABEL[p.status]) : p.status}${p.activityType && p.activityType !== 'none' ? html` · ${ACTIVITY_LABEL[p.activityType] ? tr.t(ACTIVITY_LABEL[p.activityType]) : p.activityType} ${p.activityText}` : ''}</dd>
</dl></section>
<section class="card"><h2>${tr.t('owner.profile.username')}</h2>${actionForm(csrf, '/owner/profile/username', html`<label class="wide">${tr.t('owner.profile.newUsername')}<input name="username" maxlength="${USERNAME_MAX}" minlength="2" required value="${profile.username || ''}"></label>`, { submit: tr.t('owner.profile.changeUsername'), enabled: editEnabled })}
<p class="muted">${tr.t('owner.profile.usernameLimit')}</p></section>
<section class="card"><h2>${tr.t('owner.profile.avatar')}</h2>${imageForm('avatar', tr.t('owner.profile.changeAvatar'))}</section>
<section class="card"><h2>${tr.t('owner.profile.banner')}</h2>${imageForm('banner', tr.t('owner.profile.changeBanner'))}</section>
<section class="card"><h2>${tr.t('owner.profile.about')}</h2>${actionForm(csrf, '/owner/profile/about', html`<label class="wide">${tr.t('owner.profile.aboutLabel')}<textarea name="about" maxlength="${ABOUT_MAX}" rows="4">${profile.about || ''}</textarea></label>`, { submit: tr.t('owner.profile.saveAbout'), enabled: editEnabled })}</section>
<section class="card"><h2>${tr.t('owner.profile.statusActivity')}</h2>${actionForm(csrf, '/owner/profile/presence', html`<div class="grid">
<label>${tr.t('owner.profile.status')}<select name="status">${STATUSES.map((s) => opt(s, tr.t(STATUS_LABEL[s]), p.status))}</select></label>
<label>${tr.t('owner.profile.activity')}<select name="activityType">${Object.keys(ACTIVITY_LABEL).map((k) => opt(k, tr.t(ACTIVITY_LABEL[k]), p.activityType || 'none'))}</select></label>
<label class="wide">${tr.t('owner.profile.activityText')}<input name="activityText" maxlength="${ACTIVITY_TEXT_MAX}" value="${p.activityText || ''}"></label></div>`, { submit: tr.t('owner.profile.saveStatus'), enabled: editEnabled })}
<p class="muted">${tr.t('owner.common.keptAfterRestart')}</p></section>`;
    return shell({ title: tr.t('owner.profile.title'), active: 'owner/profile', session, access, moduleStates, body });
}

// ── Servers ───────────────────────────────────────────────────────────────

export const SERVER_SORTS = { name: 'Name', members: 'Most members', newest: 'Joined most recently', oldest: 'Joined first' };
const TAG_TONE = { Main: 'on', Support: 'on', Blacklisted: 'bad' };
const serverTags = (tags = []) => tags.map((t) => html` <span class="state-word is-${TAG_TONE[t] || 'off'}"><span class="dot dot-${TAG_TONE[t] || 'off'}" aria-hidden="true"></span>${TAG_TONE[t] ? currentText().t(`owner.servers.tag${t}`) : t}</span>`);
/**
 * rows: [{ id, name, iconUrl, ownerId, ownerName, memberCount, joinedAt, tags }]; totals: { servers,
 * members, joinedWeek } over every server (not only the matching ones).
 */
export function serversPage({ session, access = null, moduleStates = {}, rows = [], total = rows.length, totals = null, q = '', sort = 'name', flash = null }) {
    const tr = dashboardText(session?.lang);
    const table = rows.length ? html`<div class="table-wrap"><table class="members"><thead><tr><th>${tr.t('owner.common.server')}</th><th>${tr.t('owner.servers.owner')}</th><th>${tr.t('owner.common.members')}</th><th>${tr.t('owner.servers.botJoined')}</th></tr></thead><tbody>
${rows.map((row) => html`<tr><td><a class="member-cell" href="${path(`/owner/servers/${row.id}`)}">${img(row.iconUrl, '', 32) || ''}<span><b>${row.name}</b>${serverTags(row.tags)}<small>${row.id}</small></span></a></td>
<td>${row.ownerName || html`<span class="muted">${tr.t('owner.common.unknown')}</span>`}<br><small class="muted">${row.ownerId || '-'}</small></td>
<td>${row.memberCount ?? '-'}</td><td>${formatDate(row.joinedAt)}</td></tr>`)}
</tbody></table></div>` : html`<p class="empty">${q ? tr.t('owner.servers.noMatch') : tr.t('owner.servers.noServers')}</p>`;
    const summary = totals
        ? tr.t('owner.servers.summary', { servers: tr.tp('owner.servers.count', totals.servers), members: tr.fmtNumber(totals.members), week: tr.fmtNumber(totals.joinedWeek) })
        : tr.t('owner.servers.summaryShort', { total: tr.fmtNumber(total) });
    const body = html`<header class="page-head"><h1>${tr.t('owner.servers.title')}</h1><p class="muted">${summary}</p></header>
${flash ? html`<p class="flash" role="status">${flash}</p>` : ''}
<form class="filters" method="get" action="${path('/owner/servers')}" role="search"><label class="wide-filter">${tr.t('owner.servers.search')}<input type="search" name="q" value="${q}" maxlength="100" autocomplete="off" placeholder="${tr.t('owner.servers.searchPlaceholder')}"></label>
<label>${tr.t('owner.servers.sort')}<select name="sort">${Object.keys(SERVER_SORTS).map((key) => opt(key, tr.t(`owner.servers.sort_${key}`), sort))}</select></label>
<button class="primary" type="submit">${tr.t('owner.servers.show')}</button> <a href="${path('/owner/servers')}">${tr.t('owner.common.clear')}</a></form>
${rows.length < total ? html`<p class="muted">${tr.t('owner.servers.showing', { shown: tr.fmtNumber(rows.length), total: tr.fmtNumber(total) })}</p>` : ''}${table}`;
    return shell({ title: tr.t('owner.servers.title'), active: 'owner/servers', session, access, moduleStates, body });
}

/**
 * detail: { id, name, iconUrl, ownerId, ownerName, memberCount, joinedAt, channels: [{ name,
 * type, category }], roles: [{ name, color, members }], permissions: [string], missing: [{ label, why }],
 * botTop: { name, position } | null, rolesAbove: [{ name, why }], vanityUrl, canCreateInvite, canLeave,
 * membersCached }.
 */
export function serverPage({ session, access = null, moduleStates = {}, detail, flash = null, error = null, editEnabled = true }) {
    const csrf = session.csrf;
    const tr = dashboardText(session?.lang);
    const inviteBits = [
        detail.vanityUrl ? html`<p>${tr.t('owner.server.vanity')} <a href="${detail.vanityUrl}" rel="noopener noreferrer nofollow" target="_blank">${detail.vanityUrl}</a></p>` : '',
        detail.canCreateInvite ? actionForm(csrf, `/owner/servers/${detail.id}/invite`, html`<p class="muted">${tr.t('owner.server.inviteHelp')}</p>`, { submit: tr.t('owner.server.createInvite'), enabled: editEnabled }) : '',
    ].filter(Boolean);
    const body = html`<a class="back" href="${path('/owner/servers')}">← ${tr.t('owner.servers.title')}</a>
<header class="page-head"><h1>${detail.name}${serverTags(detail.tags)}</h1><p class="muted">${tr.t('owner.server.line', { id: detail.id, owner: detail.ownerName || tr.t('owner.common.unknown'), ownerId: detail.ownerId || '-', members: detail.memberCount ?? '-', joined: formatDate(detail.joinedAt) })}</p></header>
${notices({ flash, error, editEnabled })}
<section class="card"><h2>${tr.t('owner.server.about')}</h2><dl>
<dt>${tr.t('owner.common.created')}</dt><dd>${detail.createdAt ? formatDate(detail.createdAt) : '-'}</dd>
<dt>${tr.t('owner.server.boosts')}</dt><dd>${tr.t('owner.server.boostsValue', { boosts: detail.boosts ?? 0, tier: detail.boostTier ?? 0 })}</dd>
<dt>${tr.t('owner.server.verification')}</dt><dd>${detail.verificationLevel || '-'}</dd>
<dt>${tr.t('owner.server.channelsRoles')}</dt><dd>${detail.channels.length} / ${detail.roles.length}</dd>
<dt>${tr.t('owner.blacklist.title')}</dt><dd>${detail.blacklisted
        ? html`<span class="state-word is-bad"><span class="dot dot-bad" aria-hidden="true"></span>${tr.t('owner.server.blacklisted')}</span> <a href="${path('/owner/blacklist')}">${tr.t('owner.blacklist.title')}</a>`
        : detail.canLeave
            ? html`${tr.t('owner.common.notBlacklisted')} · <a href="${path(`/owner/blacklist${queryString({ kind: 'guild', id: detail.id })}`)}">${tr.t('owner.server.blacklistThis')}</a> <span class="muted">${tr.t('owner.common.fillsForm')}</span>`
            : html`<span class="muted">${tr.t('owner.server.cannotBlacklist')}</span>`}</dd>
</dl></section>
${inviteBits.length ? html`<section class="card"><h2>${tr.t('owner.server.invite')}</h2>${inviteBits}</section>` : ''}
<section class="card"><h2>${tr.t('owner.server.permissionCheck')}</h2>${detail.missing?.length
        ? html`<p class="error" role="alert">${tr.tp('owner.server.missing', detail.missing.length)}</p>
<ul class="skip-list">${detail.missing.map((m) => html`<li><b>${m.label}</b>: <span class="muted">${m.why}</span></li>`)}</ul>`
        : html`<p>${stateWord('on', tr.t('owner.server.allPermissions'))}</p>`}
${detail.rolesAbove?.length
        ? html`<p class="error" role="alert">${tr.tx('owner.server.rolesAbove', { top: detail.botTop ? html` (${detail.botTop.name})` : '' })}</p>
<ul class="skip-list">${detail.rolesAbove.map((r) => html`<li><b>${r.name}</b>: <span class="muted">${r.why}</span></li>`)}</ul>`
        : detail.botTop ? html`<p class="muted">${tr.t('owner.server.noRoleAbove', { top: detail.botTop.name })}</p>` : ''}</section>
<section class="card"><h2>${tr.t('owner.server.permissions')}</h2>${detail.permissions.length ? html`<ul class="name-list">${detail.permissions.map((p) => html`<li>${p}</li>`)}</ul>` : html`<p class="empty">${tr.t('owner.common.noneDot')}</p>`}</section>
<section class="card"><h2>${tr.t('owner.server.channels', { count: detail.channels.length })}</h2>${detail.channels.length ? html`<div class="table-wrap"><table><thead><tr><th>${tr.t('owner.common.name')}</th><th>${tr.t('owner.server.type')}</th><th>${tr.t('owner.server.category')}</th></tr></thead><tbody>
${detail.channels.map((c) => html`<tr><td>${c.name}</td><td>${c.type}</td><td>${c.category || html`<span class="muted">-</span>`}</td></tr>`)}</tbody></table></div>` : html`<p class="empty">${tr.t('owner.server.noChannels')}</p>`}</section>
<section class="card"><h2>${tr.t('owner.server.roles', { count: detail.roles.length })}</h2>${detail.roles.length ? html`<div class="table-wrap"><table><thead><tr><th>${tr.t('owner.common.name')}</th><th>${tr.t('owner.server.colour')}</th><th>${tr.t('owner.common.members')}</th></tr></thead><tbody>
${detail.roles.map((r) => html`<tr><td>${r.name}</td><td><code>${r.color}</code></td><td>${r.members}</td></tr>`)}</tbody></table></div>
${detail.membersCached ? '' : html`<p class="muted">${tr.tx('owner.server.cacheNote')}</p>`}` : html`<p class="empty">${tr.t('owner.server.noRoles')}</p>`}</section>
<section class="card"><h2>${tr.t('owner.server.leave')}</h2>${detail.canLeave
        ? actionForm(csrf, `/owner/servers/${detail.id}/leave/preview`, html`<p class="muted">${tr.t('owner.server.leaveHelp')}</p>`, { submit: tr.t('owner.server.leaveButton'), danger: true, enabled: editEnabled })
        : html`<p class="muted">${tr.t('owner.server.cannotLeave')}</p>`}</section>`;
    return shell({ title: detail.name, active: 'owner/servers', session, access, moduleStates, body });
}

export function leaveConfirmPage({ session, access = null, moduleStates = {}, guild, token, hash }) {
    const tr = dashboardText(session?.lang);
    const body = html`<p><a href="${path(`/owner/servers/${guild.id}`)}">${tr.t('owner.common.backCancel')}</a></p>
<h1>${tr.t('owner.server.leaveConfirm', { name: guild.name })}</h1>
<section class="card confirm-card"><dl><dt>${tr.t('owner.common.server')}</dt><dd>${guild.name} <span class="muted">${guild.id}</span></dd><dt>${tr.t('owner.common.members')}</dt><dd>${guild.memberCount ?? '-'}</dd>
<dt>${tr.t('owner.common.effect')}</dt><dd>${tr.t('owner.server.leaveEffect')}</dd></dl>
<p class="muted">${tr.t('owner.common.confirmOnce')}</p>
${confirmButtons(session.csrf, `/owner/servers/${guild.id}/leave`, { submit: tr.t('owner.server.leaveName', { name: guild.name }), hidden: { token, fh: hash }, cancelHref: path(`/owner/servers/${guild.id}`) })}</section>`;
    return shell({ title: tr.t('owner.server.leaveName', { name: guild.name }), active: 'owner/servers', session, access, moduleStates, body });
}

// ── User lookup ───────────────────────────────────────────────────────────

/** The main-server record: ladder, cases, active ban / mute, with links to the existing pages. */
function recordSection(r) {
    const tr = currentText();
    const caseLink = (c) => html`<a href="${path(`/cases/${c.case_code}`)}"><code>${c.case_code}</code></a>${c.expires_at ? html` · ${tr.t('owner.users.ends', { date: formatDate(c.expires_at) })}` : html` · ${tr.t('owner.users.noEnd')}`}`;
    const body = r.recordError
        ? html`<p class="error" role="alert">${r.recordError}</p>`
        : html`<dl>
<dt>${tr.t('owner.users.ladder')}</dt><dd>${tr.t('owner.users.ladderValue', { level: r.record.ladder?.level ?? 0, warns: countedWarnsText(r.record.ladder || { level: 0, warns_since_level: 0 }) })}</dd>
<dt>${tr.t('owner.users.cases')}</dt><dd>${r.record.caseCount ?? 0}${r.record.caseCount ? html` · <a href="${path(`/cases${queryString({ member: r.id })}`)}">${tr.t('owner.users.allCases')}</a>` : ''}</dd>
<dt>${tr.t('owner.users.activeBan')}</dt><dd>${r.record.activeBan ? html`${stateWord('bad', tr.t('owner.users.banned'))} ${caseLink(r.record.activeBan)}` : tr.t('owner.common.noneCap')}</dd>
<dt>${tr.t('owner.users.activeMute')}</dt><dd>${r.record.activeMute ? html`${stateWord('warn', tr.t('owner.users.muted'))} ${caseLink(r.record.activeMute)}` : tr.t('owner.common.noneCap')}</dd>
</dl>`;
    return html`<section class="card"><h2>${tr.t('owner.users.record')}</h2>${body}
<p><a href="${path(`/users/${r.id}`)}">${tr.t('owner.users.openMember')}</a> <span class="muted">${tr.t('owner.users.openMemberNote')}</span></p></section>`;
}

/**
 * result: { id, username, globalName, bot, avatarUrl, createdAt, servers: [{ id, name, tags, joinedAt,
 * nickname }], totalServers, blacklist: { state, entry }, isOwner, offerBlacklist, record, recordError }.
 */
export function userLookupPage({ session, access = null, moduleStates = {}, q = '', result = null, error = null }) {
    const r = result;
    const tr = dashboardText(session?.lang);
    const blacklistText = !r ? '' : r.blacklist.state === 'unknown'
        ? html`<span class="error" role="alert">${tr.t('owner.users.blacklistUnknown')}</span>`
        : r.blacklist.state === 'listed'
            ? html`${stateWord('bad', tr.t('owner.servers.tagBlacklisted'))} ${r.blacklist.entry.reason} · <a href="${path('/owner/blacklist')}">${tr.t('owner.blacklist.title')}</a>`
            : r.isOwner
                ? html`${tr.t('owner.common.notBlacklisted')} <span class="muted">${tr.t('owner.users.ownerNever')}</span>`
                : html`${tr.t('owner.common.notBlacklisted')}${r.offerBlacklist ? html` · <a href="${path(`/owner/blacklist${queryString({ kind: 'user', id: r.id })}`)}">${tr.t('owner.users.blacklistThis')}</a> <span class="muted">${tr.t('owner.common.fillsForm')}</span>` : ''}`;
    const servers = !r ? '' : html`<section class="card"><h2>${tr.t('owner.users.shared', { count: r.servers.length })}</h2>${r.servers.length
        ? html`<div class="table-wrap"><table><thead><tr><th>${tr.t('owner.common.server')}</th><th>${tr.t('owner.users.nickname')}</th><th>${tr.t('owner.users.joined')}</th></tr></thead><tbody>
${r.servers.map((g) => html`<tr><td><a href="${path(`/owner/servers/${g.id}`)}"><b>${g.name}</b></a>${serverTags(g.tags)}<br><small class="muted">${g.id}</small></td><td>${g.nickname || html`<span class="muted">-</span>`}</td><td>${formatDate(g.joinedAt)}</td></tr>`)}
</tbody></table></div>` : html`<p class="empty">${tr.t('owner.users.noShared')}</p>`}
<p class="muted">${tr.tx('owner.users.sharedNote')}</p></section>`;
    const body = html`<header class="page-head"><h1>${tr.t('owner.users.title')}</h1><p class="muted">${tr.tx('owner.users.help')}</p></header>
<form class="filters" method="get" action="${path('/owner/users')}" role="search"><label class="wide-filter">${tr.t('owner.users.userId')}<input type="search" name="q" value="${q}" inputmode="numeric" maxlength="25" autocomplete="off" placeholder="${tr.t('owner.users.placeholder')}"></label>
<button class="primary" type="submit">${tr.t('owner.users.lookUp')}</button>${q ? html` <a href="${path('/owner/users')}">${tr.t('owner.common.clear')}</a>` : ''}</form>
${error ? html`<p class="error" role="alert">${error}</p>` : ''}
${r ? html`<section class="card"><h2>${r.globalName || r.username || r.id}</h2>${img(r.avatarUrl, '', 64)}<dl>
<dt>${tr.t('owner.profile.username')}</dt><dd>${r.username || '-'}${r.bot ? html` <span class="muted">${tr.t('owner.users.botAccount')}</span>` : ''}</dd>
<dt>${tr.t('owner.users.displayName')}</dt><dd>${r.globalName || html`<span class="muted">${tr.t('owner.common.none')}</span>`}</dd>
<dt>ID</dt><dd><code>${r.id}</code></dd>
<dt>${tr.t('owner.users.accountCreated')}</dt><dd>${formatDate(r.createdAt)}</dd>
<dt>${tr.t('owner.users.botOwner')}</dt><dd>${r.isOwner ? stateWord('on', tr.t('owner.users.yesOwner')) : tr.t('owner.common.no')}</dd>
<dt>${tr.t('owner.blacklist.title')}</dt><dd>${blacklistText}</dd>
<dt>${tr.t('owner.users.theirData')}</dt><dd><a href="${path(`/owner/users/${r.id}/data`)}" download>${tr.t('owner.users.download')}</a> <span class="muted">${tr.t('owner.users.downloadNote')}</span></dd>
</dl></section>
${recordSection(r)}
${servers}` : ''}`;
    return shell({ title: tr.t('owner.users.title'), active: 'owner/users', session, access, moduleStates, body });
}

// ── Blacklist ─────────────────────────────────────────────────────────────

/** active / removed: bot_blacklist rows. names: Map id → display name. */
export function blacklistPage({ session, access = null, moduleStates = {}, active = [], removed = [], names = new Map(), flash = null, error = null, values = {}, editEnabled = true }) {
    const csrf = session.csrf;
    const tr = dashboardText(session?.lang);
    const who = (id, name) => html`${name || id}${name ? html` <small class="muted">${id}</small>` : ''}`;
    const kindLabel = (kind) => (kind === 'guild' ? tr.t('owner.common.server') : tr.t('owner.blacklist.user'));
    const body = html`<header class="page-head"><h1>${tr.t('owner.blacklist.title')}</h1><p class="muted">${tr.tx('owner.blacklist.help')}</p></header>
${notices({ flash, error, editEnabled })}
<section class="card"><h2>${tr.t('owner.blacklist.add')}</h2>${actionForm(csrf, '/owner/blacklist/add', html`<div class="grid">
<label>${tr.t('owner.blacklist.kind')}<select name="kind">${opt('user', tr.t('owner.blacklist.user'), values.kind || 'user')}${opt('guild', tr.t('owner.common.server'), values.kind)}</select></label>
<label>${tr.t('owner.blacklist.discordId')}<input name="id" inputmode="numeric" maxlength="20" required value="${values.id || ''}"></label>
<label class="wide">${tr.t('owner.blacklist.reason')}<input name="reason" maxlength="${BLACKLIST_REASON_MAX}" required value="${values.reason || ''}"></label></div>`, { submit: tr.t('owner.blacklist.addButton'), danger: true, enabled: editEnabled })}</section>
<section class="card"><h2>${tr.t('owner.blacklist.listed', { count: active.length })}</h2>${active.length ? html`<div class="table-wrap"><table><thead><tr><th>${tr.t('owner.common.who')}</th><th>${tr.t('owner.blacklist.reason')}</th><th>${tr.t('owner.blacklist.added')}</th><th></th></tr></thead><tbody>
${active.map((row) => html`<tr><td>${kindLabel(row.kind)}: ${who(row.target_id, names.get(row.target_id))}</td><td>${row.reason}</td><td>${row.added_by_username || row.added_by}<br><small class="muted">${formatDate(row.created_at)}</small></td>
<td class="nowrap">${actionForm(csrf, '/owner/blacklist/remove', '', { submit: tr.t('owner.blacklist.undo'), hidden: { entry: String(row.id) }, inline: true, secondary: true, enabled: editEnabled, confirm: tr.t('owner.blacklist.undoConfirm', { id: row.target_id }) })}</td></tr>`)}
</tbody></table></div>` : html`<p class="empty">${tr.t('owner.blacklist.nobody')}</p>`}</section>
${removed.length ? html`<section class="card"><h2>${tr.t('owner.blacklist.recentlyRemoved')}</h2><div class="table-wrap"><table><thead><tr><th>${tr.t('owner.common.who')}</th><th>${tr.t('owner.blacklist.reason')}</th><th>${tr.t('owner.blacklist.added')}</th><th>${tr.t('owner.blacklist.removed')}</th></tr></thead><tbody>
${removed.map((row) => html`<tr><td>${kindLabel(row.kind)}: ${who(row.target_id, names.get(row.target_id))}</td><td>${row.reason}</td><td>${row.added_by_username || row.added_by}<br><small class="muted">${formatDate(row.created_at)}</small></td><td>${row.removed_by_username || row.removed_by}<br><small class="muted">${formatDate(row.removed_at)}</small></td></tr>`)}
</tbody></table></div></section>` : ''}`;
    return shell({ title: tr.t('owner.blacklist.title'), active: 'owner/blacklist', session, access, moduleStates, body });
}

// ── Overview and activity ─────────────────────────────────────────────────

/** What an owner audit row did, in words (keys written by ownerRoutes.js). names: id → server name. */
export function ownerActionText(key, names = new Map()) {
    const k = String(key || '');
    const tr = currentText();
    const server = (id) => names.get(id) || id;
    let m;
    if (k === 'maintenance') return tr.t('owner.action.maintenance');
    if (k === 'announce') return tr.t('owner.action.announce');
    if (k === 'commands.register') return tr.t('owner.action.register');
    if ((m = /^profile\.(username|about|presence|avatar|banner)$/.exec(k))) {
        return tr.t('owner.action.profile', { what: tr.t({ username: 'owner.action.profileUsername', about: 'owner.action.profileAbout', presence: 'owner.action.profileStatus', avatar: 'owner.action.profileAvatar', banner: 'owner.action.profileBanner' }[m[1]]) });
    }
    if ((m = /^servers\.(\d+)\.invite$/.exec(k))) return tr.t('owner.action.invite', { server: server(m[1]) });
    if ((m = /^servers\.(\d+)\.leave$/.exec(k))) return tr.t('owner.action.left', { server: server(m[1]) });
    if ((m = /^blacklist\.(user|guild)\.(\d+)$/.exec(k))) return m[1] === 'guild' ? tr.t('owner.action.blacklistServer', { server: server(m[2]) }) : tr.t('owner.action.blacklistUser', { id: m[2] });
    if (k === 'premium.keys.generate') return tr.t('owner.action.keysCreated');
    if (k === 'premium.keys.revoke') return tr.t('owner.action.keyCancelled');
    if (k === 'premium.roles') return tr.t('owner.action.roles');
    if ((m = /^premium\.subscriptions\.(\d+)\.grant$/.exec(k))) return tr.t('owner.action.grant', { id: m[1] });
    if ((m = /^premium\.subscriptions\.(\d+)\.end$/.exec(k))) return tr.t('owner.action.end', { id: m[1] });
    if ((m = /^privacy\.export\.(\d+)$/.exec(k))) return tr.t('owner.action.export', { id: m[1] });
    if ((m = /^privacy\.erase\.([a-z0-9]{5,7})$/.exec(k))) return tr.t('owner.action.erase', { code: m[1] });
    return k;
}

function actionList(rows, names) {
    return html`<ul class="activity">${rows.map((r) => html`<li>
<span class="avatar-initials" aria-hidden="true">${String(r.username || '?').slice(0, 1).toUpperCase()}</span>
<span class="activity-text"><strong>${r.username || r.user_id || currentText().t('owner.common.someone')}</strong> · ${ownerActionText(r.key, names)}
<span class="activity-values muted">${auditValue(r.old)} → ${auditValue(r.new)}</span></span>
<span class="activity-time muted">${timeTag(r.created_at)}</span></li>`)}</ul>`;
}

function serverFeed(rows, sub) {
    return rows.length ? html`<ul class="feed">${rows.map((row) => html`<li>${img(row.iconUrl, '', 32) || ''}<span class="feed-text"><a href="${path(`/owner/servers/${row.id}`)}"><b>${row.name}</b></a>${serverTags(row.tags)}<small>${sub(row)}</small></span></li>`)}</ul>`
        : html`<p class="empty">${currentText().t('owner.common.noneDot')}</p>`;
}

/**
 * home: { totals: { servers, members, joinedWeek }, recent: [server rows], largest: [server rows],
 * health (collectHealth), blacklistCount (undefined = unavailable), actions (audit rows; null = unavailable), names }.
 */
export function ownerHomePage({ session, access = null, moduleStates = {}, home }) {
    const h = home.health;
    const db = h.database;
    const tr = dashboardText(session?.lang);
    const ping = Number.isFinite(h.ping) && h.ping >= 0 ? tr.t('owner.home.ping', { ms: Math.round(h.ping) }) : tr.t('owner.home.pingUnknown');
    const body = html`<header class="page-head"><h1>${tr.t('owner.home.title')}</h1><p class="muted">${tr.t('owner.home.help')}</p></header>
${h.maintenance ? html`<p class="notice">${tr.t('owner.home.maintenanceOn')} <a href="${path('/owner/health')}">${tr.t('owner.home.turnOff')}</a></p>` : ''}
${db && !db.connected ? html`<p class="error" role="alert">${tr.t('owner.home.dbDegraded', { type: db.type || tr.t('owner.common.none') })} <a href="${path('/owner/health')}">${tr.t('owner.health.title')}</a></p>` : ''}
<dl class="facts">
${kpi(tr.t('owner.servers.title'), h.servers, tr.t('owner.home.serversSub', { members: tr.fmtNumber(home.totals.members), week: tr.fmtNumber(home.totals.joinedWeek) }), { dark: true, href: path('/owner/servers') })}
${kpi(tr.t('owner.health.uptime'), duration(h.uptimeSeconds), ping)}
${kpi(tr.t('owner.health.database'), db ? (db.connected ? 'OK' : tr.t('owner.home.degraded')) : tr.t('owner.home.unknownCap'), db ? tr.t('owner.home.dbSub', { type: db.type || tr.t('owner.common.none'), memory: mb(h.memory?.rss) }) : tr.t('owner.home.memorySub', { memory: mb(h.memory?.rss) }), { href: path('/owner/health') })}
${kpi(tr.t('owner.blacklist.title'), home.blacklistCount, home.blacklistCount === undefined ? tr.t('owner.home.notLoaded') : tr.t('owner.home.activeEntries'), { href: path('/owner/blacklist') })}
</dl>
${tile(7, tr.t('owner.home.joinedRecently'), serverFeed(home.recent, (row) => tr.t('owner.home.joinedSub', { members: row.memberCount ?? '-', date: formatDate(row.joinedAt) })), { link: { href: path(`/owner/servers${queryString({ sort: 'newest' })}`), text: tr.t('owner.home.allServers') } })}
${tile(5, tr.t('owner.home.largest'), serverFeed(home.largest, (row) => tr.t('owner.home.membersSub', { members: row.memberCount ?? '-' })), { link: { href: path(`/owner/servers${queryString({ sort: 'members' })}`), text: tr.t('owner.home.bySize') } })}
${tile(12, tr.t('owner.home.recentActions'), home.actions === null
        ? html`<p class="muted">${tr.t('owner.home.unavailable')}</p>`
        : home.actions.length ? actionList(home.actions, home.names) : html`<p class="empty">${tr.t('owner.activity.none')}</p>`, { link: { href: path('/owner/activity'), text: tr.t('owner.home.allActivity') } })}`;
    return shell({ title: tr.t('owner.home.title'), active: 'owner/home', session, access, moduleStates, body });
}

/** rows: owner audit rows (newest first); null = the audit store could not be read. */
export function activityPage({ session, access = null, moduleStates = {}, rows, total = 0, page = 0, pageSize = 50, names = new Map() }) {
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const tr = dashboardText(session?.lang);
    const pager = html`<div class="pager">
${page > 0 ? html`<a href="${path(`/owner/activity${queryString({ page: page - 1 })}`)}">${tr.t('owner.activity.newer')}</a>` : ''}
<span class="muted">${tr.t('owner.activity.page', { page: page + 1, pages, actions: tr.tp('owner.activity.actions', total) })}</span>
${page + 1 < pages ? html`<a href="${path(`/owner/activity${queryString({ page: page + 1 })}`)}">${tr.t('owner.activity.older')}</a>` : ''}
</div>`;
    const body = html`<header class="page-head"><h1>${tr.t('owner.activity.title')}</h1><p class="muted">${tr.tx('owner.activity.help')}</p></header>
${rows === null ? html`<p class="error" role="alert">${tr.t('owner.activity.loadError')}</p>`
        : rows.length ? html`<div class="scroll"><table><thead><tr><th>${tr.t('owner.common.when')}</th><th>${tr.t('owner.common.who')}</th><th>${tr.t('owner.activity.what')}</th><th>${tr.t('owner.activity.before')}</th><th>${tr.t('owner.activity.after')}</th></tr></thead><tbody>
${rows.map((r) => html`<tr><td>${timeTag(r.created_at)}</td><td>${r.username || r.user_id || '-'} <span class="muted">${r.user_id || ''}</span></td><td>${ownerActionText(r.key, names)}</td><td class="value">${auditValue(r.old)}</td><td class="value">${auditValue(r.new)}</td></tr>`)}
</tbody></table></div>${pager}` : html`<p class="empty">${tr.t('owner.activity.none')}</p>`}`;
    return shell({ title: tr.t('owner.activity.title'), active: 'owner/activity', session, access, moduleStates, body });
}

// ── Health ────────────────────────────────────────────────────────────────

function duration(seconds) {
    const s = Math.max(0, Math.floor(seconds || 0));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const tr = currentText();
    return d ? tr.t('owner.health.dh', { d, h }) : h ? tr.t('owner.health.hm', { h, m }) : tr.t('owner.health.m', { m });
}
const mb = (bytes) => `${Math.round((bytes || 0) / 1024 / 1024)} MB`;

export const RECENT_LOGS_SHOWN = 25;

/** The newest warnings and errors (recentLogs.js: already masked and cut), newest first. */
function recentLogsSection(lines) {
    const list = Array.isArray(lines) ? lines.slice(0, RECENT_LOGS_SHOWN) : [];
    const errors = list.filter((l) => l.level === 'error').length;
    const tr = currentText();
    return html`<section class="card"><h2>${tr.t('owner.health.logsTitle')}</h2>
<p class="muted">${tr.tx('owner.health.logsHelp', { counts: `${list.length}${Array.isArray(lines) && lines.length > list.length ? tr.t('owner.health.logsOf', { total: lines.length }) : ''}${errors ? `, ${tr.tp('owner.health.errors', errors)}` : ''}` })}</p>
${list.length ? html`<div class="scroll"><table><thead><tr><th>${tr.t('owner.common.when')}</th><th>${tr.t('owner.health.level')}</th><th>${tr.t('owner.health.message')}</th></tr></thead><tbody>
${list.map((l) => html`<tr><td class="nowrap">${timeTag(l.at)}</td><td><span class="state-word is-${l.level === 'error' ? 'bad' : 'warn'}"><span class="dot dot-${l.level === 'error' ? 'bad' : 'warn'}" aria-hidden="true"></span>${l.level === 'error' ? tr.t('owner.health.error') : tr.t('owner.health.warning')}</span></td><td class="value">${l.text}${l.traceId ? html`<br><small class="muted">${l.traceId}</small>` : ''}</td></tr>`)}
</tbody></table></div>` : html`<p class="empty">${tr.t('owner.health.noLogs')}</p>`}</section>`;
}

/** health: { uptimeSeconds, gatewayUptimeMs, ping, memory, eventLoop, node, version, servers, database, maintenance }. */
export function healthPage({ session, access = null, moduleStates = {}, health, flash = null, error = null, editEnabled = true }) {
    const db = health.database;
    const tr = dashboardText(session?.lang);
    const body = html`<header class="page-head"><h1>${tr.t('owner.health.title')}</h1><p class="muted">${tr.t('owner.health.help')}</p></header>
${notices({ flash, error, editEnabled })}
<section class="card"><h2>${tr.t('owner.profile.status')}</h2><dl>
<dt>${tr.t('owner.health.uptime')}</dt><dd>${duration(health.uptimeSeconds)}${health.gatewayUptimeMs != null ? html` <span class="muted">${tr.t('owner.health.gatewayConnected', { time: duration(health.gatewayUptimeMs / 1000) })}</span>` : ''}</dd>
<dt>${tr.t('owner.health.gatewayPing')}</dt><dd>${Number.isFinite(health.ping) && health.ping >= 0 ? `${Math.round(health.ping)} ms` : '-'}</dd>
<dt>${tr.t('owner.health.memory')}</dt><dd>${tr.t('owner.health.memoryValue', { rss: mb(health.memory?.rss), used: mb(health.memory?.heapUsed), total: mb(health.memory?.heapTotal) })}</dd>
<dt>${tr.t('owner.health.eventLoop')}</dt><dd>${health.eventLoop ? html`${tr.t('owner.health.eventLoopValue', { p99: health.eventLoop.p99Ms, max: health.eventLoop.maxMs })}${health.eventLoop.p99Ms > 500 ? html` <span class="state-word is-warn"><span class="dot dot-warn" aria-hidden="true"></span>${tr.t('owner.health.eventLoopSlow')}</span>` : ''}` : tr.t('owner.health.eventLoopPending')}</dd>
<dt>Node</dt><dd>${health.node}</dd>
<dt>${tr.t('owner.health.version')}</dt><dd>${health.version || '-'}</dd>
<dt>${tr.t('owner.servers.title')}</dt><dd>${health.servers}</dd>
<dt>${tr.t('owner.blacklist.title')}</dt><dd>${health.blacklistLoaded === false ? html`<span class="state-word is-bad"><span class="dot dot-bad" aria-hidden="true"></span>${tr.t('owner.health.blacklistNotLoaded')}</span>` : html`<span class="state-word is-on"><span class="dot dot-on" aria-hidden="true"></span>${tr.t('owner.health.loaded')}</span>`}</dd>
<dt>${tr.t('owner.health.database')}</dt><dd>${db ? html`<span class="state-word is-${db.connected ? 'on' : 'bad'}"><span class="dot dot-${db.connected ? 'on' : 'bad'}" aria-hidden="true"></span>${db.connected ? tr.t('owner.health.connected', { type: db.type }) : tr.t('owner.health.degradedType', { type: db.type || tr.t('owner.common.none') })}</span>` : tr.t('owner.home.unknownCap')}</dd>
</dl></section>
${recentLogsSection(health.recentLogs)}
<section class="card"><h2>${tr.t('owner.health.maintenance')}</h2><p>${health.maintenance ? html`<span class="state-word is-warn"><span class="dot dot-warn" aria-hidden="true"></span>${tr.t('owner.health.maintenanceOnText')}</span>` : html`<span class="state-word is-off"><span class="dot dot-off" aria-hidden="true"></span>${tr.t('owner.health.off')}</span>`}</p>
${actionForm(session.csrf, '/owner/health/maintenance', '', { submit: health.maintenance ? tr.t('owner.health.turnOff') : tr.t('owner.health.turnOn'), hidden: { enabled: health.maintenance ? 'off' : 'on' }, danger: !health.maintenance, enabled: editEnabled })}
<p class="muted">${tr.t('owner.common.keptAfterRestart')}</p></section>`;
    return shell({ title: tr.t('owner.health.title'), active: 'owner/health', session, access, moduleStates, body });
}

// ── Command sync ──────────────────────────────────────────────────────────

const countText = (c) => (c ? `${currentText().tp('owner.commands.slash', c.slash)} + ${currentText().tp('owner.commands.menus', c.menus)}` : '-');

function diffList(title, rows, note) {
    return rows.length ? html`<h3>${title} (${rows.length})</h3><p class="muted">${note}</p>
<ul class="skip-list">${rows.map((c) => html`<li><b>${c.name}</b> <span class="muted">${c.type}</span></li>`)}</ul>` : '';
}

/**
 * state: { loaded, retired, expected: { slash, menus } | null, registered: { slash,
 * menus } | null, diff: { missing, extra, inSync } | null, expectedError, registeredError }.
 */
export function commandsPage({ session, access = null, moduleStates = {}, state, flash = null, error = null, editEnabled = true }) {
    const s = state;
    const tr = dashboardText(session?.lang);
    const comparison = s.diff
        ? s.diff.inSync
            ? html`<p>${stateWord('on', tr.t('owner.commands.inSync'))}</p>`
            : html`<p>${stateWord('warn', tr.t('owner.commands.outOfSync'))} <span class="muted">${tr.t('owner.commands.fixBelow')}</span></p>
${diffList(tr.t('owner.commands.missing'), s.diff.missing, tr.t('owner.commands.missingNote'))}
${diffList(tr.t('owner.commands.extra'), s.diff.extra, tr.t('owner.commands.extraNote'))}`
        : html`<p class="muted">${tr.t('owner.commands.noComparison')}</p>`;
    const body = html`<header class="page-head"><h1>${tr.t('owner.commands.title')}</h1><p class="muted">${tr.tx('owner.commands.help')}</p></header>
${notices({ flash, error, editEnabled })}
${s.expectedError ? html`<p class="error" role="alert">${s.expectedError}</p>` : ''}
${s.registeredError ? html`<p class="error" role="alert">${s.registeredError}</p>` : ''}
<section class="card"><h2>${tr.t('owner.commands.mainServer')}</h2><dl>
<dt>${tr.t('owner.commands.loaded')}</dt><dd>${tr.tp('owner.commands.files', s.loaded)}</dd>
<dt>${tr.t('owner.commands.startup')}</dt><dd>${countText(s.expected)}${s.retired ? html` <span class="muted">${tr.t('owner.commands.retiredNote')}</span>` : ''}</dd>
<dt>${tr.t('owner.commands.onDiscord')}</dt><dd>${countText(s.registered)}</dd>
</dl>${comparison}</section>
<section class="card"><h2>${tr.t('owner.commands.reregister')}</h2><p class="muted">${tr.tx('owner.commands.reregisterHelp')}</p>
${actionForm(session.csrf, '/owner/commands/register/preview', '', { submit: tr.t('owner.commands.reregisterButton'), enabled: editEnabled && !s.expectedError })}</section>`;
    return shell({ title: tr.t('owner.commands.title'), active: 'owner/commands', session, access, moduleStates, body });
}

export function registerConfirmPage({ session, access = null, moduleStates = {}, state, token, hash }) {
    const tr = dashboardText(session?.lang);
    const body = html`<p><a href="${path('/owner/commands')}">${tr.t('owner.common.backCancel')}</a></p>
<h1>${tr.t('owner.commands.confirmTitle')}</h1>
<section class="card confirm-card"><dl><dt>${tr.t('owner.common.server')}</dt><dd>${tr.t('owner.commands.mainServer')}</dd>
<dt>${tr.t('owner.commands.willRegister')}</dt><dd>${countText(state.expected)}${state.retired ? ` ${tr.t('owner.commands.retired')}` : ''}</dd>
<dt>${tr.t('owner.commands.onDiscord')}</dt><dd>${countText(state.registered)}</dd>
<dt>${tr.t('owner.common.effect')}</dt><dd>${tr.tx('owner.commands.confirmEffect')}</dd></dl>
<p class="muted">${tr.t('owner.common.confirmOnce')}</p>
${confirmButtons(session.csrf, '/owner/commands/register', { submit: tr.t('owner.commands.confirmButton'), hidden: { token, fh: hash }, cancelHref: path('/owner/commands') })}</section>`;
    return shell({ title: tr.t('owner.commands.confirmButton'), active: 'owner/commands', session, access, moduleStates, body });
}

// ── Announce ──────────────────────────────────────────────────────────────

/** targets: { sendable: [{ guildId, guildName, channelId, channelName }], skipped: [{ guildId, guildName, why }] }. */
function targetLists(targets) {
    const tr = currentText();
    return html`<section class="card"><h2>${tr.t('owner.announce.willPost', { count: targets.sendable.length })}</h2>${targets.sendable.length
        ? html`<ul class="name-list">${targets.sendable.map((t) => html`<li>${t.guildName} <span class="muted">#${t.channelName}</span></li>`)}</ul>` : html`<p class="empty">${tr.t('owner.announce.noTarget')}</p>`}</section>
${targets.skipped.length ? html`<section class="card"><h2>${tr.t('owner.announce.skipped', { count: targets.skipped.length })}</h2><ul class="skip-list">${targets.skipped.map((t) => html`<li>${t.guildName} <span class="muted">${t.why}</span></li>`)}</ul></section>` : ''}`;
}

export function announcePage({ session, access = null, moduleStates = {}, targets, pickers = '', message = '', error = null, editEnabled = true }) {
    const tr = dashboardText(session?.lang);
    const body = html`<header class="page-head"><h1>${tr.t('owner.announce.title')}</h1><p class="muted">${tr.tx('owner.announce.help')}</p></header>
${notices({ error, editEnabled })}
<section class="card"><h2>${tr.t('owner.health.message')}</h2>${actionForm(session.csrf, '/owner/announce/preview', html`<label class="wide">${tr.t('owner.announce.text')}<textarea name="message" maxlength="${ANNOUNCE_MAX}" rows="6" required>${message}</textarea></label>
${pickers ? html`<fieldset class="wide"><legend>${tr.t('owner.announce.where')}</legend><p class="hint">${tr.t('owner.announce.whereHelp')}</p><div class="grid">${pickers}</div></fieldset>` : ''}`, { submit: tr.t('owner.announce.preview'), enabled: editEnabled })}</section>
${targetLists(targets)}`;
    return shell({ title: tr.t('owner.announce.title'), active: 'owner/announce', session, access, moduleStates, body });
}

export function announceConfirmPage({ session, access = null, moduleStates = {}, message, targets, token, hash }) {
    const tr = dashboardText(session?.lang);
    const body = html`<p><a href="${path('/owner/announce')}">${tr.t('owner.common.backCancel')}</a></p>
<h1>${tr.tp('owner.announce.confirmTitle', targets.sendable.length)}</h1>
<section class="card confirm-card"><h2>${tr.t('owner.health.message')}</h2><blockquote>${message}</blockquote>
<p class="muted">${tr.t('owner.common.confirmOnce')}</p>
${targets.sendable.length ? confirmButtons(session.csrf, '/owner/announce/send', { submit: tr.tp('owner.announce.sendTo', targets.sendable.length), hidden: { token, fh: hash }, cancelHref: path('/owner/announce') }) : ''}</section>
${targetLists(targets)}`;
    return shell({ title: tr.t('owner.announce.confirmPageTitle'), active: 'owner/announce', session, access, moduleStates, body });
}

/** result: { sent: [{ guildName, channelName }], failed: [{ guildName, why }], skipped: [{ guildName, why }] }. */
export function announceResultPage({ session, access = null, moduleStates = {}, result }) {
    const tr = dashboardText(session?.lang);
    const body = html`<p><a href="${path('/owner/announce')}">← ${tr.t('owner.announce.title')}</a></p>
<header class="page-head"><h1>${tr.t('owner.announce.sent')}</h1><p class="muted">${tr.t('owner.announce.sentSummary', { sent: result.sent.length, failed: result.failed.length, skipped: result.skipped.length })}</p></header>
<section class="card"><h2>${tr.t('owner.announce.posted', { count: result.sent.length })}</h2>${result.sent.length ? html`<ul class="name-list">${result.sent.map((t) => html`<li>${t.guildName} <span class="muted">#${t.channelName}</span></li>`)}</ul>` : html`<p class="empty">${tr.t('owner.announce.nowhere')}</p>`}</section>
${result.failed.length ? html`<section class="card"><h2>${tr.t('owner.announce.failed', { count: result.failed.length })}</h2><ul class="skip-list">${result.failed.map((t) => html`<li>${t.guildName} <span class="muted">${t.why}</span></li>`)}</ul></section>` : ''}
${result.skipped.length ? html`<section class="card"><h2>${tr.t('owner.announce.skipped', { count: result.skipped.length })}</h2><ul class="skip-list">${result.skipped.map((t) => html`<li>${t.guildName} <span class="muted">${t.why}</span></li>`)}</ul></section>` : ''}`;
    return shell({ title: tr.t('owner.announce.sent'), active: 'owner/announce', session, access, moduleStates, body });
}


// ── Premium keys (test checkout; services/billing/premiumService.js) ─────

export const KEY_FILTERS = { unused: 'Not redeemed', redeemed: 'Redeemed', expired: 'Expired', revoked: 'Cancelled', all: 'All' };
const KEY_STATUS_TEXT = { unused: 'owner.premium.statusUnused', redeemed: 'owner.premium.statusRedeemed', expired: 'owner.premium.statusExpired', revoked: 'owner.premium.statusRevoked' };
const KEY_TONE = { unused: 'on', redeemed: 'off', expired: 'off', revoked: 'bad' };
// Key time / validity labels: the catalog's word when it has one for that number of days, else premiumService's label.
const durationLabel = (tr, d) => (tr.has(`owner.premium.duration_${d.days}`) ? tr.t(`owner.premium.duration_${d.days}`) : d.label);
const validityLabel = (tr, v) => (tr.has(`owner.premium.valid_${v.days}`) ? tr.t(`owner.premium.valid_${v.days}`) : v.label);
const SOURCE_LABEL = { key: 'owner.premium.sourceKey', purchase: 'owner.premium.sourcePurchase', owner: 'owner.premium.sourceOwner' };

/**
 * keys: { rows, counts } (null = database unavailable); subscriptions / orders: rows (null = unavailable);
 * created: the rows just generated (shown once at the top); testCheckout: PREMIUM_TEST_CHECKOUT.
 */
export function premiumPage({
    session, access = null, moduleStates = {}, keys = null, subscriptions = null, orders = null, filter = 'unused',
    created = [], testCheckout = false, flash = null, error = null, values = {}, editEnabled = true,
    stats = null, roles = {}, roleChoices = [],
}) {
    const csrf = session.csrf;
    const tr = dashboardText(session?.lang);
    const who = (id, name) => (id ? html`${name || id}${name ? html` <small class="muted">${id}</small>` : ''}` : '-');
    const counts = keys?.counts || {};
    const body = html`<header class="page-head"><h1>${tr.t('owner.premium.title')}</h1><p class="muted">${tr.t('owner.premium.help')}</p></header>
${notices({ flash, error, editEnabled })}
${testCheckout ? '' : html`<p class="notice">${tr.ti('owner.premium.checkoutOff')}</p>`}
${stats ? html`<dl class="facts">${kpi(tr.t('owner.premium.activePlans'), stats.activeTotal, PAID_PLANS.map((p) => `${p.name} ${stats.active[p.id] || 0}`).join(' · '))}${kpi(tr.t('owner.premium.orders30'), stats.orders30, tr.tp('owner.premium.gifts', stats.gifts30))}${kpi(tr.t('owner.premium.amount30'), Object.entries(stats.amounts30 || {}).map(([cur, cents]) => formatPrice(cents, cur)).join(' · ') || euros(0), tr.t('owner.premium.notCharged'))}${kpi(tr.t('owner.premium.unusedKeys'), keys?.counts?.unused ?? '-', tr.t('owner.premium.expiredCount', { count: keys?.counts?.expired ?? 0 }))}</dl>` : ''}
${created.length ? html`<section class="card"><h2>${tr.t('owner.premium.newKeys', { count: created.length })}</h2><p class="muted">${tr.t('owner.premium.newKeysNote', { plan: planName(created[0].plan_id), days: created[0].duration_days })}</p>
<textarea class="key-output" readonly rows="${Math.min(created.length, 12)}" aria-label="${tr.t('owner.premium.newKeysLabel')}">${created.map((k) => k.code).join('\n')}</textarea></section>` : ''}
<section class="card"><h2>${tr.t('owner.premium.create')}</h2>${actionForm(csrf, '/owner/premium/generate', html`<div class="grid">
<label>${tr.t('owner.premium.plan')}<select name="plan">${PAID_PLANS.map((p) => opt(p.id, tr.t('owner.premium.planOption', { plan: p.name, price: euros(p.monthlyCents) }), values.plan || 'pro'))}</select></label>
<label>${tr.t('owner.premium.time')}<select name="days">${KEY_DURATIONS.map((d) => opt(String(d.days), durationLabel(tr, d), String(values.days || 30)))}</select></label>
<label>${tr.t('owner.premium.howMany')}<input name="count" type="number" min="1" max="${MAX_KEYS_PER_BATCH}" required value="${values.count || 1}"></label>
<label>${tr.t('owner.premium.validFor')}<select name="valid">${KEY_VALIDITY.map((v) => opt(String(v.days), validityLabel(tr, v), String(values.valid || 0)))}</select></label>
<label class="wide">${tr.t('owner.premium.note')}<input name="note" maxlength="${NOTE_MAX}" value="${values.note || ''}" placeholder="${tr.t('owner.premium.notePlaceholder')}"></label></div>`, { submit: tr.t('owner.premium.create'), enabled: editEnabled })}</section>
<section class="card"><h2>${tr.t('owner.premium.give')}</h2><p class="muted">${tr.t('owner.premium.giveHelp')}</p>${actionForm(csrf, '/owner/premium/grant', html`<div class="grid">
<label>${tr.t('owner.users.placeholder')}<input name="user" inputmode="numeric" maxlength="20" required value="${values.grantUser || ''}"></label>
<label>${tr.t('owner.premium.plan')}<select name="grant_plan">${PAID_PLANS.map((p) => opt(p.id, p.name, values.grantPlan || 'pro'))}</select></label>
<label>${tr.t('owner.premium.time')}<select name="grant_days">${KEY_DURATIONS.map((d) => opt(String(d.days), durationLabel(tr, d), String(values.grantDays || 30)))}</select></label></div>`, { submit: tr.t('owner.premium.giveButton'), enabled: editEnabled })}</section>
<section class="card"><h2>${tr.t('owner.premium.roles')}</h2><p class="muted">${tr.t('owner.premium.rolesHelp')}</p>${actionForm(csrf, '/owner/premium/roles', html`<div class="grid">
${PAID_PLANS.map((p) => html`<label>${tr.t('owner.premium.planRole', { plan: p.name })}<select name="role_${p.id}"><option value="">${tr.t('owner.premium.noRole')}</option>${roleChoices.map((role) => html`<option value="${role.id}"${role.id === roles[p.id] ? html` selected` : ''}${role.problem ? html` disabled` : ''}>@${role.name}${role.problem ? ` ${tr.t('owner.premium.cannotHandOut')}` : ''}</option>`)}</select></label>`)}</div>`, { submit: tr.t('owner.premium.saveRoles'), enabled: editEnabled })}</section>
<section class="card"><h2>${tr.t('owner.premium.keys')}</h2>
<nav class="chips" aria-label="${tr.t('owner.premium.keyStatus')}">${Object.keys(KEY_FILTERS).map((key) => html`<a class="chip" href="${path(`/owner/premium${queryString({ status: key })}`)}"${key === filter ? html` aria-current="page"` : ''}>${tr.t(`owner.premium.filter_${key}`)}${key === 'all' ? ` (${counts.total ?? '-'})` : ` (${counts[key] ?? '-'})`}</a>`)}</nav>
${keys === null ? html`<p class="error" role="alert">${tr.t('owner.premium.keysError')}</p>`
        : keys.rows.length ? html`<div class="scroll"><table><thead><tr><th>${tr.t('owner.premium.sourceKey')}</th><th>${tr.t('owner.premium.plan')}</th><th>${tr.t('owner.premium.time')}</th><th>${tr.t('owner.premium.from')}</th><th>${tr.t('owner.common.created')}</th><th>${tr.t('owner.profile.status')}</th><th></th></tr></thead><tbody>
${keys.rows.map((k) => { const st = keyStatus(k); return html`<tr><td><code class="key-code">${k.code}</code>${k.note ? html`<br><small class="muted">${k.note}</small>` : ''}</td><td>${planName(k.plan_id)}</td><td>${tr.t('owner.premium.days', { days: k.duration_days })}</td>
<td>${k.source === 'gift' ? html`${tr.t('owner.premium.giftBy')} ${who(k.created_by, k.created_by_username)}` : html`${tr.t('owner.premium.ownerBy')} ${k.created_by_username || k.created_by}`}</td><td>${timeTag(k.created_at)}</td>
<td>${stateWord(KEY_TONE[st], tr.t(KEY_STATUS_TEXT[st]))}${st === 'redeemed' ? html`<br><small class="muted">${tr.t('owner.premium.by')} ${who(k.redeemed_by, k.redeemed_by_username)}, ${formatDate(k.redeemed_at)}</small>` : ''}${st === 'revoked' ? html`<br><small class="muted">${formatDate(k.revoked_at)}</small>` : ''}${st === 'unused' && k.expires_at ? html`<br><small class="muted">${tr.t('owner.premium.until', { date: formatDate(k.expires_at) })}</small>` : ''}${st === 'expired' ? html`<br><small class="muted">${formatDate(k.expires_at)}</small>` : ''}</td>
<td class="nowrap">${st === 'unused' ? actionForm(csrf, '/owner/premium/revoke', '', { submit: tr.t('owner.premium.cancelKey'), hidden: { code: k.code, status: filter }, inline: true, secondary: true, enabled: editEnabled, confirm: tr.t('owner.premium.cancelConfirm', { code: k.code }) }) : ''}</td></tr>`; })}
</tbody></table></div>` : html`<p class="empty">${tr.t('owner.premium.noKeys')}</p>`}</section>
<section class="card"><h2>${tr.t('owner.premium.subscriptions')}${subscriptions ? ` (${subscriptions.length})` : ''}</h2>
${subscriptions === null ? html`<p class="error" role="alert">${tr.t('owner.premium.subscriptionsError')}</p>`
        : subscriptions.length ? html`<div class="scroll"><table><thead><tr><th>${tr.t('owner.premium.account')}</th><th>${tr.t('owner.premium.plan')}</th><th>${tr.t('owner.premium.since')}</th><th>${tr.t('owner.premium.untilHead')}</th><th>${tr.t('owner.premium.lastAdded')}</th><th></th></tr></thead><tbody>
${subscriptions.map((sub) => html`<tr><td>${who(sub.user_id, sub.username)}</td><td>${planName(sub.plan_id)}</td><td>${formatDate(sub.started_at)}</td><td>${formatDate(sub.expires_at)}</td><td>${SOURCE_LABEL[sub.source] ? tr.t(SOURCE_LABEL[sub.source]) : sub.source || '-'}</td>
<td class="nowrap">${actionForm(csrf, '/owner/premium/end', '', { submit: tr.t('owner.premium.endNow'), hidden: { user: sub.user_id }, inline: true, danger: true, enabled: editEnabled, confirm: tr.t('owner.premium.endConfirm', { plan: planName(sub.plan_id), who: sub.username || sub.user_id }) })}</td></tr>`)}
</tbody></table></div>` : html`<p class="empty">${tr.t('owner.premium.noSubscriptions')}</p>`}</section>
<section class="card"><h2>${tr.t('owner.premium.orders')}</h2>
${orders === null ? html`<p class="error" role="alert">${tr.t('owner.premium.ordersError')}</p>`
        : orders.length ? html`<div class="scroll"><table><thead><tr><th>${tr.t('owner.premium.order')}</th><th>${tr.t('owner.common.when')}</th><th>${tr.t('owner.premium.account')}</th><th>${tr.t('owner.premium.plan')}</th><th>${tr.t('owner.premium.for')}</th><th>${tr.t('owner.premium.amount')}</th></tr></thead><tbody>
${orders.map((o) => html`<tr><td><code>#${o.id}</code></td><td>${timeTag(o.created_at)}</td><td>${who(o.user_id, o.username)}</td><td>${planName(o.plan_id)} · ${PERIODS[o.period] ? tr.t(`owner.premium.period_${o.period}`) : o.period}</td><td>${o.kind === 'gift' ? tr.t('owner.premium.gift') : tr.t('owner.premium.ownAccount')}</td><td>${formatPrice(o.amount_cents, orderCurrency(o))}${o.test ? ` ${tr.t('owner.premium.test')}` : ''}</td></tr>`)}
</tbody></table></div>` : html`<p class="empty">${tr.t('owner.premium.noOrders')}</p>`}</section>`;
    return shell({ title: tr.t('owner.premium.title'), active: 'owner/premium', session, access, moduleStates, body });
}
