// botLanguage.js: Bot → Bot language. The language Mewvo uses in this server for public posts
// and for DMs to members (punishments, appeal results). Replies only one person sees follow that
// person's own Discord language instead (owner's "mixed" rule, utils/botText.js).
// Stored as the registry setting `botLanguage` (guild_settings, saved through the settings
// service: validated, row-locked, one dashboard_audit row per change). Page text:
// src/content/dashboard/<lang>/botLanguage.json.
//
// Language roles card: one role per language (setting `languageRoles`); a member with one of
// them gets messages meant for them in that language, and /language hands them out. Saving
// roles that the bot gives to anyone who asks is Administrator-only (`admin: true`); each role
// must be safe to hand out (autoRoleField: no staff permissions, below the bot's role), and two
// languages cannot share a role.

import { html } from '../html.js';
import { InputError, autoRoleField, choiceField, postForm, rolePicker, selectInput } from '../forms.js';
import { textFor } from '../language.js';
import { LANGUAGES, LANG_CODES } from '../../site/i18n.js';
import { changedOnly, registrySaved, registryValue, saveRegistry, section } from './common.js';
import { detectedServerLanguage } from '../../../utils/botText.js';
import { isHomeScope, managerActions } from './serverScope.js';

const languageName = (code) => LANGUAGES.find((l) => l.code === code)?.name || code;
/** The form field of a language's role ('pt-BR' → role_pt_BR). */
export const roleFieldName = (code) => `role_${code.replace('-', '_')}`;
/** Only the languages with a role, in the fixed order (so a stored null or key order is no change). */
const setRoles = (map) => Object.fromEntries(LANG_CODES.filter((code) => map?.[code]).map((code) => [code, map[code]]));

export default {
    key: 'bot-language',
    label: 'Bot language',
    help: 'The language Mewvo uses in this server for posts and for DMs to members. Answers only one person sees follow that person\'s own Discord language.',

    async load(ctx) {
        const value = registryValue(ctx, 'botLanguage');
        const roles = registryValue(ctx, 'languageRoles');
        // Not chosen yet (another server): Mewvo uses the server's Discord language (utils/botText.js);
        // the picker shows that one, and saving it makes it the server's choice.
        const saved = isHomeScope(ctx) || registrySaved(ctx, 'botLanguage');
        // English (also Discord's default 'en-US' for servers that never set one) is shown as "not chosen".
        const found = saved ? null : detectedServerLanguage(ctx.guildId, { locale: ctx.guild?.preferredLocale ?? null });
        const detected = found && found !== 'en' ? found : null;
        const language = detected || (LANG_CODES.includes(value) ? value : 'en');
        return { language, saved, detected, roles: roles && typeof roles === 'object' ? roles : {} };
    },

    render(ctx, { language, saved = true, detected = null, roles = {} }) {
        const tr = textFor(ctx);
        const note = saved ? '' : html`<p class="muted">${detected
            ? tr.t('botLanguage.form.detected', { language: languageName(detected) })
            : tr.t('botLanguage.form.notChosen')}</p>`;
        const form = postForm(ctx, 'bot-language', 'language', html`${note}${selectInput('botLanguage', language,
            LANGUAGES.map((l) => [l.code, l.name]), { label: tr.t('botLanguage.form.label'), help: tr.t('botLanguage.form.help') })}`);
        return html`${section(tr.t('botLanguage.card.title'), form, tr.t('botLanguage.card.help'), { key: 'language' })}
${section(tr.t('botLanguage.roles.title'), postForm(ctx, 'bot-language', 'language-roles', LANGUAGES.map((l) => rolePicker(ctx.guild, roleFieldName(l.code), roles[l.code] || null, {
            label: l.name, autoAssign: true, noneLabel: tr.t('botLanguage.roles.none'),
        })), { canEdit: ctx.canEdit && ctx.canAct }), tr.t('botLanguage.roles.help'), { key: 'language-roles' })}
${section(tr.t('botLanguage.rule.title'), html`<ul><li>${tr.t('botLanguage.rule.public')}</li><li>${tr.t('botLanguage.rule.private')}</li><li>${tr.t('botLanguage.rule.done')}</li></ul>`, '', { key: 'rule' })}`;
    },

    actions: managerActions(['language'], {
        async language(ctx, form) {
            const tr = textFor(ctx);
            const botLanguage = choiceField(form, 'botLanguage', LANG_CODES, tr.t('botLanguage.form.label'));
            // No change: the frame's own "Nothing changed." (errors.nothingChanged). Not saved yet:
            // saving the shown language (even English) makes it this server's choice.
            if (botLanguage === registryValue(ctx, 'botLanguage') && (isHomeScope(ctx) || registrySaved(ctx, 'botLanguage'))) return { changes: [] };
            const result = await saveRegistry(ctx, { botLanguage }, 'botLanguage');
            return { ...result, message: tr.t('botLanguage.saved.done', { language: languageName(botLanguage) }) };
        },
        // Role-granting: Administrator-only (tests/helpers/privilegedActions.js).
        'language-roles': {
            admin: true,
            async run(ctx, form) {
                const tr = textFor(ctx);
                const next = {};
                const seen = new Map();
                for (const { code, name } of LANGUAGES) {
                    const field = roleFieldName(code);
                    const roleId = autoRoleField(ctx.guild, form, field, { optional: true, label: name });
                    if (!roleId) continue;
                    if (seen.has(roleId)) throw new InputError(tr.t('botLanguage.roles.duplicate', { first: seen.get(roleId), second: name }), 400, field);
                    seen.set(roleId, name);
                    next[code] = roleId;
                }
                if (!Object.keys(changedOnly({ languageRoles: next }, { languageRoles: setRoles(registryValue(ctx, 'languageRoles')) })).length) return { changes: [] };
                const result = await saveRegistry(ctx, { languageRoles: next }, 'botLanguage');
                return { ...result, message: tr.t('botLanguage.roles.saved') };
            },
        },
    }),
};
