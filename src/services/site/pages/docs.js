// docs.js — /docs (the guide hub) and /docs/<slug> (short guides), written from the
// real behaviour: enforcement/flowBuilder.js, handlers/enforcementPanel.js, config/enforcement.js,
// enforcement/appealService.js, handlers/appealsHandler.js, dashboard/html.js NAV and CLAUDE.md.
// Text: content/site/<lang>/docs.json (docs.guides.<key>.title / .summary / sections). The page
// structure (headings with ids, lists, mockups) stays here; each paragraph or item is one key.

import { html } from '../../dashboard/html.js';
import { DASHBOARD_PATH, layout } from '../shell.js';
import { textOf } from '../i18n.js';
import { appealFormMock, banDmMock, dashboardShot, ladderMock } from './mockups.js';

const support = (ctx) => {
    const { t, ti } = textOf(ctx);
    return ctx.supportInvite ? ti('docs.support.link', { url: ctx.supportInvite }) : t('docs.support.text');
};

export const GUIDES = [
    {
        slug: 'setup', key: 'setup', minutes: 10,
        body: (ctx) => {
            const { t, ti } = textOf(ctx);
            const k = (key) => `docs.guides.setup.${key}`;
            return html`<p>${ti(k('intro'))}</p>
<h2 id="open">${t(k('open.title'))}</h2>
<p>${ti(k('open.text'), { dashboard: DASHBOARD_PATH })}</p>
<h2 id="steps">${t(k('steps.title'))}</h2>
<p>${ti(k('steps.text'))}</p>
<ol class="steps-list"><li>${ti(k('steps.modLog'))}</li>
<li>${ti(k('steps.mutedRole'))}</li>
<li>${ti(k('steps.appealsCategory'))}</li></ol>
<h2 id="rules">${t(k('rules.title'))}</h2>
<p>${ti(k('rules.text'))}</p>
<h2 id="automod">${t(k('automod.title'))}</h2>
<p>${ti(k('automod.text'))}</p>
<h2 id="try">${t(k('try.title'))}</h2>
<p>${ti(k('try.text'))}</p>
<h2 id="next">${t(k('next.title'))}</h2>
<p>${ti(k('next.text'), { support: support(ctx) })}</p>`;
        },
    },
    {
        slug: 'getting-started', key: 'gettingStarted', minutes: 4,
        body: (ctx) => {
            const { t, ti } = textOf(ctx);
            const k = (key) => `docs.guides.gettingStarted.${key}`;
            return html`<h2 id="access">${t(k('access.title'))}</h2>
<p>${ti(k('access.text'))}</p>
<p>${ti(k('access.denied'))}</p>
<h2 id="first-action">${t(k('firstAction.title'))}</h2>
<ol class="steps-list"><li>${ti(k('firstAction.run'))}</li>
<li>${ti(k('firstAction.action'))}</li>
<li>${ti(k('firstAction.reason'))}</li>
<li>${ti(k('firstAction.duration'))}</li>
<li>${ti(k('firstAction.confirm'))}</li></ol>
<p>${ti(k('firstAction.after'))}</p>
<h2 id="every-week">${t(k('everyWeek.title'))}</h2>
<dl class="ref-list"><div><dt><code>/background</code></dt><dd>${ti(k('everyWeek.background'))}</dd></div>
<div><dt><code>/case</code></dt><dd>${ti(k('everyWeek.case'))}</dd></div>
<div><dt><code>/appeals</code></dt><dd>${ti(k('everyWeek.appeals'))}</dd></div>
<div><dt><code>/test</code></dt><dd>${ti(k('everyWeek.test'))}</dd></div>
<div><dt><code>/staff</code></dt><dd>${ti(k('everyWeek.staff'))}</dd></div>
<div><dt>${t(k('everyWeek.warnMessage'))}</dt><dd>${ti(k('everyWeek.warnMessageText'))}</dd></div></dl>
<h2 id="limits">${t(k('limits.title'))}</h2>
<p>${ti(k('limits.text'))}</p>`;
        },
    },
    {
        slug: 'warnings', key: 'warnings', minutes: 3,
        body: (ctx) => {
            const { t, ti } = textOf(ctx);
            const k = (key) => `docs.guides.warnings.${key}`;
            const ref = (term) => html`<div><dt>${t(k(`changes.${term}`))}</dt><dd>${ti(k(`changes.${term}Text`))}</dd></div>`;
            return html`<p>${ti(k('intro'))}</p>
${ladderMock()}
<h2 id="steps">${t(k('steps.title'))}</h2>
<ol class="steps-list"><li>${ti(k('steps.first'))}</li>
<li>${ti(k('steps.third'))}</li>
<li>${ti(k('steps.next'))}</li>
<li>${ti(k('steps.last'))}</li></ol>
${banDmMock(ctx, { caption: t(k('dmCaption')) })}
<h2 id="what-changes">${t(k('changes.title'))}</h2>
<dl class="ref-list">${ref('removeWarn')}
${ref('appeal')}
${ref('manualBan')}
${ref('void')}
${ref('imported')}</dl>
<p>${ti(k('standing'))}</p>`;
        },
    },
    {
        slug: 'appeals', key: 'appeals', minutes: 3,
        body: (ctx) => {
            const { t, ti } = textOf(ctx);
            const k = (key) => `docs.guides.appeals.${key}`;
            const ref = (term) => html`<div><dt>${t(k(`form.${term}`))}</dt><dd>${ti(k(`form.${term}Text`))}</dd></div>`;
            return html`<h2 id="where">${t(k('where.title'))}</h2>
<p>${ti(k('where.text'), { support: support(ctx) })}</p>
${appealFormMock()}
<h2 id="form">${t(k('form.title'))}</h2>
<dl class="ref-list">${ref('why')}
${ref('code')}
${ref('more')}</dl>
<h2 id="after">${t(k('after.title'))}</h2>
<ul><li>${ti(k('after.banKick'))}</li>
<li>${ti(k('after.muteWarn'))}</li>
<li>${ti(k('after.decision'))}</li></ul>
<h2 id="limits">${t(k('limits.title'))}</h2>
<ul><li>${ti(k('limits.onePending'))}</li>
<li>${ti(k('limits.cooldown'))}</li>
<li>${ti(k('limits.window'))}</li>
<li>${ti(k('limits.unappealable'))}</li></ul>`;
        },
    },
    {
        slug: 'using-the-dashboard', key: 'usingTheDashboard', minutes: 3,
        body: (ctx) => {
            const { t, ti } = textOf(ctx);
            const k = (key) => `docs.guides.usingTheDashboard.${key}`;
            const ref = (term) => html`<div><dt>${t(k(`areas.${term}`))}</dt><dd>${ti(k(`areas.${term}Text`))}</dd></div>`;
            return html`<h2 id="sign-in">${t(k('signIn.title'))}</h2>
<p>${ctx.dashboardEnabled ? ti(k('signIn.textLink'), { dashboard: DASHBOARD_PATH }) : ti(k('signIn.text'))}</p>
${dashboardShot({ name: 'cases', alt: t(k('shotAlt')), caption: t(k('shotCaption')) })}
<h2 id="areas">${t(k('areas.title'))}</h2>
<dl class="ref-list">${ref('moderate')}
${ref('community')}
${ref('setup')}
${ref('bot')}</dl>
<h2 id="changes">${t(k('changes.title'))}</h2>
<p>${ti(k('changes.text'))}</p>
<p>${ti(k('changes.phones'))}</p>`;
        },
    },
];

