// transparency.js — /transparency: the monthly transparency report of the main server
// (numbers from services/enforcement/transparencyService.js). Only when an administrator
// turned it on in the dashboard (Enforcement & appeals); otherwise the route is a 404.
// Page text: content/site/<lang>/transparency.json.
//
// Numbers only: no names, IDs, case codes, reasons or moderators ever reach this page.
// Counts of 1–2 show as "fewer than 3"; a total over a masked month as "at least N";
// a median needs 3 decided appeals.

import { html } from '../../dashboard/html.js';
import { layout } from '../shell.js';
import { textOf } from '../i18n.js';
import { maskCount, maskTotal, medianParts } from '../../enforcement/transparencyService.js';

const MONTH_FORMAT = Object.freeze({ month: 'long', year: 'numeric', timeZone: 'UTC' });

/**
 * A masked count (maskCount / maskTotal) in the page's language: the number, "fewer than 3" or
 * "at least N" (transparency.mask.*). Without a kind (older callers): its English text.
 */
export function maskedText(mask, { t, fmtNumber }) {
    if (!mask) return '';
    if (mask.kind === 'fewer') return t('transparency.mask.fewer', { n: fmtNumber(mask.value) });
    if (mask.kind === 'atLeast') return t('transparency.mask.atLeast', { n: fmtNumber(mask.value) });
    if (mask.kind === 'number') return fmtNumber(mask.value);
    return mask.text;
}

/** A median (medianParts) in the page's language: "under an hour", "5 hours", "3.5 days"; null when hidden. */
export function medianWords(parts, { t, tp }) {
    if (!parts) return null;
    if (parts.unit === 'underHour') return t('transparency.median.underHour');
    return tp(parts.unit === 'hours' ? 'transparency.median.hours' : 'transparency.median.days', parts.value);
}

const cell = ({ text, masked }, sub = false) => html`<td class="${['num', sub ? 'sub' : '', masked ? 'masked' : ''].filter(Boolean).join(' ')}">${text}</td>`;
/** A cell for a masked count, in the page's language. */
const countCell = (mask, text, sub = false) => cell({ text: maskedText(mask, text), masked: mask.masked }, sub);

function monthLabel(month, t, fmtDate) {
    return html`${fmtDate(month.start, MONTH_FORMAT)}${month.current ? html` <span class="tag">${t('transparency.table.soFar')}</span>` : ''}`;
}

// [report key, label key under transparency.actions.columns, shown as a sub-column]
const CASE_HEADS = [
    ['warns'], ['mutes'], ['kicks'], ['bans'], ['ladderBans', true], ['automod', true], ['voided', true],
];

function casesTable(report, text) {
    const { t, fmtDate } = text;
    const total = (key) => maskTotal(report.months.map((m) => m.cases[key]));
    return html`<div class="table-wrap" role="region" aria-labelledby="tr-actions" tabindex="0"><table class="report">
<caption class="visually-hidden">${t('transparency.actions.caption')}</caption>
<thead><tr><th scope="col">${t('transparency.table.month')}</th>${CASE_HEADS.map(([key]) => html`<th scope="col">${t(`transparency.actions.columns.${key}`)}</th>`)}</tr></thead>
<tbody>${report.months.map((m) => html`<tr><th scope="row">${monthLabel(m, t, fmtDate)}</th>${CASE_HEADS.map(([key, sub]) => countCell(maskCount(m.cases[key]), text, sub))}</tr>`)}</tbody>
<tfoot><tr><th scope="row">${t('transparency.table.total')}</th>${CASE_HEADS.map(([key, sub]) => countCell(total(key), text, sub))}</tr></tfoot></table></div>`;
}

const APPEAL_HEADS = ['received', 'accepted', 'denied', 'open'];

function median(appeals, text) {
    const words = medianWords(medianParts(appeals.medianHours, appeals.decided), text);
    return words ? { text: words, masked: false } : { text: text.t('transparency.table.notEnoughDecisions'), masked: true };
}

