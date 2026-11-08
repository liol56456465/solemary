// botLanguage.js: Bot → Bot language. The language Mewvo uses in this server for public posts
// and for DMs to members (punishments, appeal results). Replies only one person sees follow that
// person's own Discord language instead (owner's "mixed" rule, utils/botText.js).
// Stored as the registry setting `botLanguage` (guild_settings, saved through the settings
// service: validated, row-locked, one dashboard_audit row per change). Page text:
// src/content/dashboard/<lang>/botLanguage.json.

import { html } from '../html.js';
import { choiceField, postForm, selectInput } from '../forms.js';
import { textFor } from '../language.js';
import { LANGUAGES, LANG_CODES } from '../../site/i18n.js';
import { registryValue, saveRegistry, section } from './common.js';
import { managerActions } from './serverScope.js';

const languageName = (code) => LANGUAGES.find((l) => l.code === code)?.name || code;

export default {
    key: 'bot-language',
    label: 'Bot language',
    help: 'The language Mewvo uses in this server for posts and for DMs to members. Answers only one person sees follow that person\'s own Discord language.',

    async load(ctx) {
        const value = registryValue(ctx, 'botLanguage');
        return { language: LANG_CODES.includes(value) ? value : 'en' };
    },

    render(ctx, { language }) {
        const tr = textFor(ctx);
        const form = postForm(ctx, 'bot-language', 'language', selectInput('botLanguage', language,
            LANGUAGES.map((l) => [l.code, l.name]), { label: tr.t('botLanguage.form.label'), help: tr.t('botLanguage.form.help') }));
        return html`${section(tr.t('botLanguage.card.title'), form, tr.t('botLanguage.card.help'), { key: 'language' })}
${section(tr.t('botLanguage.rule.title'), html`<ul><li>${tr.t('botLanguage.rule.public')}</li><li>${tr.t('botLanguage.rule.private')}</li><li>${tr.t('botLanguage.rule.done')}</li></ul>`, '', { key: 'rule' })}`;
    },

    actions: managerActions(['language'], {
        async language(ctx, form) {
            const tr = textFor(ctx);
            const botLanguage = choiceField(form, 'botLanguage', LANG_CODES, tr.t('botLanguage.form.label'));
            // No change: the frame's own "Nothing changed." (errors.nothingChanged).
            if (botLanguage === registryValue(ctx, 'botLanguage')) return { changes: [] };
            const result = await saveRegistry(ctx, { botLanguage }, 'botLanguage');
            return { ...result, message: tr.t('botLanguage.saved.done', { language: languageName(botLanguage) }) };
        },
    }),
};
