// rules.js — /rules: the main server's rules as staff set them on the dashboard Rules page
// (services/rules/serverRules.js), numbered, each with an anchor (#rule-3) that punishment
// DMs link to. `data` is the reader's result, or null when it could not be read (503 page,
// never an empty list that would look like "no rules").

import { html } from '../../dashboard/html.js';
import { layout } from '../shell.js';

const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** "29 October 2026" + the ISO date for <time>, or null for a missing/invalid date. */
function updatedOn(value) {
    const at = value ? new Date(value) : null;
    if (!at || !Number.isFinite(at.getTime())) return null;
    return { iso: at.toISOString().slice(0, 10), text: DATE.format(at) };
}

export function rulesPage(ctx, data) {
    const head = html`<header class="page-head page-head-split"><div><p class="section-num">Community</p><h1>Server rules</h1></div>
<p class="lead">The rules of the Mewvo server. When staff warn, mute, kick or ban for one of them, the DM names the rule and links here.</p></header>`;
    let content;
    if (!data) {
        content = html`<p class="notice notice-bad" role="alert">The rules could not be loaded right now. Please try again in a minute.</p>`;
    } else if (!data.rules.length) {
        content = html`<p class="notice">This server has not published its rules yet.</p>`;
    } else {
        const updated = updatedOn(data.updatedAt);
        content = html`${updated ? html`<p class="note">Last updated <time datetime="${updated.iso}">${updated.text}</time>.</p>` : ''}
<ol class="rules-list">${data.rules.map((rule) => html`<li class="rule" id="rule-${rule.number}"><a class="rule-num" href="#rule-${rule.number}" aria-label="Link to rule ${rule.number}">${String(rule.number).padStart(2, '0')}</a><div class="rule-body"><h2 class="rule-title">${rule.title}</h2>${rule.text ? html`<p class="rule-text">${rule.text}</p>` : ''}</div></li>`)}</ol>`;
    }
    return layout(ctx, {
        title: 'Rules', active: 'rules', path: '/rules',
        description: 'The rules of the Mewvo Discord server.',
        body: html`<div class="wrap page">${head}<div class="rules">${content}
<p class="note rules-appeal">Punished for a rule you think you did not break? Every DM says whether and how it can be appealed. <a href="/docs/appeals">How appeals work</a>.</p></div></div>`,
    });
}
