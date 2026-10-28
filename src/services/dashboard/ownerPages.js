// ownerPages.js — the Owner area pages (bot owners only): bot profile, servers, server
// detail, leave confirm, blacklist, health and maintenance, announce (compose, confirm,
// result). Pure: data in, HTML out, everything escaped by the `html` template. No inline
// styles or scripts (CSP).

import { formatDate, html, layout, path } from './html.js';
import { actionForm } from './enforcementPages.js';
import { isAllowedImageUrl } from './pages.js';
import { ACTIVITY_TEXT_MAX, STATUSES } from '../owner/botStateService.js';
import { BLACKLIST_REASON_MAX } from '../owner/blacklistService.js';

export const USERNAME_MAX = 32;
export const ABOUT_MAX = 400;
export const ANNOUNCE_MAX = 2000;
const STATUS_LABEL = { online: 'Online', idle: 'Idle', dnd: 'Do not disturb', invisible: 'Invisible' };
const ACTIVITY_LABEL = { none: 'No activity', playing: 'Playing', listening: 'Listening to', watching: 'Watching', competing: 'Competing in', custom: 'Custom status' };

function shell({ title, active, session, access, moduleStates, body }) {
    return layout({ title, active, session, access, moduleStates, body });
}

function notices({ flash = null, error = null, editEnabled = true }) {
    return html`${flash ? html`<p class="flash" role="status">${flash}</p>` : ''}
${error ? html`<p class="error" role="alert">${error}</p>` : ''}
${!editEnabled ? html`<p class="notice">Read-only: editing from the dashboard is turned off (DASHBOARD_EDIT_ENABLED is not true).</p>` : ''}`;
}

const opt = (value, label, current) => html`<option value="${value}"${value === current ? html` selected` : ''}>${label}</option>`;
const img = (url, alt, size, className = 'avatar-sm') => (url && isAllowedImageUrl(url)
    ? html`<img class="${className}" src="${url}" alt="${alt}" width="${size}" height="${size}" loading="lazy" referrerpolicy="no-referrer">` : '');

// ── Bot profile ───────────────────────────────────────────────────────────

/** profile: { username, id, avatarUrl, bannerUrl, about, presence: { status, activityType, activityText } }. */
export function profilePage({ session, access = null, moduleStates = {}, profile, flash = null, error = null, editEnabled = true }) {
    const csrf = session.csrf;
    const p = profile.presence || { status: 'online', activityType: 'none', activityText: '' };
    const imageForm = (kind, label) => actionForm(csrf, `/owner/profile/${kind}`, html`<div class="grid">
<label class="wide">Image URL (https)<input name="url" type="url" maxlength="500" placeholder="https://…"></label>
<label class="wide">Or upload (PNG, JPEG, GIF or WebP, up to 8 MB)<input type="file" name="image" accept="image/png,image/jpeg,image/gif,image/webp"></label></div>`,
    { submit: `Change ${label}`, multipart: true, enabled: editEnabled });
    const body = html`<header class="page-head"><h1>Bot profile</h1><p class="muted">How the bot looks on Discord, everywhere. Discord limits how often the name and images can change; its answer is shown here when it refuses.</p></header>
${notices({ flash, error, editEnabled })}
<section class="card"><h2>Now</h2><dl>
<dt>Username</dt><dd>${profile.username || '—'} <span class="muted">${profile.id || ''}</span></dd>
<dt>Avatar</dt><dd>${img(profile.avatarUrl, 'Current avatar', 64) || html`<span class="muted">default</span>`}</dd>
<dt>Banner</dt><dd>${profile.bannerUrl && isAllowedImageUrl(profile.bannerUrl) ? html`<img src="${profile.bannerUrl}" alt="Current banner" width="300" height="106" loading="lazy" referrerpolicy="no-referrer">` : html`<span class="muted">none</span>`}</dd>
<dt>About me</dt><dd>${profile.about || html`<span class="muted">empty</span>`}</dd>
<dt>Status</dt><dd>${STATUS_LABEL[p.status] || p.status}${p.activityType && p.activityType !== 'none' ? html` · ${ACTIVITY_LABEL[p.activityType] || p.activityType} ${p.activityText}` : ''}</dd>
</dl></section>
<section class="card"><h2>Username</h2>${actionForm(csrf, '/owner/profile/username', html`<label class="wide">New username<input name="username" maxlength="${USERNAME_MAX}" minlength="2" required value="${profile.username || ''}"></label>`, { submit: 'Change username', enabled: editEnabled })}
<p class="muted">Discord allows only a few username changes per hour.</p></section>
<section class="card"><h2>Avatar</h2>${imageForm('avatar', 'avatar')}</section>
<section class="card"><h2>Banner</h2>${imageForm('banner', 'banner')}</section>
<section class="card"><h2>About me</h2>${actionForm(csrf, '/owner/profile/about', html`<label class="wide">About me (application description)<textarea name="about" maxlength="${ABOUT_MAX}" rows="4">${profile.about || ''}</textarea></label>`, { submit: 'Save about me', enabled: editEnabled })}</section>
<section class="card"><h2>Status and activity</h2>${actionForm(csrf, '/owner/profile/presence', html`<div class="grid">
<label>Status<select name="status">${STATUSES.map((s) => opt(s, STATUS_LABEL[s], p.status))}</select></label>
<label>Activity<select name="activityType">${Object.keys(ACTIVITY_LABEL).map((k) => opt(k, ACTIVITY_LABEL[k], p.activityType || 'none'))}</select></label>
<label class="wide">Activity text<input name="activityText" maxlength="${ACTIVITY_TEXT_MAX}" value="${p.activityText || ''}"></label></div>`, { submit: 'Save status', enabled: editEnabled })}
<p class="muted">Kept after a restart.</p></section>`;
    return shell({ title: 'Bot profile', active: 'owner/profile', session, access, moduleStates, body });
}

