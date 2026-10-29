// transparency.js — /transparency: the monthly transparency report of the main server
// (numbers from services/enforcement/transparencyService.js). Only when an administrator
// turned it on in the dashboard (Enforcement & appeals); otherwise the route is a 404.
//
// Numbers only: no names, IDs, case codes, reasons or moderators ever reach this page.
// Counts of 1–2 show as "fewer than 3"; a total over a masked month as "at least N";
// a median needs 3 decided appeals.

import { html } from '../../dashboard/html.js';
import { layout } from '../shell.js';
import { maskCount, maskTotal, medianText } from '../../enforcement/transparencyService.js';

const MONTH_NAME = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const DAY_NAME = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

const cell = ({ text, masked }, sub = false) => html`<td class="${['num', sub ? 'sub' : '', masked ? 'masked' : ''].filter(Boolean).join(' ')}">${text}</td>`;

function monthLabel(month) {
    return html`${MONTH_NAME.format(month.start)}${month.current ? html` <span class="tag">so far</span>` : ''}`;
}

const CASE_HEADS = [
    ['warns', 'Warnings'], ['mutes', 'Mutes'], ['kicks', 'Kicks'], ['bans', 'Bans'],
    ['ladderBans', 'Of the bans: automatic (warning ladder)', true], ['automod', 'Given by automod', true], ['voided', 'Voided as mistakes', true],
];

function casesTable(report) {
    const total = (key) => maskTotal(report.months.map((m) => m.cases[key]));
    return html`<div class="table-wrap" role="region" aria-labelledby="tr-actions" tabindex="0"><table class="report">
<caption class="visually-hidden">Moderation actions per month, oldest first. The last row is the total.</caption>
<thead><tr><th scope="col">Month</th>${CASE_HEADS.map(([, label]) => html`<th scope="col">${label}</th>`)}</tr></thead>
<tbody>${report.months.map((m) => html`<tr><th scope="row">${monthLabel(m)}</th>${CASE_HEADS.map(([key, , sub]) => cell(maskCount(m.cases[key]), sub))}</tr>`)}</tbody>
<tfoot><tr><th scope="row">Total</th>${CASE_HEADS.map(([key, , sub]) => cell(total(key), sub))}</tr></tfoot></table></div>`;
}

const APPEAL_HEADS = [['received', 'Received'], ['accepted', 'Accepted'], ['denied', 'Denied'], ['open', 'Still open']];

function median(appeals) {
    const text = medianText(appeals.medianHours, appeals.decided);
    return text ? { text, masked: false } : { text: 'not enough decisions', masked: true };
}

function appealsTable(report) {
    const total = (key) => maskTotal(report.months.map((m) => m.appeals[key]));
    return html`<div class="table-wrap" role="region" aria-labelledby="tr-appeals" tabindex="0"><table class="report">
<caption class="visually-hidden">Appeals per month by the month they were sent, oldest first. The last row is the total.</caption>
<thead><tr><th scope="col">Month</th>${APPEAL_HEADS.map(([, label]) => html`<th scope="col">${label}</th>`)}<th scope="col">Median time to a decision</th></tr></thead>
<tbody>${report.months.map((m) => html`<tr><th scope="row">${monthLabel(m)}</th>${APPEAL_HEADS.map(([key]) => cell(maskCount(m.appeals[key])))}${cell(median(m.appeals), true)}</tr>`)}</tbody>
<tfoot><tr><th scope="row">Total</th>${APPEAL_HEADS.map(([key]) => cell(total(key)))}${cell(median(report.totals.appeals), true)}</tr></tfoot></table></div>`;
}

function summary(report) {
    const total = (pick) => maskTotal(report.months.map(pick));
    const tile = (label, { text, masked }) => html`<div><dt>${label}</dt><dd${masked ? html` class="tr-small"` : ''}>${text}</dd></div>`;
    const med = median(report.totals.appeals);
    return html`<dl class="tr-stats">
${tile('Warnings', total((m) => m.cases.warns))}${tile('Mutes', total((m) => m.cases.mutes))}${tile('Kicks', total((m) => m.cases.kicks))}
${tile('Bans', total((m) => m.cases.bans))}${tile('Appeals received', total((m) => m.appeals.received))}${tile('Median time to an appeal decision', med)}</dl>`;
}

