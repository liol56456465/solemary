// ownerPages.js — the Owner area pages (bot owners only): overview, bot profile, servers,
// server detail, leave confirm, user lookup, blacklist, health and maintenance, announce (compose,
// confirm, result), activity (the owner audit rows). Pure: data in, HTML out, everything escaped by the `html` template. No inline
// styles or scripts (CSP).

import { formatDate, html, layout, path, queryString, timeTag } from './html.js';
import { actionForm } from './enforcementPages.js';
import { auditValue, isAllowedImageUrl } from './pages.js';
import { kpi, tile } from './overview.js';
import { ACTIVITY_TEXT_MAX, STATUSES } from '../owner/botStateService.js';
import { BLACKLIST_REASON_MAX } from '../owner/blacklistService.js';
import { countedWarnsText } from '../enforcement/flowBuilder.js';

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
const stateWord = (tone, label) => html`<span class="state-word is-${tone}"><span class="dot dot-${tone}" aria-hidden="true"></span>${label}</span>`;

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

export const SERVER_SORTS = { name: 'Name', members: 'Most members', newest: 'Joined most recently', oldest: 'Joined first' };
const TAG_TONE = { Main: 'on', Support: 'on', Blacklisted: 'bad' };
const serverTags = (tags = []) => tags.map((t) => html` <span class="state-word is-${TAG_TONE[t] || 'off'}"><span class="dot dot-${TAG_TONE[t] || 'off'}" aria-hidden="true"></span>${t}</span>`);
const serverInitial = (row) => html`<span class="avatar-sm" aria-hidden="true">${String(row.name || '?').slice(0, 1).toUpperCase()}</span>`;

/**
 * rows: [{ id, name, iconUrl, ownerId, ownerName, memberCount, joinedAt, tags }]; totals: { servers,
 * members, joinedWeek } over every server (not only the matching ones).
 */
export function serversPage({ session, access = null, moduleStates = {}, rows = [], total = rows.length, totals = null, q = '', sort = 'name', flash = null }) {
    const table = rows.length ? html`<div class="table-wrap"><table class="members"><thead><tr><th>Server</th><th>Owner</th><th>Members</th><th>Bot joined</th></tr></thead><tbody>
${rows.map((row) => html`<tr><td><a class="member-cell" href="${path(`/owner/servers/${row.id}`)}">${img(row.iconUrl, '', 32) || serverInitial(row)}<span><b>${row.name}</b>${serverTags(row.tags)}<small>${row.id}</small></span></a></td>
<td>${row.ownerName || html`<span class="muted">unknown</span>`}<br><small class="muted">${row.ownerId || '—'}</small></td>
<td>${row.memberCount ?? '—'}</td><td>${formatDate(row.joinedAt)}</td></tr>`)}
</tbody></table></div>` : html`<p class="empty">${q ? 'No server matches.' : 'The bot is in no server.'}</p>`;
    const summary = totals
        ? `Every server the bot is in: ${totals.servers} server${totals.servers === 1 ? '' : 's'}, ${totals.members} members in total, ${totals.joinedWeek} joined in the last 7 days.`
        : `Every server the bot is in (${total}).`;
    const body = html`<header class="page-head"><h1>Servers</h1><p class="muted">${summary}</p></header>
${flash ? html`<p class="flash" role="status">${flash}</p>` : ''}
<form class="filters" method="get" action="${path('/owner/servers')}" role="search"><label class="wide-filter">Search<input type="search" name="q" value="${q}" maxlength="100" autocomplete="off" placeholder="Name or server ID"></label>
<label>Sort<select name="sort">${Object.entries(SERVER_SORTS).map(([key, label]) => opt(key, label, sort))}</select></label>
<button class="primary" type="submit">Show</button> <a href="${path('/owner/servers')}">Clear</a></form>
${rows.length < total ? html`<p class="muted">Showing ${rows.length} of ${total}.</p>` : ''}${table}`;
    return shell({ title: 'Servers', active: 'owner/servers', session, access, moduleStates, body });
}

/**
 * detail: { id, name, iconUrl, ownerId, ownerName, memberCount, joinedAt, channels: [{ name,
 * type, category }], roles: [{ name, color, members }], permissions: [string], missing: [{ label, why }],
 * botTop: { name, position } | null, rolesAbove: [{ name, why }], vanityUrl, canCreateInvite, canLeave,
 * membersCached }.
 */