// ── Servers ───────────────────────────────────────────────────────────────

/** rows: [{ id, name, iconUrl, ownerId, ownerName, memberCount, joinedAt }]. */
export function serversPage({ session, access = null, moduleStates = {}, rows = [], total = rows.length, q = '', flash = null }) {
    const table = rows.length ? html`<div class="table-wrap"><table class="members"><thead><tr><th>Server</th><th>Owner</th><th>Members</th><th>Bot joined</th></tr></thead><tbody>
${rows.map((row) => html`<tr><td><a class="member-cell" href="${path(`/owner/servers/${row.id}`)}">${img(row.iconUrl, '', 32) || html`<span class="avatar-sm" aria-hidden="true">${String(row.name || '?').slice(0, 1).toUpperCase()}</span>`}<span><b>${row.name}</b><small>${row.id}</small></span></a></td>
<td>${row.ownerName || html`<span class="muted">unknown</span>`}<br><small class="muted">${row.ownerId || '—'}</small></td>
<td>${row.memberCount ?? '—'}</td><td>${formatDate(row.joinedAt)}</td></tr>`)}
</tbody></table></div>` : html`<p class="empty">${q ? 'No server matches.' : 'The bot is in no server.'}</p>`;
    const body = html`<header class="page-head"><h1>Servers</h1><p class="muted">Every server the bot is in (${total}).</p></header>
${flash ? html`<p class="flash" role="status">${flash}</p>` : ''}
<form class="filters" method="get" action="${path('/owner/servers')}" role="search"><label class="wide-filter">Search<input type="search" name="q" value="${q}" maxlength="100" autocomplete="off" placeholder="Name or server ID"></label>
<button class="primary" type="submit">Search</button> <a href="${path('/owner/servers')}">Clear</a></form>${table}`;
    return shell({ title: 'Servers', active: 'owner/servers', session, access, moduleStates, body });
}

/**
 * detail: { id, name, iconUrl, ownerId, ownerName, memberCount, joinedAt, channels: [{ name,
 * type, category }], roles: [{ name, color, members }], permissions: [string], vanityUrl,
 * canCreateInvite, canLeave, membersCached }.
 */