function explanation() {
    return html`<dl class="qa">
<div><dt>What is counted</dt><dd>Every warning, mute, kick and ban given on the Meowist server, in the month it was given (UTC), whether by a moderator, by the warning ladder or by automod. Automatic ladder bans and automod actions are already part of the four main columns; their own columns only show how many of them there were.</dd></div>
<div><dt>What is not counted</dt><dd>Test simulations (staff previewing a message; nothing happens to anyone), warnings imported from the old bot as history, and staff reports. Cases voided as mistakes are left out of the main columns and shown on their own in the “Voided as mistakes” column, by the month they were first given.</dd></div>
<div><dt>Appeals</dt><dd>Appeals are counted in the month they were sent, with their result today. An appeal on a case that was later voided still counts: the appeal happened. Appeals that were closed without a decision are counted as received only. The median time runs from sending the appeal to the staff decision, over the accepted and denied appeals of that month.</dd></div>
<div><dt>Small numbers</dt><dd>To keep single cases from being recognised, a count of 1 or 2 is shown as “fewer than 3”, and a median is only shown when at least 3 appeals were decided. When a month in a column is hidden that way, the total says “at least” instead of the exact number.</dd></div>
<div><dt>What this page never shows</dt><dd>Names, Discord IDs, case codes, reasons or which moderator acted. Only numbers.</dd></div>
</dl>`;
}

/** The report page; `report` is transparencyService's aggregateReport() result. */
export function transparencyPage(ctx, report) {
    const first = report.months[0];
    const generated = report.generatedAt instanceof Date ? report.generatedAt : new Date(report.generatedAt);
    return layout(ctx, {
        title: 'Transparency report', active: 'transparency', path: '/transparency',
        description: 'How many warnings, mutes, kicks and bans the Meowist server gave each month, and how appeals were decided. Numbers only.',
        body: html`<div class="wrap page">
<header class="page-head page-head-split"><div><p class="section-num">Moderation</p><h1>Transparency report</h1></div>
<p class="lead">How often staff on the Meowist server warned, muted, kicked and banned, and how appeals went, month by month. Numbers only: no names, no reasons, no moderators.</p></header>
<p class="note">From <time datetime="${first.start.toISOString().slice(0, 10)}">${DAY_NAME.format(first.start)}</time> to <time datetime="${generated.toISOString().slice(0, 10)}">${DAY_NAME.format(generated)}</time>, in UTC. Updated at most every 10 minutes.</p>
${summary(report)}
<section class="tr-section" aria-labelledby="tr-actions"><h2 id="tr-actions">Moderation actions</h2>
<p>Per month, the current month so far.</p>${casesTable(report)}</section>
<section class="tr-section" aria-labelledby="tr-appeals"><h2 id="tr-appeals">Appeals</h2>
<p>By the month the appeal was sent, with its result today.</p>${appealsTable(report)}</section>
<section class="block-tight split split-narrow" aria-labelledby="tr-how"><div class="split-copy"><h2 id="tr-how">How these numbers are made</h2><p>How appeals work is explained in the <a href="/docs/appeals">appeals guide</a>.</p></div>
${explanation()}</section></div>`,
    });
}

/** The page when the numbers could not be read (503): never zeros instead. */
export function transparencyErrorPage(ctx) {
    return layout(ctx, {
        title: 'Transparency report', active: 'transparency', path: '/transparency',
        body: html`<div class="wrap page prose"><p class="section-num">Moderation</p><h1>Transparency report</h1>
<p class="notice notice-bad" role="alert">The report could not be loaded right now because the database is not responding. No numbers are shown rather than wrong ones; please try again in a few minutes.</p></div>`,
    });
}
