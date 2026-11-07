// safeHtml.js — the escaping core of the `html` template (re-exported by html.js).
//
// Kept apart from html.js so the text catalog (site/i18n.js) can use it while html.js uses the
// catalog for the page shell, without an import cycle.
//
// `html` is a tagged template: every interpolated value is HTML-escaped unless it is the result
// of another `html` call (or `raw`, for the few trusted constants). Arrays are joined.
// null / undefined / false render as nothing.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

export function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"'`]/g, (c) => ESCAPES[c]);
}

export class SafeHtml {
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