export function serverPage({ session, access = null, moduleStates = {}, detail, flash = null, error = null, editEnabled = true }) {
    const csrf = session.csrf;
    const inviteBits = [
        detail.vanityUrl ? html`<p>Public invite (vanity URL): <a href="${detail.vanityUrl}" rel="noopener noreferrer nofollow" target="_blank">${detail.vanityUrl}</a></p>` : '',
        detail.canCreateInvite ? actionForm(csrf, `/owner/servers/${detail.id}/invite`, html`<p class="muted">You own this server or have Administrator there. The invite works once and expires after 1 hour.</p>`, { submit: 'Create invite', enabled: editEnabled }) : '',
    ].filter(Boolean);
    const body = html`<a class="back" href="${path('/owner/servers')}">← Servers</a>
<header class="page-head"><h1>${detail.name}</h1><p class="muted">${detail.id} · owner ${detail.ownerName || 'unknown'} (${detail.ownerId || '—'}) · ${detail.memberCount ?? '—'} members · bot joined ${formatDate(detail.joinedAt)}</p></header>
${notices({ flash, error, editEnabled })}
${inviteBits.length ? html`<section class="card"><h2>Invite</h2>${inviteBits}</section>` : ''}
<section class="card"><h2>Bot permissions here</h2>${detail.permissions.length ? html`<ul class="name-list">${detail.permissions.map((p) => html`<li>${p}</li>`)}</ul>` : html`<p class="empty">None.</p>`}</section>
<section class="card"><h2>Channels (${detail.channels.length})</h2>${detail.channels.length ? html`<div class="table-wrap"><table><thead><tr><th>Name</th><th>Type</th><th>Category</th></tr></thead><tbody>
${detail.channels.map((c) => html`<tr><td>${c.name}</td><td>${c.type}</td><td>${c.category || html`<span class="muted">—</span>`}</td></tr>`)}</tbody></table></div>` : html`<p class="empty">No channels visible.</p>`}</section>
<section class="card"><h2>Roles (${detail.roles.length})</h2>${detail.roles.length ? html`<div class="table-wrap"><table><thead><tr><th>Name</th><th>Colour</th><th>Members</th></tr></thead><tbody>
${detail.roles.map((r) => html`<tr><td>${r.name}</td><td><code>${r.color}</code></td><td>${r.members}</td></tr>`)}</tbody></table></div>
${detail.membersCached ? '' : html`<p class="muted">Member counts come from the bot's member cache, which is not complete for this server.</p>`}` : html`<p class="empty">No roles.</p>`}</section>
<section class="card"><h2>Leave server</h2>${detail.canLeave
        ? actionForm(csrf, `/owner/servers/${detail.id}/leave/preview`, html`<p class="muted">The bot leaves this server. Only someone with Manage Server there can add it back.</p>`, { submit: 'Leave server…', danger: true, enabled: editEnabled })
        : html`<p class="muted">The main and the support server cannot be left from here.</p>`}</section>`;
    return shell({ title: detail.name, active: 'owner/servers', session, access, moduleStates, body });
}

export function leaveConfirmPage({ session, access = null, moduleStates = {}, guild, token, hash }) {
    const body = html`<p><a href="${path(`/owner/servers/${guild.id}`)}">← Back (cancel)</a></p>
<h1>Confirm: leave ${guild.name}</h1>
<section class="card confirm-card"><dl><dt>Server</dt><dd>${guild.name} <span class="muted">${guild.id}</span></dd><dt>Members</dt><dd>${guild.memberCount ?? '—'}</dd>
<dt>Effect</dt><dd>The bot leaves the server now. Its settings and records stay in the database.</dd></dl>
<p class="muted">This confirmation works once and expires in 5 minutes.</p>
${actionForm(session.csrf, `/owner/servers/${guild.id}/leave`, html`<label class="check"><input type="checkbox" name="confirm" value="1" required> I want the bot to leave ${guild.name}</label>`, { submit: 'Leave server', hidden: { token, fh: hash }, danger: true })}</section>`;
    return shell({ title: `Leave ${guild.name}`, active: 'owner/servers', session, access, moduleStates, body });
}

// ── Blacklist ─────────────────────────────────────────────────────────────