export function serverPage({ session, access = null, moduleStates = {}, detail, flash = null, error = null, editEnabled = true }) {
    const csrf = session.csrf;
    const inviteBits = [
        detail.vanityUrl ? html`<p>Public invite (vanity URL): <a href="${detail.vanityUrl}" rel="noopener noreferrer nofollow" target="_blank">${detail.vanityUrl}</a></p>` : '',
        detail.canCreateInvite ? actionForm(csrf, `/owner/servers/${detail.id}/invite`, html`<p class="muted">You own this server or have Administrator there. The invite works once and expires after 1 hour.</p>`, { submit: 'Create invite', enabled: editEnabled }) : '',
    ].filter(Boolean);
    const body = html`<a class="back" href="${path('/owner/servers')}">← Servers</a>
<header class="page-head"><h1>${detail.name}${serverTags(detail.tags)}</h1><p class="muted">${detail.id} · owner ${detail.ownerName || 'unknown'} (${detail.ownerId || '—'}) · ${detail.memberCount ?? '—'} members · bot joined ${formatDate(detail.joinedAt)}</p></header>
${notices({ flash, error, editEnabled })}
<section class="card"><h2>About this server</h2><dl>
<dt>Created</dt><dd>${detail.createdAt ? formatDate(detail.createdAt) : '—'}</dd>
<dt>Boosts</dt><dd>${detail.boosts ?? 0} (level ${detail.boostTier ?? 0})</dd>
<dt>Verification level</dt><dd>${detail.verificationLevel || '—'}</dd>
<dt>Channels / roles</dt><dd>${detail.channels.length} / ${detail.roles.length}</dd>
<dt>Blacklist</dt><dd>${detail.blacklisted
        ? html`<span class="state-word is-bad"><span class="dot dot-bad" aria-hidden="true"></span>Blacklisted: the bot ignores this server</span> <a href="${path('/owner/blacklist')}">Blacklist</a>`
        : detail.canLeave
            ? html`Not blacklisted · <a href="${path(`/owner/blacklist${queryString({ kind: 'guild', id: detail.id })}`)}">Blacklist this server…</a> <span class="muted">(fills in the form; you add a reason there)</span>`
            : html`<span class="muted">The main and the support server cannot be blacklisted.</span>`}</dd>
</dl></section>
${inviteBits.length ? html`<section class="card"><h2>Invite</h2>${inviteBits}</section>` : ''}
<section class="card"><h2>Permission check</h2>${detail.missing?.length
        ? html`<p class="error" role="alert">The bot is missing ${detail.missing.length} permission${detail.missing.length === 1 ? '' : 's'} it asks for when added; those features fail here.</p>
<ul class="skip-list">${detail.missing.map((m) => html`<li><b>${m.label}</b> <span class="muted">— ${m.why}</span></li>`)}</ul>`
        : html`<p>${stateWord('on', 'The bot has every permission it asks for when added.')}</p>`}
${detail.rolesAbove?.length
        ? html`<p class="error" role="alert">These roles are at or above the bot's highest role${detail.botTop ? html` (${detail.botTop.name})` : ''}, so the bot cannot give or remove them. Move the bot's role above them in Server Settings → Roles.</p>
<ul class="skip-list">${detail.rolesAbove.map((r) => html`<li><b>${r.name}</b> <span class="muted">— ${r.why}</span></li>`)}</ul>`
        : detail.botTop ? html`<p class="muted">No known role the bot manages (Muted, warning or Banned role) is above its highest role (${detail.botTop.name}).</p>` : ''}</section>
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

// ── User lookup ───────────────────────────────────────────────────────────

/** The main-server record: ladder, cases, active ban / mute, with links to the existing pages. */
function recordSection(r) {
    const caseLink = (c) => html`<a href="${path(`/cases/${c.case_code}`)}"><code>${c.case_code}</code></a>${c.expires_at ? html` · ends ${formatDate(c.expires_at)}` : html` · no end date`}`;
    const body = r.recordError
        ? html`<p class="error" role="alert">${r.recordError}</p>`
        : html`<dl>
<dt>Warn ladder</dt><dd>Level ${r.record.ladder?.level ?? 0} · counted warns ${countedWarnsText(r.record.ladder || { level: 0, warns_since_level: 0 })}</dd>
<dt>Cases</dt><dd>${r.record.caseCount ?? 0}${r.record.caseCount ? html` · <a href="${path(`/cases${queryString({ member: r.id })}`)}">All cases</a>` : ''}</dd>
<dt>Active ban</dt><dd>${r.record.activeBan ? html`${stateWord('bad', 'Banned')} ${caseLink(r.record.activeBan)}` : 'None'}</dd>
<dt>Active mute</dt><dd>${r.record.activeMute ? html`${stateWord('warn', 'Muted')} ${caseLink(r.record.activeMute)}` : 'None'}</dd>
</dl>`;
    return html`<section class="card"><h2>Main server record</h2>${body}
<p><a href="${path(`/users/${r.id}`)}">Open the member page</a> <span class="muted">(Members area; actions there need Administrator in the main server)</span></p></section>`;
}

/**
 * result: { id, username, globalName, bot, avatarUrl, createdAt, servers: [{ id, name, tags, joinedAt,
 * nickname }], totalServers, blacklist: { state, entry }, isOwner, offerBlacklist, record, recordError }.
 */
export function userLookupPage({ session, access = null, moduleStates = {}, q = '', result = null, error = null }) {
    const r = result;
    const blacklistText = !r ? '' : r.blacklist.state === 'unknown'
        ? html`<span class="error" role="alert">The blacklist could not be read (database). Reload to try again.</span>`
        : r.blacklist.state === 'listed'
            ? html`${stateWord('bad', 'Blacklisted')} ${r.blacklist.entry.reason} · <a href="${path('/owner/blacklist')}">Blacklist</a>`
            : r.isOwner
                ? html`Not blacklisted <span class="muted">(bot owners can never be blacklisted)</span>`
                : html`Not blacklisted${r.offerBlacklist ? html` · <a href="${path(`/owner/blacklist${queryString({ kind: 'user', id: r.id })}`)}">Blacklist this user…</a> <span class="muted">(fills in the form; you add a reason there)</span>` : ''}`;
    const servers = !r ? '' : html`<section class="card"><h2>Shared servers (${r.servers.length})</h2>${r.servers.length
        ? html`<div class="table-wrap"><table><thead><tr><th>Server</th><th>Nickname</th><th>Joined</th></tr></thead><tbody>
${r.servers.map((g) => html`<tr><td><a href="${path(`/owner/servers/${g.id}`)}"><b>${g.name}</b></a>${serverTags(g.tags)}<br><small class="muted">${g.id}</small></td><td>${g.nickname || html`<span class="muted">—</span>`}</td><td>${formatDate(g.joinedAt)}</td></tr>`)}
</tbody></table></div>` : html`<p class="empty">No shared server found.</p>`}
<p class="muted">The main and the support server are asked directly. Every other server is checked only in the bot's member cache, which is often incomplete, so the user may be in a server not listed here.</p></section>`;
    const body = html`<header class="page-head"><h1>Users</h1><p class="muted">Look up one Discord user by ID: account, shared servers, blacklist and the main server's moderation record. Read-only.</p></header>
<form class="filters" method="get" action="${path('/owner/users')}" role="search"><label class="wide-filter">User ID<input type="search" name="q" value="${q}" inputmode="numeric" maxlength="25" autocomplete="off" placeholder="Discord user ID"></label>
<button class="primary" type="submit">Look up</button>${q ? html` <a href="${path('/owner/users')}">Clear</a>` : ''}</form>
${error ? html`<p class="error" role="alert">${error}</p>` : ''}
${r ? html`<section class="card"><h2>${r.globalName || r.username || r.id}</h2>${img(r.avatarUrl, '', 64)}<dl>
<dt>Username</dt><dd>${r.username || '—'}${r.bot ? html` <span class="muted">(bot account)</span>` : ''}</dd>
<dt>Display name</dt><dd>${r.globalName || html`<span class="muted">none</span>`}</dd>
<dt>ID</dt><dd><code>${r.id}</code></dd>
<dt>Account created</dt><dd>${formatDate(r.createdAt)}</dd>
<dt>Bot owner</dt><dd>${r.isOwner ? stateWord('on', 'Yes (OWNER_IDS)') : 'No'}</dd>
<dt>Blacklist</dt><dd>${blacklistText}</dd>
</dl></section>
${recordSection(r)}
${servers}` : ''}`;
    return shell({ title: 'Users', active: 'owner/users', session, access, moduleStates, body });
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

// ── Overview and activity ─────────────────────────────────────────────────

/** What an owner audit row did, in words (keys written by ownerRoutes.js). names: id → server name. */
export function ownerActionText(key, names = new Map()) {
    const k = String(key || '');
    const server = (id) => names.get(id) || id;
    let m;
    if (k === 'maintenance') return 'Maintenance mode';
    if (k === 'announce') return 'Announcement to every server';
    if ((m = /^profile\.(username|about|presence|avatar|banner)$/.exec(k))) {
        return `Bot profile: ${{ username: 'username', about: 'about me', presence: 'status', avatar: 'avatar', banner: 'banner' }[m[1]]}`;
    }
    if ((m = /^servers\.(\d+)\.invite$/.exec(k))) return `Invite created in ${server(m[1])}`;
    if ((m = /^servers\.(\d+)\.leave$/.exec(k))) return `Left ${server(m[1])}`;
    if ((m = /^blacklist\.(user|guild)\.(\d+)$/.exec(k))) return `Blacklist: ${m[1] === 'guild' ? `server ${server(m[2])}` : `user ${m[2]}`}`;
    return k;
}

function actionList(rows, names) {
    return html`<ul class="activity">${rows.map((r) => html`<li>
<span class="avatar-initials" aria-hidden="true">${String(r.username || '?').slice(0, 1).toUpperCase()}</span>
<span class="activity-text"><strong>${r.username || r.user_id || 'someone'}</strong> · ${ownerActionText(r.key, names)}
<span class="activity-values muted">${auditValue(r.old)} → ${auditValue(r.new)}</span></span>
<span class="activity-time muted">${timeTag(r.created_at)}</span></li>`)}</ul>`;
}

function serverFeed(rows, sub) {
    return rows.length ? html`<ul class="feed">${rows.map((row) => html`<li>${img(row.iconUrl, '', 32) || serverInitial(row)}<span class="feed-text"><a href="${path(`/owner/servers/${row.id}`)}"><b>${row.name}</b></a>${serverTags(row.tags)}<small>${sub(row)}</small></span></li>`)}</ul>`
        : html`<p class="empty">None.</p>`;
}

/**
 * home: { totals: { servers, members, joinedWeek }, recent: [server rows], largest: [server rows],
 * health (collectHealth), blacklistCount (undefined = unavailable), actions (audit rows; null = unavailable), names }.
 */
export function ownerHomePage({ session, access = null, moduleStates = {}, home }) {
    const h = home.health;
    const db = h.database;
    const ping = Number.isFinite(h.ping) && h.ping >= 0 ? `${Math.round(h.ping)} ms gateway ping` : 'gateway ping unknown';
    const body = html`<header class="page-head"><h1>Owner overview</h1><p class="muted">The bot across every server. Only bot owners (OWNER_IDS) see this area.</p></header>
${h.maintenance ? html`<p class="notice">Maintenance mode is on: only bot owners can run commands. <a href="${path('/owner/health')}">Turn it off on Health</a></p>` : ''}
${db && !db.connected ? html`<p class="error" role="alert">The database is degraded (${db.type || 'none'}). <a href="${path('/owner/health')}">Health</a></p>` : ''}
<div class="bento">
${kpi('Servers', h.servers, `${home.totals.members} members in total · ${home.totals.joinedWeek} new this week`, { dark: true, href: path('/owner/servers') })}
${kpi('Uptime', duration(h.uptimeSeconds), ping)}
${kpi('Database', db ? (db.connected ? 'OK' : 'Degraded') : 'Unknown', db ? `${db.type || 'none'} · memory ${mb(h.memory?.rss)}` : `memory ${mb(h.memory?.rss)}`, { href: path('/owner/health') })}
${kpi('Blacklist', home.blacklistCount, home.blacklistCount === undefined ? 'could not be loaded' : 'active entries', { href: path('/owner/blacklist') })}
${tile(7, 'Joined recently', serverFeed(home.recent, (row) => `${row.memberCount ?? '—'} members · joined ${formatDate(row.joinedAt)}`), { link: { href: path(`/owner/servers${queryString({ sort: 'newest' })}`), text: 'All servers' } })}
${tile(5, 'Largest servers', serverFeed(home.largest, (row) => `${row.memberCount ?? '—'} members`), { link: { href: path(`/owner/servers${queryString({ sort: 'members' })}`), text: 'By size' } })}
${tile(12, 'Recent owner actions', home.actions === null
        ? html`<p class="muted">Unavailable (database).</p>`
        : home.actions.length ? actionList(home.actions, home.names) : html`<p class="empty">No owner actions yet.</p>`, { link: { href: path('/owner/activity'), text: 'All activity' } })}
</div>`;
    return shell({ title: 'Owner overview', active: 'owner/home', session, access, moduleStates, body });
}

/** rows: owner audit rows (newest first); null = the audit store could not be read. */
export function activityPage({ session, access = null, moduleStates = {}, rows, total = 0, page = 0, pageSize = 50, names = new Map() }) {
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const pager = html`<div class="pager">
${page > 0 ? html`<a href="${path(`/owner/activity${queryString({ page: page - 1 })}`)}">← Newer</a>` : ''}
<span class="muted">Page ${page + 1} of ${pages} · ${total} action${total === 1 ? '' : 's'}</span>
${page + 1 < pages ? html`<a href="${path(`/owner/activity${queryString({ page: page + 1 })}`)}">Older →</a>` : ''}
</div>`;
    const body = html`<header class="page-head"><h1>Owner activity</h1><p class="muted">Everything done in the Owner area: profile changes, invites, leaving servers, blacklist, maintenance and announcements. Not shown in the server's audit log.</p></header>
${rows === null ? html`<p class="error" role="alert">The activity could not be loaded (database). Reload the page to try again.</p>`
        : rows.length ? html`<div class="scroll"><table><thead><tr><th>When</th><th>Who</th><th>What</th><th>Before</th><th>After</th></tr></thead><tbody>
${rows.map((r) => html`<tr><td>${timeTag(r.created_at)}</td><td>${r.username || r.user_id || '—'} <span class="muted">${r.user_id || ''}</span></td><td>${ownerActionText(r.key, names)}</td><td class="value">${auditValue(r.old)}</td><td class="value">${auditValue(r.new)}</td></tr>`)}
</tbody></table></div>${pager}` : html`<p class="empty">No owner actions yet.</p>`}`;
    return shell({ title: 'Owner activity', active: 'owner/activity', session, access, moduleStates, body });
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

export const RECENT_LOGS_SHOWN = 25;

/** The newest warnings and errors (recentLogs.js: already masked and cut), newest first. */
function recentLogsSection(lines) {
    const list = Array.isArray(lines) ? lines.slice(0, RECENT_LOGS_SHOWN) : [];
    const errors = list.filter((l) => l.level === 'error').length;
    return html`<section class="card"><h2>Recent warnings and errors</h2>
<p class="muted">Since the last restart, newest first (${list.length}${Array.isArray(lines) && lines.length > list.length ? ` of ${lines.length}` : ''}${errors ? `, ${errors} error${errors === 1 ? '' : 's'}` : ''}). Kept in memory only; tokens, passwords and long keys are masked. The full lines are in the host's logs.</p>
${list.length ? html`<div class="scroll"><table><thead><tr><th>When</th><th>Level</th><th>Message</th></tr></thead><tbody>
${list.map((l) => html`<tr><td class="nowrap">${timeTag(l.at)}</td><td><span class="state-word is-${l.level === 'error' ? 'bad' : 'warn'}"><span class="dot dot-${l.level === 'error' ? 'bad' : 'warn'}" aria-hidden="true"></span>${l.level === 'error' ? 'Error' : 'Warning'}</span></td><td class="value">${l.text}${l.traceId ? html`<br><small class="muted">${l.traceId}</small>` : ''}</td></tr>`)}
</tbody></table></div>` : html`<p class="empty">No warnings or errors since the last restart.</p>`}</section>`;
}

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
${recentLogsSection(health.recentLogs)}
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

