// enforcement.js — Enforcement & appeals: the per-server settings moved into
// guild_settings (channels, roles, appeal timings, mass-action guard, stale reports),
// plus the warn ladder, reasons and automod steps read-only (owner decision 3).

import { ENFORCEMENT_REASONS, enforcementConfig } from '../../../config/enforcement.js';
import { AUTOMOD_RULES } from '../../../config/automod.js';
import { html, raw } from '../html.js';
import { InputError, PERMS, boolField, channelField, channelPicker, checkbox, choiceField, numberInput, postForm, roleField, rolePicker, switchInput, text, textInput, toggleForm } from '../forms.js';
import { MAX_TEMPLATES, TEMPLATE_ACTIONS, TEMPLATE_ID, TEMPLATE_NAME_MAX, cleanTemplates, newTemplateId, withTemplateIds } from '../../enforcement/templateService.js';
import { DAY, MINUTE, changedOnly, durationField, registryValue, saveRegistry, saveRegistryWith, section, table, topic } from './common.js';
import { textFor } from '../language.js';
import { inviteOrNull } from '../../site/shell.js';
import { isHomeScope, adminOnlyActions } from './serverScope.js';

// Words: src/content/dashboard/<lang>/enforcement.json. Reason labels (config/enforcement.js) and
// automod rule names (config/automod.js) come from the config and stay as they are.

const KEYS = [
    'adminRequestChannelId', 'modLogChannelId', 'evidenceChannelId', 'appealsCategoryId', 'reportsCategoryId', 'modmailCategoryId',
    'openChannelCap', 'mutedRoleId', 'warnRoleIds',
    'appealWindowMs', 'appealCooldownMs', 'rejoinInviteMaxAgeSeconds', 'staleReportMs',
    'staleAppealReminderMs', 'independentAppealReview', 'massActionLimit', 'massMuteLimit', 'massActionWindowMs', 'massActionBlockMs',
    'enforcementTemplates',
];
// Mewvo's own servers only (multi-server B3, section 4): the Support invite and the public pages.
const HOME_KEYS = ['supportServerInvite', 'transparencyReportEnabled', 'trustCardEnabled'];
// Other servers only: where their members appeal (Mewvo support or their own server).
const OTHER_KEYS = ['appealsHome', 'appealsInvite'];
export const APPEALS_HOME_CHOICES = Object.freeze(['mewvo', 'own']);

function current(ctx) {
    const keys = [...KEYS, ...(isHomeScope(ctx) ? HOME_KEYS : OTHER_KEYS)];
    return Object.fromEntries(keys.map((key) => [key, registryValue(ctx, key)]));
}

/** The appeals-home form, checked: { appealsHome, appealsInvite }. 'own' without an invite is allowed (the DM then has no invite line). */
export function appealsHomeForm(ctx, form) {
    const tr = textFor(ctx);
    const appealsHome = choiceField(form, 'appealsHome', APPEALS_HOME_CHOICES, tr.t('enforcement.appealsHome.choice'));
    const typed = text(form, 'appealsInvite', 200);
    const appealsInvite = typed ? inviteOrNull(typed) : null;
    if (typed && !appealsInvite) throw new InputError(tr.t('enforcement.appealsHome.badInvite'), 400, 'appealsInvite');
    return { appealsHome, appealsInvite };
}

/** Radio buttons: one name, [value, label] choices. */
function radios(name, value, choices, legend) {
    return html`<fieldset class="radios"><legend>${legend}</legend>${choices.map(([v, label]) => html`<label class="check"><input type="radio" name="${name}" value="${v}"${v === value ? raw(' checked') : ''}> ${label}</label>`)}</fieldset>`;
}

/** "Nothing changed." in the request's language (the same words routes.js uses). */
const nothing = (ctx) => ({ changes: [], message: textFor(ctx).t('errors.nothingChanged') });

/** The punishment words (warn, mute, kick, ban) of a language. */
function actionWords(tr) {
    return { warn: tr.t('enforcement.action.warn'), mute: tr.t('enforcement.action.mute'), kick: tr.t('enforcement.action.kick'), ban: tr.t('enforcement.action.ban') };
}

