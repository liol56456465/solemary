// trust.js — /trust: the main server's trust card, a short public summary of how fairly it is
// moderated over the last 90 days (numbers from services/enforcement/trustCardService.js).
// Only when an administrator turned it on in the dashboard (Enforcement & appeals); otherwise
// the route is a 404.
//
// Numbers only: no names, IDs, case codes, reasons or moderators. Counts of 1–2 show as
// "fewer than 3"; rates and medians based on fewer than 3 say "Not enough data yet".
// The cat and the rules are extras: when they cannot be read, only their block is left out.

import { html } from '../../dashboard/html.js';
import { layout } from '../shell.js';
import { enforcementConfig } from '../../../config/enforcement.js';
import { trustCardView } from '../../enforcement/trustCardService.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_NAME = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const ORDINAL = ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
const NO_DATA = 'Not enough data yet';

/** "a 7-day ban" / "a permanent ban" for a ladder level's ban length. */
function banWords(ms) {
    if (!ms) return 'a permanent ban';
    return `a ${Math.round(ms / DAY_MS)}-day ban`;
}

/** The warning ladder in one sentence, from config/enforcement.js. */
export function ladderSentence(config = enforcementConfig) {
    const levels = Object.keys(config.ladderBans).map(Number).sort((a, b) => a - b);
    const [first, ...rest] = levels.map((level) => banWords(config.ladderBans[level]));
    const nth = ORDINAL[config.warnsPerLevel] || `${config.warnsPerLevel}th`;
    const later = rest.length ? `, and each warning after that ban brings a longer one (${rest.join(', then ')})` : '';
    return `Warnings add up: the ${nth} warning brings ${first}${later}.`;
}

function tile(label, value, note) {
    return html`<div class="trust-tile"><dt>${label}</dt><dd class="trust-value${value ? '' : ' trust-none'}">${value || NO_DATA}</dd><dd class="trust-note">${note}</dd></div>`;
}

function stats(view) {
    return html`<dl class="trust-tiles">
${tile('First answer on an appeal', view.firstAnswer, 'Median time from sending an appeal until a staff member picks it up or decides it.')}
${tile('Appeals accepted', view.successRate, html`Of ${view.decided.text} appeals decided.`)}
${tile('Members in good standing', view.goodStanding, 'No counted warning, not muted.')}
${tile('Fixed after a heads-up', view.headsUpRate, view.headsUpRate ? `Members fixed ${view.headsUpRate} of flagged messages themselves after a heads-up.` : 'How often members fix a flagged message themselves after a heads-up.')}
</dl>`;
}

function details(view) {
    const row = (label, value) => html`<div><dt>${label}</dt><dd>${value || NO_DATA}</dd></div>`;
    return html`<dl class="trust-facts">
${row('Appeals received', view.received.text)}${row('Appeals decided', view.decided.text)}
${row('Median time to a decision', view.decisionTime)}${row('Cases per 1,000 members', view.casesPerThousand)}</dl>`;
}

function catBlock(cat) {
    if (!cat?.stage || !cat.image) return '';
    return html`<figure class="trust-cat"><img src="/img/cat/${cat.image}" width="128" height="128" alt="${cat.name}, the server cat, a ${cat.stage.name.toLowerCase()}, looking ${cat.mood}">
<figcaption><strong>${cat.name}</strong><span>${cat.stage.name}</span><span>The server cat</span></figcaption></figure>`;
}

function rulesBlock(rules) {
    if (!rules) return '';
    const list = rules.rules?.length
        ? html`<ol class="trust-rules">${rules.rules.map((r) => html`<li><a href="/rules#rule-${r.number}">${r.title}</a></li>`)}</ol>`
        : html`<p>This server has not published its rules yet.</p>`;
    return html`<section class="card trust-panel" aria-labelledby="trust-rules"><h2 id="trust-rules">Rules</h2>${list}
<p class="note"><a href="/rules">Read the full rules</a></p></section>`;
}

/**
 * The page. `card` is readTrustCard's result; `cat` the server cat or null; `rules` the
 * public rules ({ rules: [{ number, title }] }) or null when they could not be read.
 */
export function trustPage(ctx, card, { cat = null, rules = null } = {}) {
    const view = trustCardView(card);
    const generated = view.generatedAt instanceof Date ? view.generatedAt : new Date(view.generatedAt);
    const since = view.since instanceof Date ? view.since : new Date(view.since);
    const image = cat?.image
        ? { path: `/img/cat/${cat.image}`, width: 256, height: 256, alt: `${cat.name}, the server cat`, large: false }
        : null;
    return layout(ctx, {
        title: `${view.serverName} trust card`, active: 'trust', path: '/trust', image,
        description: `How ${view.serverName} is moderated: appeal times, appeal results and members in good standing over the last ${view.days} days. Numbers only.`,
        body: html`<div class="wrap page">
<header class="trust-head"><div><h1>${view.serverName}: trust card</h1>
<p class="lead">How this server was moderated over the last ${view.days} days. Numbers only: no names, no reasons, no moderators.</p></div>${catBlock(cat)}</header>
${stats(view)}
<div class="trust-grid">
<section class="card trust-panel" aria-labelledby="trust-how"><h2 id="trust-how">How this server moderates</h2>
<ul class="trust-list"><li>${ladderSentence()}</li>
<li>Every appeal is read and decided by a person on the staff, never by the bot alone.</li>
<li>Every warning, mute, kick and ban is recorded as a case with its own code, and the member gets that code in a DM.</li></ul>
${details(view)}</section>
${rulesBlock(rules)}
</div>
<p class="note trust-foot">Last ${view.days} days, from <time datetime="${since.toISOString().slice(0, 10)}">${DAY_NAME.format(since)}</time> to <time datetime="${generated.toISOString().slice(0, 10)}">${DAY_NAME.format(generated)}</time>. Small numbers are hidden.${ctx.transparency ? html` Full monthly numbers: <a href="/transparency">Transparency report</a>.` : ''}</p>
</div>`,
    });
}

/** The page when the numbers could not be read (503): never zeros instead. */
export function trustErrorPage(ctx) {
    return layout(ctx, {
        title: 'Trust card', active: 'trust', path: '/trust',
        body: html`<div class="wrap page prose"><h1>Trust card</h1>
<p class="notice notice-bad" role="alert">The trust card could not be loaded right now. No numbers are shown rather than wrong ones; please try again in a few minutes.</p></div>`,
    });
}