/** active / removed: bot_blacklist rows. names: Map id → display name. */
export function blacklistPage({ session, access = null, moduleStates = {}, active = [], removed = [], names = new Map(), flash = null, error = null, values = {}, editEnabled = true }) {
    const csrf = session.csrf;
    const who = (id, name) => html`${name || id}${name ? html` <small class="muted">${id}</small>` : ''}`;
    const kindLabel = (kind) => (kind === 'guild' ? 'Server' : 'User');
    const body = html`<header class="page-head"><h1>Blacklist</h1><p class="muted">Blacklisted users get “You can't use this bot.” for every command, button and form. A blacklisted server is ignored: the bot does not answer its commands. Bot owners can never be blacklisted.</p></header>
${notices({ flash, error, editEnabled })}
<section class="card"><h2>Add</h2>${actionForm(csrf, '/owner/blacklist/add', html`<div class="grid">
<label>Kind<select name="kind">${opt('user', 'User', values.kind || 'user')}${opt('guild', 'Server', values.kind)}</select></label>
<label>Discord ID<input name="id" inputmode="numeric" maxlength="20" required value="${values.id || ''}"></label>
<label class="wide">Reason<input name="reason" maxlength="${BLACKLIST_REASON_MAX}" required value="${values.reason || ''}"></label></div>`, { submit: 'Add to blacklist', danger: true, enabled: editEnabled })}</section>
<section class="card"><h2>Blacklisted (${active.length})</h2>${active.length ? html`<div class="table-wrap"><table><thead><tr><th>Who</th><th>Reason</th><th>Added</th><th></th></tr></thead><tbody>
${active.map((row) => html`<tr><td>${kindLabel(row.kind)}: ${who(row.target_id, names.get(row.target_id))}</td><td>${row.reason}</td><td>${row.added_by_username || row.added_by}<br><small class="muted">${formatDate(row.created_at)}</small></td>
<td class="nowrap">${actionForm(csrf, '/owner/blacklist/remove', '', { submit: 'Undo', hidden: { entry: String(row.id) }, inline: true, secondary: true, enabled: editEnabled, confirm: `Remove ${row.target_id} from the blacklist?` })}</td></tr>`)}
</tbody></table></div>` : html`<p class="empty">Nobody is blacklisted.</p>`}</section>
${removed.length ? html`<section class="card"><h2>Recently removed</h2><div class="table-wrap"><table><thead><tr><th>Who</th><th>Reason</th><th>Added</th><th>Removed</th></tr></thead><tbody>
${removed.map((row) => html`<tr><td>${kindLabel(row.kind)}: ${who(row.target_id, names.get(row.target_id))}</td><td>${row.reason}</td><td>${row.added_by_username || row.added_by}<br><small class="muted">${formatDate(row.created_at)}</small></td><td>${row.removed_by_username || row.removed_by}<br><small class="muted">${formatDate(row.removed_at)}</small></td></tr>`)}
</tbody></table></div></section>` : ''}`;
    return shell({ title: 'Blacklist', active: 'owner/blacklist', session, access, moduleStates, body });
}

// ── Health ────────────────────────────────────────────────────────────────

function duration(seconds) {
    const s = Math.max(0, Math.floor(seconds || 0));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
}
const mb = (bytes) => `${Math.round((bytes || 0) / 1024 / 1024)} MB`;

/** health: { uptimeSeconds, gatewayUptimeMs, ping, memory, node, version, servers, database, maintenance }. */
export function healthPage({ session, access = null, moduleStates = {}, health, flash = null, error = null, editEnabled = true }) {
    const db = health.database;
    const body = html`<header class="page-head"><h1>Health</h1><p class="muted">The bot process right now.</p></header>
${notices({ flash, error, editEnabled })}
<section class="card"><h2>Status</h2><dl>
<dt>Uptime</dt><dd>${duration(health.uptimeSeconds)}${health.gatewayUptimeMs != null ? html` <span class="muted">(gateway connected ${duration(health.gatewayUptimeMs / 1000)})</span>` : ''}</dd>
<dt>Gateway ping</dt><dd>${Number.isFinite(health.ping) && health.ping >= 0 ? `${Math.round(health.ping)} ms` : '—'}</dd>
<dt>Memory</dt><dd>${mb(health.memory?.rss)} in use · heap ${mb(health.memory?.heapUsed)} of ${mb(health.memory?.heapTotal)}</dd>
<dt>Node</dt><dd>${health.node}</dd>
<dt>Bot version</dt><dd>${health.version || '—'}</dd>
<dt>Servers</dt><dd>${health.servers}</dd>
<dt>Blacklist</dt><dd>${health.blacklistLoaded === false ? html`<span class="state-word is-bad"><span class="dot dot-bad" aria-hidden="true"></span>Not loaded: nobody is blocked until the database answers (retrying)</span>` : html`<span class="state-word is-on"><span class="dot dot-on" aria-hidden="true"></span>Loaded</span>`}</dd>
<dt>Database</dt><dd>${db ? html`<span class="state-word is-${db.connected ? 'on' : 'bad'}"><span class="dot dot-${db.connected ? 'on' : 'bad'}" aria-hidden="true"></span>${db.connected ? `Connected (${db.type})` : `Degraded (${db.type || 'none'})`}</span>` : 'Unknown'}</dd>
</dl></section>
<section class="card"><h2>Recent errors</h2><p class="muted">Not shown: the logger writes error lines to its log files only and keeps none in memory.</p></section>
<section class="card"><h2>Maintenance mode</h2><p>${health.maintenance ? html`<span class="state-word is-warn"><span class="dot dot-warn" aria-hidden="true"></span>On: only bot owners can run commands.</span>` : html`<span class="state-word is-off"><span class="dot dot-off" aria-hidden="true"></span>Off</span>`}</p>
${actionForm(session.csrf, '/owner/health/maintenance', '', { submit: health.maintenance ? 'Turn maintenance off' : 'Turn maintenance on', hidden: { enabled: health.maintenance ? 'off' : 'on' }, danger: !health.maintenance, enabled: editEnabled })}
<p class="muted">Kept after a restart.</p></section>`;
    return shell({ title: 'Health', active: 'owner/health', session, access, moduleStates, body });
}