const UNITS = [['month', 30 * DAY], ['day', DAY], ['hour', 60 * MINUTE], ['minute', MINUTE]];
/** A length of time as enforcement/format.js formatDuration writes it ("1 month", "7 days", "1 hour 30 minutes"), in the language. */
function durationText(tr, ms) {
    const unit = {
        month: (n) => tr.tp('enforcement.unit.month', n), day: (n) => tr.tp('enforcement.unit.day', n),
        hour: (n) => tr.tp('enforcement.unit.hour', n), minute: (n) => tr.tp('enforcement.unit.minute', n),
    };
    const parts = [];
    let rest = ms;
    for (const [name, size] of UNITS) {
        const count = Math.floor(rest / size);
        if (count > 0) {
            parts.push(unit[name](count));
            rest -= count * size;
        }
    }
    return parts.slice(0, 2).join(' ') || tr.t('enforcement.unit.lessThanMinute');
}

function stepText(tr, step) {
    const type = actionWords(tr)[step.type] || step.type;
    if (step.type === 'warn') return type;
    if (!step.durationMs) return tr.t('enforcement.rules.stepPermanent', { type });
    return tr.t('enforcement.rules.stepFor', { type, duration: durationText(tr, step.durationMs) });
}

/** What a template does, as templateService.templateLabel writes it ("1h mute", "permanent ban"), in the language. */
function templateText(tr, t) {
    if (t.action === 'mute') return tr.t('enforcement.templates.muteFor', { duration: t.duration });
    if (t.action === 'ban') return t.duration ? tr.t('enforcement.templates.banFor', { duration: t.duration }) : tr.t('enforcement.templates.banPermanent');
    return actionWords(tr)[t.action] || t.action;
}

