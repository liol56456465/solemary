// faq.js — /faq: real questions with short answers (from CLAUDE.md and the code). Each answer
// is a <details> block: opens with the keyboard, works without a script.
// Text: content/site/<lang>/faq.json (faq.<group>.title, faq.<group>.<item>.q / .a).

import { html } from '../../dashboard/html.js';
import { layout } from '../shell.js';
import { textOf } from '../i18n.js';

function faqItems(ctx) {
    const { t, ti } = textOf(ctx);
    const support = ctx.supportInvite ? ti('faq.support.link', { url: ctx.supportInvite }) : t('faq.support.text');
    const qa = (group, item, answerKey = 'a', questionKey = 'q') => [t(`faq.${group}.${item}.${questionKey}`), html`<p>${ti(`faq.${group}.${item}.${answerKey}`, { support })}</p>`];
    // PUBLIC_SITE_ENABLED: "Can I add it to my server?" and "free in every server" instead of the
    // private-site texts ("Why can't I add it yet?", "plans start when Mewvo opens").
    const pub = Boolean(ctx.publicSite);
    return [
        {
            group: t('faq.about.title'),
            items: [
                qa('about', 'whatDoes'),
                qa('about', 'notYet', pub ? 'aPublic' : 'a', pub ? 'qPublic' : 'q'),
                qa('about', 'free', pub ? 'aPublic' : 'a'),
            ],
        },
        {
            group: t('faq.appeals.title'),
            items: [
                qa('appeals', 'ladder'),
                qa('appeals', 'howTo', ctx.memberPortal ? 'aPortal' : 'a'),
                ...(ctx.memberPortal ? [qa('appeals', 'web')] : []),
                qa('appeals', 'lostCode', ctx.memberPortal ? 'aPortal' : 'a'),
                qa('appeals', 'everyPunishment'),
            ],
        },
        {
            group: t('faq.admins.title'),
            items: [
                qa('admins', 'whoDecides'),
                qa('admins', 'otherServers'),
                qa('admins', 'removeBot'),
                qa('admins', 'dashboardTeam'),
                qa('admins', 'readMessages'),
            ],
        },
        {
            group: t('faq.data.title'),
            items: [
                qa('data', 'stored'),
                qa('data', 'reachStaff'),
                qa('data', 'down'),
            ],
        },
    ];
}

export function faqPage(ctx) {
    const { t, ti } = textOf(ctx);
    const groups = faqItems(ctx);
    return layout(ctx, {
        title: t('faq.meta.title'), active: 'faq', path: '/faq',
        description: t('faq.meta.description'),
        body: html`<div class="wrap page">
<header class="page-head page-head-split"><div><h1>${t('faq.head.title')}</h1></div>
<p class="lead">${ti('faq.head.lead')}</p></header>
${groups.map((g, i) => html`<section class="faq-group split split-narrow" aria-labelledby="faq-${i}"><div class="split-copy"><h2 id="faq-${i}">${g.group}</h2></div>
<div class="faq-list">${g.items.map(([q, a]) => html`<details class="faq"><summary>${q}</summary><div class="faq-answer">${a}</div></details>`)}</div></section>`)}</div>`,
    });
}