function appealsTable(report, text) {
    const { t, fmtDate } = text;
    const total = (key) => maskTotal(report.months.map((m) => m.appeals[key]));
    return html`<div class="table-wrap" role="region" aria-labelledby="tr-appeals" tabindex="0"><table class="report">
<caption class="visually-hidden">${t('transparency.appeals.caption')}</caption>
<thead><tr><th scope="col">${t('transparency.table.month')}</th>${APPEAL_HEADS.map((key) => html`<th scope="col">${t(`transparency.appeals.columns.${key}`)}</th>`)}<th scope="col">${t('transparency.appeals.columns.median')}</th></tr></thead>
<tbody>${report.months.map((m) => html`<tr><th scope="row">${monthLabel(m, t, fmtDate)}</th>${APPEAL_HEADS.map((key) => countCell(maskCount(m.appeals[key]), text))}${cell(median(m.appeals, text), true)}</tr>`)}</tbody>
<tfoot><tr><th scope="row">${t('transparency.table.total')}</th>${APPEAL_HEADS.map((key) => countCell(total(key), text))}${cell(median(report.totals.appeals, text), true)}</tr></tfoot></table></div>`;
}

function summary(report, words) {
    const { t } = words;
    const total = (pick) => {
        const mask = maskTotal(report.months.map(pick));
        return { text: maskedText(mask, words), masked: mask.masked };
    };
    const tile = (key, { text, masked }) => html`<div><dt>${t(`transparency.summary.${key}`)}</dt><dd${masked ? html` class="tr-small"` : ''}>${text}</dd></div>`;
    const med = median(report.totals.appeals, words);
    return html`<dl class="tr-stats">
${tile('warns', total((m) => m.cases.warns))}${tile('mutes', total((m) => m.cases.mutes))}${tile('kicks', total((m) => m.cases.kicks))}
${tile('bans', total((m) => m.cases.bans))}${tile('appealsReceived', total((m) => m.appeals.received))}${tile('medianDecision', med)}</dl>`;
}

const EXPLANATION = ['counted', 'notCounted', 'appeals', 'smallNumbers', 'neverShown'];

function explanation(t) {
    return html`<dl class="qa">
${EXPLANATION.map((key) => html`<div><dt>${t(`transparency.how.${key}.question`)}</dt><dd>${t(`transparency.how.${key}.answer`)}</dd></div>
`)}</dl>`;
}

/** The report page; `report` is transparencyService's aggregateReport() result. */
export function transparencyPage(ctx, report) {
    const text = textOf(ctx);
    const { t, ti, fmtDate } = text;
    const first = report.months[0];
    const generated = report.generatedAt instanceof Date ? report.generatedAt : new Date(report.generatedAt);
    const from = html`<time datetime="${first.start.toISOString().slice(0, 10)}">${fmtDate(first.start)}</time>`;
    const to = html`<time datetime="${generated.toISOString().slice(0, 10)}">${fmtDate(generated)}</time>`;
    return layout(ctx, {
        title: t('transparency.title'), active: 'transparency', path: '/transparency',
        description: t('transparency.description'),
        body: html`<div class="wrap page">
<header class="page-head page-head-split"><div><h1>${t('transparency.head.heading')}</h1></div>
<p class="lead">${t('transparency.head.lead')}</p></header>
<p class="note">${ti('transparency.head.period', { from, to })}</p>
${summary(report, text)}
<section class="tr-section" aria-labelledby="tr-actions"><h2 id="tr-actions">${t('transparency.actions.heading')}</h2>
<p>${t('transparency.actions.intro')}</p>${casesTable(report, text)}</section>
<section class="tr-section" aria-labelledby="tr-appeals"><h2 id="tr-appeals">${t('transparency.appeals.heading')}</h2>
<p>${t('transparency.appeals.intro')}</p>${appealsTable(report, text)}</section>
<section class="block-tight split split-narrow" aria-labelledby="tr-how"><div class="split-copy"><h2 id="tr-how">${t('transparency.how.heading')}</h2><p>${ti('transparency.how.intro')}</p></div>
${explanation(t)}</section></div>`,
    });
}

/** The page when the numbers could not be read (503): never zeros instead. */
export function transparencyErrorPage(ctx) {
    const { t } = textOf(ctx);
    return layout(ctx, {
        title: t('transparency.title'), active: 'transparency', path: '/transparency',
        body: html`<div class="wrap page prose"><h1>${t('transparency.head.heading')}</h1>
<p class="notice notice-bad" role="alert">${t('transparency.error.text')}</p></div>`,
    });
}