export default {
    key: 'enforcement',
    label: 'Enforcement & appeals',
    help: 'How punishments (warns, mutes, kicks and bans) work in this server: where they are written down, which roles show that someone is muted or warned, and how members can ask for a punishment to be lifted (an appeal). /enforcements in Discord uses these settings.',

    async load(ctx) {
        return { values: current(ctx) };
    },

    render(ctx, { values: v }) {
        const g = ctx.guild;
        const tr = textFor(ctx);
        const t = (key, params) => tr.t(key, params);
        const warn = v.warnRoleIds || [];
        const home = isHomeScope(ctx);
        // Roles, safety limits and appeal review: Administrator only (a Manage Server manager must not raise their own access).
        const adminEdit = ctx.canEdit && ctx.canAct;
        const appealsHome = home
            ? html`<p class="muted">${t('enforcement.appealsHome.homeNote')}</p>`
            : postForm(ctx, 'enforcement', 'appeals-home', html`${radios('appealsHome', v.appealsHome === 'own' ? 'own' : 'mewvo', [['mewvo', t('enforcement.appealsHome.mewvo')], ['own', t('enforcement.appealsHome.own')]], t('enforcement.appealsHome.choice'))}
${textInput('appealsInvite', v.appealsInvite || '', { label: t('enforcement.appealsHome.invite'), max: 200, placeholder: 'https://discord.gg/…', help: t('enforcement.appealsHome.inviteHelp') })}`);
        const channels = postForm(ctx, 'enforcement', 'channels', html`<div class="grid">
${channelPicker(g, 'modLogChannelId', v.modLogChannelId, { label: t('enforcement.channels.modLog'), perms: PERMS.post, help: t('enforcement.channels.modLogHelp') })}
${channelPicker(g, 'evidenceChannelId', v.evidenceChannelId, { label: t('enforcement.channels.evidence'), perms: PERMS.postFiles, help: t('enforcement.channels.evidenceHelp') })}
${channelPicker(g, 'adminRequestChannelId', v.adminRequestChannelId, { label: t('enforcement.channels.adminRequest'), perms: PERMS.post, help: t('enforcement.channels.adminRequestHelp') })}
${channelPicker(g, 'appealsCategoryId', v.appealsCategoryId, { label: t('enforcement.channels.appealsCategory'), kinds: ['category'], perms: PERMS.category, help: t('enforcement.channels.appealsCategoryHelp') })}
${channelPicker(g, 'reportsCategoryId', v.reportsCategoryId, { label: t('enforcement.channels.reportsCategory'), kinds: ['category'], perms: PERMS.category, help: t('enforcement.channels.reportsCategoryHelp') })}
${channelPicker(g, 'modmailCategoryId', v.modmailCategoryId, { label: t('enforcement.channels.modmailCategory'), kinds: ['category'], perms: PERMS.category, help: t('enforcement.channels.modmailCategoryHelp') })}
${numberInput('openChannelCap', v.openChannelCap, { label: t('enforcement.channels.openCap'), min: 1, max: 45, help: t('enforcement.channels.openCapHelp') })}
${home ? textInput('supportServerInvite', v.supportServerInvite, { label: t('enforcement.channels.invite'), max: 100, placeholder: 'https://discord.gg/…', help: t('enforcement.channels.inviteHelp') }) : ''}
</div>`);
        const roles = postForm(ctx, 'enforcement', 'roles', html`<div class="grid">
${rolePicker(g, 'mutedRoleId', v.mutedRoleId, { label: t('enforcement.roles.muted'), help: t('enforcement.roles.mutedHelp') })}
${rolePicker(g, 'warnRole1', warn[0] || null, { label: t('enforcement.roles.warn1') })}
${rolePicker(g, 'warnRole2', warn[1] || null, { label: t('enforcement.roles.warn2') })}
${rolePicker(g, 'warnRole3', warn[2] || null, { label: t('enforcement.roles.warn3') })}
</div>`, { canEdit: adminEdit });
        const timings = postForm(ctx, 'enforcement', 'timings', html`<div class="grid">
${numberInput('appealWindowDays', Math.round(v.appealWindowMs / DAY), { label: t('enforcement.timings.window'), min: 1, max: 365, help: t('enforcement.timings.windowHelp') })}
${numberInput('appealCooldownDays', Math.round(v.appealCooldownMs / DAY), { label: t('enforcement.timings.cooldown'), min: 0, max: 90, help: t('enforcement.timings.cooldownHelp') })}
${numberInput('rejoinInviteHours', Math.round(v.rejoinInviteMaxAgeSeconds / 3600), { label: t('enforcement.timings.rejoin'), min: 1, max: 168, help: t('enforcement.timings.rejoinHelp') })}
${numberInput('staleReportDays', Math.round(v.staleReportMs / DAY), { label: t('enforcement.timings.staleReport'), min: 1, max: 90, help: t('enforcement.timings.staleReportHelp') })}
${numberInput('staleAppealReminderDays', Math.round(v.staleAppealReminderMs / DAY), { label: t('enforcement.timings.staleAppeal'), min: 1, max: 90, help: t('enforcement.timings.staleAppealHelp') })}
</div>`);
        const review = postForm(ctx, 'enforcement', 'appeal-review', switchInput('independentAppealReview', v.independentAppealReview === true, {
            label: t('enforcement.review.label'),
            help: t('enforcement.review.labelHelp'),
        }), { canEdit: adminEdit });
        const mass = postForm(ctx, 'enforcement', 'mass-action', html`<div class="grid">
${numberInput('massActionLimit', v.massActionLimit, { label: t('enforcement.mass.limit'), min: 1, max: 100, help: t('enforcement.mass.limitHelp') })}
${numberInput('massMuteLimit', v.massMuteLimit, { label: t('enforcement.mass.muteLimit'), min: 1, max: 200, help: t('enforcement.mass.muteLimitHelp') })}
${numberInput('massActionWindowMinutes', Math.round(v.massActionWindowMs / MINUTE), { label: t('enforcement.mass.window'), min: 1, max: 1440 })}
${numberInput('massActionBlockMinutes', Math.round(v.massActionBlockMs / MINUTE), { label: t('enforcement.mass.block'), min: 1, max: 10080, help: t('enforcement.mass.blockHelp') })}
</div>`, { canEdit: adminEdit });
        const ladder = table([t('enforcement.rules.level'), t('enforcement.rules.banLength')], Object.entries(enforcementConfig.ladderBans).map(([level, ms]) => [level, ms ? durationText(tr, ms) : t('enforcement.rules.permanent')]));
        const words = actionWords(tr);
        // Ids: stored ones, or derived from the name for templates saved before ids (templateService.js).
        const templates = withTemplateIds(v.enforcementTemplates);
        const reasonLabel = (key) => ENFORCEMENT_REASONS.find((r) => r.key === key)?.label || key;
        const templateList = templates.length
            ? table([t('enforcement.templates.name'), t('enforcement.templates.whatItDoes'), t('enforcement.templates.reason'), ''], templates.map((tp) => [tp.name, templateText(tr, tp), reasonLabel(tp.reasonKey),
                postForm(ctx, 'enforcement', 'template-remove', html`<input type="hidden" name="id" value="${tp.id}">`, { submit: t('enforcement.templates.remove'), inline: true, danger: true, confirm: t('enforcement.templates.removeConfirm', { name: tp.name }) })]))
            : html`<p class="muted">${tr.tx('enforcement.templates.empty')}</p>`;
        const templateAdd = templates.length >= MAX_TEMPLATES ? html`<p class="muted">${tr.tx('enforcement.templates.max', { count: tr.fmtNumber(MAX_TEMPLATES) })}</p>` : postForm(ctx, 'enforcement', 'template-add', html`<div class="grid">
<label>${tr.tx('enforcement.templates.name')}<input name="name" maxlength="${TEMPLATE_NAME_MAX}" required placeholder="${t('enforcement.templates.namePlaceholder')}"><span class="hint">${tr.tx('enforcement.templates.nameHint')}</span></label>
<label>${tr.tx('enforcement.templates.action')}<select name="action">${TEMPLATE_ACTIONS.map((a) => html`<option value="${a}">${words[a] || a}</option>`)}</select></label>
<label>${tr.tx('enforcement.templates.reason')}<select name="reasonKey">${ENFORCEMENT_REASONS.map((r) => html`<option value="${r.key}">${r.label}</option>`)}</select></label>
<label>${tr.tx('enforcement.templates.duration')}<input name="duration" maxlength="20" placeholder="${t('enforcement.templates.durationPlaceholder')}"><span class="hint">${tr.tx('enforcement.templates.durationHint')}</span></label>
</div>`, { submit: t('enforcement.templates.add') });
        const reasons = table([t('enforcement.rules.code'), t('enforcement.rules.reason'), t('enforcement.rules.serious')], ENFORCEMENT_REASONS.map((r) => [html`<code>${r.key}</code>`, r.label, r.severe ? t('enforcement.rules.yes') : t('enforcement.rules.no')]));
        const steps = table([t('enforcement.rules.rule'), t('enforcement.rules.whatHappens')], Object.values(AUTOMOD_RULES).map((r) => [r.label, r.steps.map((step) => stepText(tr, step)).join(' → ')]));
        const appealPanels = postForm(ctx, 'enforcement', 'appeal-panels',
            channelPicker(g, 'channelId', null, { label: t('enforcement.panels.channel'), perms: PERMS.post, optional: false, help: t('enforcement.panels.channelHelp') }),
            { submit: t('enforcement.panels.submit'), canEdit: ctx.canEdit && ctx.canAct, confirm: t('enforcement.panels.confirm') });
        // Admin-only (like the appeal panels): it publishes numbers about the server on the website.
        const transparency = toggleForm(ctx, 'enforcement', 'transparency', v.transparencyReportEnabled === true, {
            label: t('enforcement.pages.transparencyToggle'), canEdit: ctx.canEdit && ctx.canAct,
            confirmOff: t('enforcement.pages.transparencyOff'),
        });
        // Admin-only too: a public summary of how this server moderates (/trust).
        const trustOn = v.trustCardEnabled === true;
        const trust = html`${toggleForm(ctx, 'enforcement', 'trust-card', trustOn, {
            label: t('enforcement.pages.trustToggle'), canEdit: ctx.canEdit && ctx.canAct,
            confirmOff: t('enforcement.pages.trustOff'),
        })}${trustOn ? html`<p class="muted">${tr.tx('enforcement.pages.trustPublic', { link: html`<a href="/trust">/trust</a>` })}</p>` : ''}`;
        // v6: cards grouped by topic (common.js topic/section). Explicit keys: the ids stay the English slugs in every language.
        const adminOnly = ctx.canAct ? '' : t('enforcement.adminOnly');
        const where = topic(t('enforcement.topic.where'), t('enforcement.topic.whereLine'), html`${section(t('enforcement.channels.title'), channels, t('enforcement.channels.help'), { key: 'channels', size: 'wide' })}
${section(t('enforcement.roles.title'), roles, `${t('enforcement.roles.help')}${adminOnly}`, { key: 'roles', size: 'full' })}`, { key: 'channels-and-roles' });
        const appeals = topic(t('enforcement.topic.appeals'), t('enforcement.topic.appealsLine'), html`${section(t('enforcement.panels.title'), appealPanels, `${t('enforcement.panels.help')}${adminOnly}`, { key: 'appeal-panels' })}
${section(t('enforcement.appealsHome.title'), appealsHome, t('enforcement.appealsHome.help'), { key: 'where-members-appeal' })}
${section(t('enforcement.review.title'), review, `${t('enforcement.review.help')}${adminOnly}`, { key: 'independent-appeal-review' })}
${section(t('enforcement.timings.title'), timings, t('enforcement.timings.help'), { key: 'appeals-and-reports', size: 'full' })}`, { key: 'appeals' });
        const safety = topic(t('enforcement.topic.safety'), t('enforcement.topic.safetyLine'), html`${section(t('enforcement.mass.title'), mass, `${t('enforcement.mass.help')}${adminOnly}`, { key: 'safety-limit-too-many-bans-or-kicks-in-a-short-time', size: 'full' })}
${section(t('enforcement.templates.title'), html`${templateList}${templateAdd}`, t('enforcement.templates.help'), { key: 'templates', size: 'wide' })}`, { key: 'moderator-tools-and-safety' });
        const pages = topic(t('enforcement.topic.pages'), t('enforcement.topic.pagesLine'), html`${section(t('enforcement.pages.transparencyTitle'), transparency, [t('enforcement.pages.transparencyHelp'), `${t('enforcement.pages.transparencyMore')}${adminOnly}`], { key: 'transparency-report' })}
${section(t('enforcement.pages.trustTitle'), trust, [t('enforcement.pages.trustHelp'), `${t('enforcement.pages.trustMore')}${adminOnly}`], { key: 'trust-card' })}`, { key: 'public-pages' });
        const rules = topic(t('enforcement.topic.rules'), t('enforcement.topic.rulesLine'), html`${section(t('enforcement.rules.ladderTitle'), html`<p class="muted">${tr.tx('enforcement.rules.ladderText', { count: tr.fmtNumber(enforcementConfig.warnsPerLevel) })}</p>${ladder}`, t('enforcement.rules.ladderHelp'), { key: 'warn-ladder', size: 'normal' })}
${section(t('enforcement.rules.reasonsTitle'), reasons, [t('enforcement.rules.reasonsHelp'), t('enforcement.rules.reasonsMore')], { key: 'reasons', size: 'normal' })}
${section(t('enforcement.rules.stepsTitle'), steps, t('enforcement.rules.stepsHelp'), { key: 'automod-steps', size: 'full' })}`, { key: 'how-punishments-add-up' });
        // The public pages (transparency report, trust card) are Mewvo's own servers only for now.
        return html`${where}${appeals}${safety}${home ? pages : ''}${rules}`;
    },

    // Safety module: every action needs Administrator (serverScope.js adminOnlyActions).
    actions: adminOnlyActions({
        'appeal-panels': {
            admin: true,
            async run(ctx, form) {
                const tr = textFor(ctx);
                const channelId = channelField(ctx.guild, form, 'channelId', { optional: false, label: tr.t('enforcement.panels.channel') });
                const { mainChannel, supportChannel, created } = await ctx.services.postAppealPanels(ctx.client, ctx.guild, ctx.guild.channels.cache.get(channelId), { reason: `dashboard: ${ctx.actor.username}` });
                return {
                    changes: [{ key: 'appealPanels', old: null, new: { main: mainChannel.id, support: supportChannel.id } }],
                    message: tr.t(created ? 'enforcement.result.panelsPostedCreated' : 'enforcement.result.panelsPosted', { main: mainChannel.name, support: supportChannel.name }),
                };
            },
        },
        // Add and remove run under the settings row lock (saveRegistryWith): two admins at once
        // cannot overwrite each other's change, and a remove names the template by its stable id.
        async 'template-add'(ctx, form) {
            const tr = textFor(ctx);
            const input = { name: text(form, 'name', TEMPLATE_NAME_MAX + 10), action: text(form, 'action', 10), reasonKey: text(form, 'reasonKey', 40), duration: text(form, 'duration', 20) };
            let added = null;
            const result = await saveRegistryWith(ctx, ['enforcementTemplates'], (valueOf) => {
                const list = withTemplateIds(valueOf('enforcementTemplates'));
                let next;
                try {
                    next = cleanTemplates([...list, { ...input, id: newTemplateId() }]);
                } catch (error) {
                    throw new InputError(error.userMessage || tr.t('enforcement.result.templateInvalid'));
                }
                added = next.at(-1);
                return { enforcementTemplates: next };
            }, 'enforcement');
            return { ...result, message: tr.t('enforcement.result.templateAdded', { name: added.name }) };
        },
        async 'template-remove'(ctx, form) {
            const tr = textFor(ctx);
            const id = text(form, 'id', 20);
            if (!TEMPLATE_ID.test(id)) throw new InputError(tr.t('enforcement.result.templateGone'));
            let removed = null;
            const result = await saveRegistryWith(ctx, ['enforcementTemplates'], (valueOf) => {
                const list = withTemplateIds(valueOf('enforcementTemplates'));
                removed = list.find((t) => t.id === id) || null;
                if (!removed) throw new InputError(tr.t('enforcement.result.templateGone'));
                return { enforcementTemplates: list.filter((t) => t.id !== id) };
            }, 'enforcement');
            return { ...result, message: tr.t('enforcement.result.templateRemoved', { name: removed.name }) };
        },
        // Other servers only: where members appeal (punishment DMs). Home servers always use the Mewvo support server.
        async 'appeals-home'(ctx, form) {
            const tr = textFor(ctx);
            if (isHomeScope(ctx)) throw new InputError(tr.t('enforcement.appealsHome.homeOnlyAction'));
            const patch = changedOnly(appealsHomeForm(ctx, form), current(ctx));
            if (!Object.keys(patch).length) return nothing(ctx);
            return saveRegistry(ctx, patch, 'enforcement');
        },
        transparency: {
            admin: true,
            async run(ctx, form) {
                const tr = textFor(ctx);
                const enabled = boolField(form, 'enabled', tr.t('enforcement.pages.transparencyTitle'));
                const patch = changedOnly({ transparencyReportEnabled: enabled }, current(ctx));
                if (!Object.keys(patch).length) return nothing(ctx);
                const result = await saveRegistry(ctx, patch, 'enforcement');
                return { ...result, message: tr.t(enabled ? 'enforcement.result.transparencyOn' : 'enforcement.result.transparencyOff') };
            },
        },
        'trust-card': {
            admin: true,
            async run(ctx, form) {
                const tr = textFor(ctx);
                const enabled = boolField(form, 'enabled', tr.t('enforcement.pages.trustTitle'));
                const patch = changedOnly({ trustCardEnabled: enabled }, current(ctx));
                if (!Object.keys(patch).length) return nothing(ctx);
                const result = await saveRegistry(ctx, patch, 'enforcement');
                return { ...result, message: tr.t(enabled ? 'enforcement.result.trustOn' : 'enforcement.result.trustOff') };
            },
        },
        async channels(ctx, form) {
            const g = ctx.guild;
            const tr = textFor(ctx);
            // The Support invite is a setting of Mewvo's own servers only.
            const invite = isHomeScope(ctx) ? text(form, 'supportServerInvite', 100) : '';
            // A sent but empty invite is refused out loud (the setting needs a link), never "Nothing changed".
            if (isHomeScope(ctx) && form.supportServerInvite !== undefined && !invite) {
                throw new InputError(tr.t('enforcement.channels.inviteRequired'), 400, 'supportServerInvite');
            }
            // A field absent from the form stays unchanged (Setup step by step sends only its one field).
            const sent = (name, opts) => (form[name] !== undefined ? { [name]: channelField(g, form, name, opts) } : {});
            const patch = changedOnly({
                ...sent('modLogChannelId', { label: tr.t('enforcement.channels.modLog') }),
                ...sent('evidenceChannelId', { label: tr.t('enforcement.channels.evidence') }),
                ...sent('adminRequestChannelId', { label: tr.t('enforcement.channels.adminRequest') }),
                ...sent('appealsCategoryId', { kinds: ['category'], label: tr.t('enforcement.channels.appealsCategory') }),
                ...sent('reportsCategoryId', { kinds: ['category'], label: tr.t('enforcement.channels.reportsCategory') }),
                ...sent('modmailCategoryId', { kinds: ['category'], label: tr.t('enforcement.channels.modmailCategory') }),
                ...(form.openChannelCap !== undefined ? { openChannelCap: durationField(form, 'openChannelCap', 1, { min: 1, max: 45, label: tr.t('enforcement.channels.openCap') }) } : {}),
                ...(invite ? { supportServerInvite: invite } : {}),
            }, current(ctx));
            if (!Object.keys(patch).length) return nothing(ctx);
            return saveRegistry(ctx, patch, 'enforcement');
        },
        // Administrator only: the bot gives these roles (and denies the Muted role in every channel).
        roles: {
            admin: true,
            async run(ctx, form) {
                const g = ctx.guild;
                const tr = textFor(ctx);
                // Absent from the form: unchanged (Setup step by step sends only the Muted role).
                const warnNames = ['warnRole1', 'warnRole2', 'warnRole3'];
                const warnSent = warnNames.some((name) => form[name] !== undefined);
                const warn = warnSent ? warnNames.map((name, i) => roleField(g, form, name, { label: tr.t('enforcement.roles.warnRoleN', { number: i + 1 }) })).filter(Boolean) : null;
                const patch = changedOnly({
                    ...(form.mutedRoleId !== undefined ? { mutedRoleId: roleField(g, form, 'mutedRoleId', { label: tr.t('enforcement.roles.muted') }) } : {}),
                    ...(warnSent ? { warnRoleIds: warn } : {}),
                }, current(ctx));
                if (!Object.keys(patch).length) return nothing(ctx);
                return saveRegistry(ctx, patch, 'enforcement');
            },
        },
        async timings(ctx, form) {
            const tr = textFor(ctx);
            const patch = changedOnly({
                appealWindowMs: durationField(form, 'appealWindowDays', DAY, { min: 1, max: 365, label: tr.t('enforcement.timings.windowLabel') }),
                appealCooldownMs: durationField(form, 'appealCooldownDays', DAY, { min: 0, max: 90, label: tr.t('enforcement.timings.cooldownLabel') }),
                rejoinInviteMaxAgeSeconds: durationField(form, 'rejoinInviteHours', 3600, { min: 1, max: 168, label: tr.t('enforcement.timings.rejoinLabel') }),
                staleReportMs: durationField(form, 'staleReportDays', DAY, { min: 1, max: 90, label: tr.t('enforcement.timings.staleReportLabel') }),
                staleAppealReminderMs: durationField(form, 'staleAppealReminderDays', DAY, { min: 1, max: 90, label: tr.t('enforcement.timings.staleAppealLabel') }),
            }, current(ctx));
            if (!Object.keys(patch).length) return nothing(ctx);
            return saveRegistry(ctx, patch, 'enforcement');
        },
        // Safety settings: Administrator only.
        'appeal-review': {
            admin: true,
            async run(ctx, form) {
                const patch = changedOnly({ independentAppealReview: checkbox(form, 'independentAppealReview') }, current(ctx));
                if (!Object.keys(patch).length) return nothing(ctx);
                return saveRegistry(ctx, patch, 'enforcement');
            },
        },
        'mass-action': {
            admin: true,
            async run(ctx, form) {
                const tr = textFor(ctx);
                const patch = changedOnly({
                    massActionLimit: durationField(form, 'massActionLimit', 1, { min: 1, max: 100, label: tr.t('enforcement.mass.limit') }),
                    massMuteLimit: durationField(form, 'massMuteLimit', 1, { min: 1, max: 200, label: tr.t('enforcement.mass.muteLimit') }),
                    massActionWindowMs: durationField(form, 'massActionWindowMinutes', MINUTE, { min: 1, max: 1440, label: tr.t('enforcement.mass.window') }),
                    massActionBlockMs: durationField(form, 'massActionBlockMinutes', MINUTE, { min: 1, max: 10080, label: tr.t('enforcement.mass.block') }),
                }, current(ctx));
                if (!Object.keys(patch).length) return nothing(ctx);
                return saveRegistry(ctx, patch, 'enforcement');
            },
        },
    }),
};