/** A guide's title and summary in the page's language. */
export function guideText(ctx, guide) {
    const { t } = textOf(ctx);
    return { title: t(`docs.guides.${guide.key}.title`), summary: t(`docs.guides.${guide.key}.summary`) };
}

export function docsPage(ctx) {
    const { t, ti } = textOf(ctx);
    return layout(ctx, {
        title: t('docs.meta.title'), active: 'docs', path: '/docs',
        description: t('docs.meta.description'),
        body: html`<div class="wrap page">
<header class="page-head page-head-split"><div><h1>${t('docs.hub.title')}</h1></div>
<p class="lead">${ti('docs.hub.lead')}</p></header>
<ol class="guide-list">${GUIDES.map((g) => { const g2 = guideText(ctx, g); return html`<li><a class="guide" href="/docs/${g.slug}"><span class="guide-text"><span class="guide-title">${g2.title}</span><span class="guide-summary">${g2.summary}</span></span></a></li>`; })}</ol></div>`,
    });
}

export function guidePage(ctx, guide) {
    const { t } = textOf(ctx);
    const index = GUIDES.indexOf(guide);
    const next = GUIDES[index + 1] || null;
    const { title, summary } = guideText(ctx, guide);
    return layout(ctx, {
        title, active: 'docs', path: `/docs/${guide.slug}`,
        description: summary,
        body: html`<div class="wrap page"><div class="doc">
<nav class="crumbs" aria-label="${t('docs.nav.crumbs')}"><a href="/docs">${t('docs.nav.docs')}</a><span aria-hidden="true">/</span><span>${title}</span></nav>
<header class="doc-head"><h1>${title}</h1><p class="lead">${summary}</p></header>
<div class="prose doc-body">${guide.body(ctx)}</div>
<nav class="doc-next" aria-label="${t('docs.nav.nextGuide')}">${next ? html`<a href="/docs/${next.slug}"><span class="doc-next-label">${t('docs.nav.next')}</span>${guideText(ctx, next).title}</a>` : html`<a href="/faq"><span class="doc-next-label">${t('docs.nav.stillQuestions')}</span>${t('docs.nav.readFaq')}</a>`}</nav></div></div>`,
    });
}