// ── Announce ──────────────────────────────────────────────────────────────

/** targets: { sendable: [{ guildId, guildName, channelId, channelName }], skipped: [{ guildId, guildName, why }] }. */
function targetLists(targets) {
    return html`<section class="card"><h2>Will be posted in (${targets.sendable.length})</h2>${targets.sendable.length
        ? html`<ul class="name-list">${targets.sendable.map((t) => html`<li>${t.guildName} <span class="muted">#${t.channelName}</span></li>`)}</ul>` : html`<p class="empty">No server has a log channel the bot can post in.</p>`}</section>
${targets.skipped.length ? html`<section class="card"><h2>Skipped (${targets.skipped.length})</h2><ul class="skip-list">${targets.skipped.map((t) => html`<li>${t.guildName} <span class="muted">${t.why}</span></li>`)}</ul></section>` : ''}`;
}

export function announcePage({ session, access = null, moduleStates = {}, targets, message = '', error = null, editEnabled = true }) {
    const body = html`<header class="page-head"><h1>Announce</h1><p class="muted">One plain-text message to every server's log channel (alerts or mod log in the main server, else the logging channel). Mentions never ping. You confirm on the next page.</p></header>
${notices({ error, editEnabled })}
<section class="card"><h2>Message</h2>${actionForm(session.csrf, '/owner/announce/preview', html`<label class="wide">Text<textarea name="message" maxlength="${ANNOUNCE_MAX}" rows="6" required>${message}</textarea></label>`, { submit: 'Preview', enabled: editEnabled })}</section>
${targetLists(targets)}`;
    return shell({ title: 'Announce', active: 'owner/announce', session, access, moduleStates, body });
}

export function announceConfirmPage({ session, access = null, moduleStates = {}, message, targets, token, hash }) {
    const body = html`<p><a href="${path('/owner/announce')}">← Back (cancel)</a></p>
<h1>Confirm: announce to ${targets.sendable.length} server${targets.sendable.length === 1 ? '' : 's'}</h1>
<section class="card confirm-card"><h2>Message</h2><blockquote>${message}</blockquote>
<p class="muted">This confirmation works once and expires in 5 minutes.</p>
${targets.sendable.length ? actionForm(session.csrf, '/owner/announce/send', html`<label class="check"><input type="checkbox" name="confirm" value="1" required> Send this to ${targets.sendable.length} server${targets.sendable.length === 1 ? '' : 's'}</label>`, { submit: 'Send announcement', hidden: { token, fh: hash }, danger: true }) : ''}</section>
${targetLists(targets)}`;
    return shell({ title: 'Confirm announcement', active: 'owner/announce', session, access, moduleStates, body });
}

/** result: { sent: [{ guildName, channelName }], failed: [{ guildName, why }], skipped: [{ guildName, why }] }. */
export function announceResultPage({ session, access = null, moduleStates = {}, result }) {
    const body = html`<p><a href="${path('/owner/announce')}">← Announce</a></p>
<header class="page-head"><h1>Announcement sent</h1><p class="muted">Posted in ${result.sent.length}, failed in ${result.failed.length}, skipped ${result.skipped.length}.</p></header>
<section class="card"><h2>Posted (${result.sent.length})</h2>${result.sent.length ? html`<ul class="name-list">${result.sent.map((t) => html`<li>${t.guildName} <span class="muted">#${t.channelName}</span></li>`)}</ul>` : html`<p class="empty">Nowhere.</p>`}</section>
${result.failed.length ? html`<section class="card"><h2>Failed (${result.failed.length})</h2><ul class="skip-list">${result.failed.map((t) => html`<li>${t.guildName} <span class="muted">${t.why}</span></li>`)}</ul></section>` : ''}
${result.skipped.length ? html`<section class="card"><h2>Skipped (${result.skipped.length})</h2><ul class="skip-list">${result.skipped.map((t) => html`<li>${t.guildName} <span class="muted">${t.why}</span></li>`)}</ul></section>` : ''}`;
    return shell({ title: 'Announcement sent', active: 'owner/announce', session, access, moduleStates, body });
}

