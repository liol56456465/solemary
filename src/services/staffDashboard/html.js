// html.js — tiny server-side HTML templating for the staff dashboard.
//
// `html` is a tagged template: every interpolated value is HTML-escaped unless it is
// the result of another `html` call (or `raw`, for the few trusted constants). Arrays
// are joined. null / undefined / false render as nothing. There is no other way to
// put text into a page, so user-provided strings are always escaped.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

export function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"'`]/g, (c) => ESCAPES[c]);
}

class SafeHtml {
    constructor(text) { this.text = text; }
    toString() { return this.text; }
}

/** Trusted markup (constants only — never user input). */
export function raw(text) {
    return new SafeHtml(String(text));
}

function render(value) {
    if (value === null || value === undefined || value === false) return '';
    if (value instanceof SafeHtml) return value.text;
    if (Array.isArray(value)) return value.map(render).join('');
    return escapeHtml(value);
}

export function html(strings, ...values) {
    let out = strings[0];
    for (let i = 0; i < values.length; i += 1) out += render(values[i]) + strings[i + 1];
    return new SafeHtml(out);
}

/** Builds a query string from an object, skipping empty values (values are URL-encoded). */
export function queryString(params) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
    }
    const text = search.toString();
    return text ? `?${text}` : '';
}

/** "2026-10-27 14:03 UTC" or "—". */
export function formatDate(value) {
    if (!value) return '—';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** "3 d", "5 h", "12 min" since `value`. */
export function formatAge(value, now = Date.now()) {
    const ms = Math.max(0, now - new Date(value).getTime());
    const minutes = Math.floor(ms / 60000);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours} h`;
    return `${Math.floor(hours / 24)} d`;
}

const CSS = `
:root{color-scheme:light dark;--bg:#f6f7f9;--fg:#1d1f23;--muted:#5c6370;--card:#fff;--line:#d9dde3;--accent:#5865f2;--warn:#b45309;--bad:#c0392b;--ok:#15803d}
@media (prefers-color-scheme:dark){:root{--bg:#1e1f22;--fg:#f2f3f5;--muted:#a5abb5;--card:#2b2d31;--line:#3f4147;--accent:#8891f2;--warn:#f0b232;--bad:#f23f43;--ok:#3ba55c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line);background:var(--card)}
header nav{display:flex;flex-wrap:wrap;gap:12px;flex:1}header a{color:var(--fg);text-decoration:none;font-weight:500}header a.on{color:var(--accent)}
main{max-width:1100px;margin:0 auto;padding:16px}h1{font-size:20px;margin:8px 0 16px}h2{font-size:16px;margin:24px 0 8px}
a{color:var(--accent)}.muted{color:var(--muted)}.warn{color:var(--warn)}.bad{color:var(--bad)}.ok{color:var(--ok)}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:6px;overflow:hidden}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:13px;color:var(--muted);font-weight:600}
tr:last-child td{border-bottom:0}.scroll{overflow-x:auto}
form.filters{display:flex;flex-wrap:wrap;gap:8px;align-items:end;margin-bottom:12px}
label{display:flex;flex-direction:column;font-size:12px;color:var(--muted);gap:2px}
input,select,button{font:inherit;padding:5px 8px;border:1px solid var(--line);border-radius:4px;background:var(--card);color:var(--fg)}
button{cursor:pointer}button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:12px}
dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}.pager{display:flex;gap:12px;margin:12px 0;align-items:center}
.evidence img{max-width:100%;max-height:360px;border-radius:4px;border:1px solid var(--line);display:block;margin:6px 0}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}.inline{display:inline}
`;

const NAV = [
    ['cases', '/staff/cases', 'Cases'],
    ['appeals', '/staff/appeals', 'Appeals'],
    ['automod', '/staff/automod', 'Automod'],
    ['stats', '/staff/stats', 'Staff stats'],
];

/** The page shell. `session` adds the navigation and logout form; `body` must be SafeHtml. */
export function layout({ title, active = null, session = null, body }) {
    const nav = session ? html`<nav>${NAV.map(([key, href, label]) => html`<a href="${href}"${key === active ? raw(' class="on"') : ''}>${label}</a>`)}</nav>
<span class="muted">${session.username}</span>
<form method="post" action="/staff/logout" class="inline"><input type="hidden" name="csrf" value="${session.csrf}"><button type="submit">Log out</button></form>` : html`<nav></nav>`;
    return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${title} · Meowist staff</title><style>${raw(CSS)}</style></head>
<body><header><strong>Meowist staff</strong>${nav}</header><main>${body}</main></body></html>`.text;
}

/** A plain message page (errors, 403, …). */
export function messagePage(title, message, session = null) {
    return layout({ title, session, body: html`<h1>${title}</h1><p>${message}</p>` });
}
