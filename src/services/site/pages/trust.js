// trust.js — /trust: the main server's trust card, a short public summary of how fairly it is
// moderated over the last 90 days (numbers from services/enforcement/trustCardService.js).
// Only when an administrator turned it on in the dashboard (Enforcement & appeals); otherwise
// the route is a 404. Page text: content/site/<lang>/trust.json.
//
// Numbers only: no names, IDs, case codes, reasons or moderators. Counts of 1–2 show as
// "fewer than 3"; rates and medians based on fewer than 3 say "Not enough data yet".
// The cat and the rules are extras: when they cannot be read, only their block is left out.

import { html } from '../../dashboard/html.js';
import { layout } from '../shell.js';
import { textOf } from '../i18n.js';
import { enforcementConfig } from '../../../config/enforcement.js';
import { trustCardView } from '../../enforcement/trustCardService.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ORDINAL = 10;

/** "a 7-day ban" / "a permanent ban" for a ladder level's ban length. */
function banWords(ms, t) {
    if (!ms) return t('trust.ladder.banPermanent');
    return t('trust.ladder.banDays', { days: Math.round(ms / DAY_MS) });
}

/** The warning ladder in one sentence, from config/enforcement.js. */
export function ladderSentence(config = enforcementConfig, ctx) {
    const { t } = textOf(ctx);
    const levels = Object.keys(config.ladderBans).map(Number).sort((a, b) => a - b);
    const [first, ...rest] = levels.map((level) => banWords(config.ladderBans[level], t));
    const n = config.warnsPerLevel;
    const nth = Number.isInteger(n) && n >= 0 && n <= MAX_ORDINAL ? t(`trust.ladder.ordinals.${n}`) : t('trust.ladder.ordinalOther', { n });
    if (!rest.length) return t('trust.ladder.single', { nth, first });
    const later = rest.reduce((earlier, next) => t('trust.ladder.then', { earlier, next }));
    return t('trust.ladder.escalating', { nth, first, later });
}

function tile(t, label, value, note) {
    return html`<div class="trust-tile"><dt>${label}</dt><dd class="trust-value${value ? '' : ' trust-none'}">${value || t('trust.noData')}</dd><dd class="trust-note">${note}</dd></div>`;
}

function stats(view, t) {
    return html`<dl class="trust-tiles">
${tile(t, t('trust.tiles.firstAnswer.label'), view.firstAnswer, t('trust.tiles.firstAnswer.note'))}
${tile(t, t('trust.tiles.accepted.label'), view.successRate, t('trust.tiles.accepted.note', { decided: view.decided.text }))}
${tile(t, t('trust.tiles.goodStanding.label'), view.goodStanding, t('trust.tiles.goodStanding.note'))}
${tile(t, t('trust.tiles.headsUp.label'), view.headsUpRate, view.headsUpRate ? t('trust.tiles.headsUp.noteWithRate', { rate: view.headsUpRate }) : t('trust.tiles.headsUp.noteNoRate'))}
</dl>`;
}

function details(view, t) {
    const row = (key, value) => html`<div><dt>${t(`trust.facts.${key}`)}</dt><dd>${value || t('trust.noData')}</dd></div>`;
    return html`<dl class="trust-facts">
${row('received', view.received.text)}${row('decided', view.decided.text)}
${row('decisionTime', view.decisionTime)}${row('casesPerThousand', view.casesPerThousand)}</dl>`;
}

function catBlock(cat, t) {
    if (!cat?.stage || !cat.image) return '';
    return html`<figure class="trust-cat"><img src="/img/cat/${cat.image}" width="128" height="128" alt="${t('trust.cat.alt', { name: cat.name, stage: cat.stage.name.toLowerCase(), mood: cat.mood })}">
<figcaption><strong>${cat.name}</strong><span>${cat.stage.name}</span><span>${t('trust.cat.caption')}</span></figcaption></figure>`;
}

function rulesBlock(rules, t, href) {
    if (!rules) return '';
    const list = rules.rules?.length
        ? html`<ol class="trust-rules">${rules.rules.map((r) => html`<li><a href="${href(`/rules#rule-${r.number}`)}">${r.title}</a></li>`)}</ol>`
        : html`<p>${t('trust.rules.empty')}</p>`;
    return html`<section class="card trust-panel" aria-labelledby="trust-rules"><h2 id="trust-rules">${t('trust.rules.heading')}</h2>${list}
<p class="note"><a href="${href('/rules')}">${t('trust.rules.readAll')}</a></p></section>`;
}

/**
 * The page. `card` is readTrustCard's result; `cat` the server cat or null; `rules` the
 * public rules ({ rules: [{ number, title }] }) or null when they could not be read.
 */
export function trustPage(ctx, card, { cat = null, rules = null } = {}) {
    const { t, ti, href, fmtDate } = textOf(ctx);
    const view = trustCardView(card);
    const generated = view.generatedAt instanceof Date ? view.generatedAt : new Date(view.generatedAt);
    const since = view.since instanceof Date ? view.since : new Date(view.since);
    const image = cat?.image
        ? { path: `/img/cat/${cat.image}`, width: 256, height: 256, alt: t('trust.cat.shareAlt', { name: cat.name }), large: false }
        : null;
    const from = html`<time datetime="${since.toISOString().slice(0, 10)}">${fmtDate(since)}</time>`;
    const to = html`<time datetime="${generated.toISOString().slice(0, 10)}">${fmtDate(generated)}</time>`;
    return layout(ctx, {
        title: t('trust.title', { server: view.serverName }), active: 'trust', path: '/trust', image,
        description: t('trust.description', { server: view.serverName, days: view.days }),
        body: html`<div class="wrap page">
<header class="trust-head"><div><h1>${t('trust.head.heading', { server: view.serverName })}</h1>
<p class="lead">${t('trust.head.lead', { days: view.days })}</p></div>${catBlock(cat, t)}</header>
${stats(view, t)}
<div class="trust-grid">
<section class="card trust-panel" aria-labelledby="trust-how"><h2 id="trust-how">${t('trust.how.heading')}</h2>
<ul class="trust-list"><li>${ladderSentence(enforcementConfig, ctx)}</li>
<li>${t('trust.how.byPerson')}</li>
<li>${t('trust.how.cases')}</li></ul>
${details(view, t)}</section>
${rulesBlock(rules, t, href)}
</div>
<p class="note trust-foot">${ti(ctx.transparency ? 'trust.foot.periodWithReport' : 'trust.foot.period', { days: view.days, from, to })}</p>
</div>`,
    });
}

/** The page when the numbers could not be read (503): never zeros instead. */
export function trustErrorPage(ctx) {
    const { t } = textOf(ctx);
    return layout(ctx, {
        title: t('trust.error.title'), active: 'trust', path: '/trust',
        body: html`<div class="wrap page prose"><h1>${t('trust.error.heading')}</h1>
<p class="notice notice-bad" role="alert">${t('trust.error.text')}</p></div>`,
    });
}
