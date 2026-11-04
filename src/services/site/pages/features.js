// features.js — /features: the full feature reference, grouped by area. Plain and specific;
// written from the commands, config/enforcement.js, config/automod.js and CLAUDE.md.
// Text: src/content/site/<lang>/features.json (features.groups.<group>.items.<item>.term / .text).

import { html } from '../../dashboard/html.js';
import { textOf } from '../i18n.js';
import { layout } from '../shell.js';

/** The areas in page order: the group key (anchor #f-<key>) and its item keys in order. */
export const FEATURE_GROUPS = Object.freeze([
    { key: 'enforcement', items: ['enforcementsPanel', 'reasons', 'caseCodes', 'dms', 'mutes', 'safetyChecks', 'massActionGuard', 'caseTools', 'warnForMessage', 'simulation', 'noContactOrders'] },
    { key: 'ladder', items: ['levels', 'neverResets', 'corrections', 'level3Appeals', 'myStanding'] },
    { key: 'appeals', items: ['appealPanel', 'appealForm', 'banAndKickAppeals', 'limits', 'decisions', 'bannedRole', 'staffReports'] },
    { key: 'automod', items: ['builtInRules', 'customRules', 'punishmentSteps', 'reviewCards', 'modes', 'hardToDodge', 'newMembers', 'raids', 'memberReports', 'nativeAutomod'] },
    { key: 'tickets', items: ['ticketPanel', 'transcripts', 'modmail', 'modmailCommands'] },
    { key: 'dashboard', items: ['signIn', 'moderate', 'settings', 'auditLog', 'temporaryRoles'] },
    { key: 'community', items: ['leveling', 'tags', 'suggestions', 'starboard', 'stickyMessages', 'youtubeFeeds', 'reactionRoles', 'giveaways', 'birthdays', 'applications', 'joinToCreate', 'welcomeAndGoodbye', 'counters'] },
    { key: 'server', items: ['logging', 'verification', 'postingAsBot', 'memberTools'] },
]);

export function featuresPage(ctx) {
    const { t, ti } = textOf(ctx);
    const group = (g, part) => t(`features.groups.${g.key}.${part}`);
    const item = (g, key, part) => t(`features.groups.${g.key}.items.${key}.${part}`);
    return layout(ctx, {
        title: t('features.head.title'), active: 'features', path: '/features',
        description: t('features.meta.description'),
        body: html`<div class="wrap page">
<header class="page-head"><h1>${t('features.head.title')}</h1>
<p class="lead">${ti('features.head.lead')}</p></header>
<div class="with-index"><nav class="index" aria-label="${t('features.head.indexLabel')}"><ol>${FEATURE_GROUPS.map((g) => html`<li><a href="#f-${g.key}">${group(g, 'title')}</a></li>`)}</ol></nav>
<div class="index-body">${FEATURE_GROUPS.map((g) => html`<section class="ref-group" id="f-${g.key}" aria-labelledby="f-${g.key}-title">
<h2 id="f-${g.key}-title">${group(g, 'title')}</h2><p class="ref-intro">${group(g, 'intro')}</p>
<dl class="ref-list">${g.items.map((key) => html`<div><dt>${item(g, key, 'term')}</dt><dd>${item(g, key, 'text')}</dd></div>`)}</dl></section>`)}</div></div></div>`,
    });
}
