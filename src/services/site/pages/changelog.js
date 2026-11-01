// changelog.js: /changelog, what changed in Mewvo (config/site/changelog.js), newest first.

import { html } from '../../dashboard/html.js';
import { layout } from '../shell.js';
import { CHANGELOG } from '../../../config/site/changelog.js';

const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

export function changelogPage(ctx, entries = CHANGELOG) {
    return layout(ctx, {
        title: 'Changelog', active: 'changelog', path: '/changelog',
        description: 'What changed in Mewvo, newest first.',
        body: html`<div class="wrap page prose"><h1>Changelog</h1>
<p class="lead">What changed in Mewvo, newest first. A change is listed when it is finished. The bot in your server gets it at its next update.</p>
${entries.map((entry) => html`<section class="changelog-entry" id="d-${entry.date}"><h2><time datetime="${entry.date}">${DATE.format(new Date(`${entry.date}T00:00:00Z`))}</time></h2>
<ul>${entry.items.map((item) => html`<li>${item}</li>`)}</ul></section>`)}</div>`,
    });
}
