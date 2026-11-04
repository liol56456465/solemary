// changelog.js: /changelog, what changed in Mewvo (config/site/changelog.js for the order,
// content/site/<lang>/changelog.json for the text), newest first.

import { html } from '../../dashboard/html.js';
import { textOf } from '../i18n.js';
import { layout } from '../shell.js';
import { CHANGELOG, changelogKey } from '../../../config/site/changelog.js';

// English dates read "1 November 2026" (en-GB); other languages use their own locale (fmtDate, i18n.js).
export function changelogPage(ctx, entries = CHANGELOG) {
    const { t, fmtDate } = textOf(ctx);
    return layout(ctx, {
        title: t('changelog.head.title'), active: 'changelog', path: '/changelog',
        description: t('changelog.meta.description'),
        body: html`<div class="wrap page prose"><h1>${t('changelog.head.title')}</h1>
<p class="lead">${t('changelog.head.lead')}</p>
${entries.map((entry) => html`<section class="changelog-entry" id="d-${entry.date}"><h2><time datetime="${entry.date}">${fmtDate(new Date(`${entry.date}T00:00:00Z`))}</time></h2>
<ul>${entry.items.map((item) => html`<li>${t(changelogKey(entry.date, item))}</li>`)}</ul></section>`)}</div>`,
    });
}
