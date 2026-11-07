// enforcement.js — Enforcement & appeals: the per-server settings moved into
// guild_settings (channels, roles, appeal timings, mass-action guard, stale reports),
// plus the warn ladder, reasons and automod steps read-only (owner decision 3).

import { ENFORCEMENT_REASONS, enforcementConfig } from '../../../config/enforcement.js';
import { AUTOMOD_RULES } from '../../../config/automod.js';
import { formatDuration } from '../../enforcement/format.js';
import { html } from '../html.js';
import { InputError, PERMS, boolField, channelField, channelPicker, checkbox, numberInput, postForm, roleField, rolePicker, switchInput, text, textInput, toggleForm } from '../forms.js';
import { MAX_TEMPLATES, TEMPLATE_ACTIONS, TEMPLATE_NAME_MAX, cleanTemplates, templateLabel } from '../../enforcement/templateService.js';
import { DAY, MINUTE, changedOnly, durationField, registryValue, saveRegistry, section, table, topic, NOTHING } from './common.js';

const KEYS = [
    'adminRequestChannelId', 'modLogChannelId', 'evidenceChannelId', 'appealsCategoryId', 'reportsCategoryId', 'modmailCategoryId',
    'openChannelCap', 'mutedRoleId', 'warnRoleIds',
    'supportServerInvite', 'appealWindowMs', 'appealCooldownMs', 'rejoinInviteMaxAgeSeconds', 'staleReportMs',
    'staleAppealReminderMs', 'transparencyReportEnabled', 'trustCardEnabled', 'independentAppealReview', 'massActionLimit', 'massMuteLimit', 'massActionWindowMs', 'massActionBlockMs',
    'enforcementTemplates',
];

function current(ctx) {
    return Object.fromEntries(KEYS.map((key) => [key, registryValue(ctx, key)]));
}

function stepText(step) {
    if (step.type === 'warn') return 'warn';
    if (!step.durationMs) return `${step.type} (permanent)`;
    return `${step.type} ${formatDuration(step.durationMs)}`;
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
        const warn = v.warnRoleIds || [];
        const channels = postForm(ctx, 'enforcement', 'channels', html`<div class="grid">
${channelPicker(g, 'modLogChannelId', v.modLogChannelId, { label: 'Mod log channel', perms: PERMS.post, help: 'Mewvo posts one line here for every warn, mute, kick and ban. Staff alerts also go here when no other channel is set.' })}
${channelPicker(g, 'evidenceChannelId', v.evidenceChannelId, { label: 'Evidence channel', perms: PERMS.postFiles, help: 'Screenshots added to a case are saved here, so they stay even if the original message is deleted. Not set: the mod log channel.' })}
${channelPicker(g, 'adminRequestChannelId', v.adminRequestChannelId, { label: 'Admin request channel', perms: PERMS.post, help: 'Where moderators ask an administrator to do something they cannot do themselves.' })}
${channelPicker(g, 'appealsCategoryId', v.appealsCategoryId, { label: 'Appeals category', kinds: ['category'], perms: PERMS.category, help: 'A category is a folder of channels. Each mute or warn appeal gets its own channel in it. Not set: the ticket category.' })}
${channelPicker(g, 'reportsCategoryId', v.reportsCategoryId, { label: 'Staff reports category', kinds: ['category'], perms: PERMS.category, help: 'Each report about a staff member gets its own channel here. Not set: the ticket category.' })}
${channelPicker(g, 'modmailCategoryId', v.modmailCategoryId, { label: 'Modmail category', kinds: ['category'], perms: PERMS.category, help: 'When a member messages Mewvo privately and sends it to staff, the chat gets a channel here. Not set: the ticket category.' })}
${numberInput('openChannelCap', v.openChannelCap, { label: 'Most open reports and modmail', min: 1, max: 45, help: 'How many staff report and modmail channels can be open at the same time. When the limit is reached, new ones are turned away and staff get an alert. Appeals are never turned away.' })}
${textInput('supportServerInvite', v.supportServerInvite, { label: 'Support server invite', max: 100, placeholder: 'https://discord.gg/…', help: 'A link to your support server. Banned members get it so they can still appeal.' })}
</div>`);
        const roles = postForm(ctx, 'enforcement', 'roles', html`<div class="grid">
${rolePicker(g, 'mutedRoleId', v.mutedRoleId, { label: 'Muted role', help: 'The role that stops a muted member from talking. If you leave this empty, Mewvo makes one the first time someone is muted.' })}
${rolePicker(g, 'warnRole1', warn[0] || null, { label: 'Role at 1 warning' })}
${rolePicker(g, 'warnRole2', warn[1] || null, { label: 'Role at 2 warnings' })}
${rolePicker(g, 'warnRole3', warn[2] || null, { label: 'Role at 3 or more warnings' })}
</div>`);
        const timings = postForm(ctx, 'enforcement', 'timings', html`<div class="grid">
${numberInput('appealWindowDays', Math.round(v.appealWindowMs / DAY), { label: 'Time to appeal (days)', min: 1, max: 365, help: 'How long after a punishment a member can still ask for it to be lifted.' })}
${numberInput('appealCooldownDays', Math.round(v.appealCooldownMs / DAY), { label: 'Wait after a denied appeal (days)', min: 0, max: 90, help: 'If staff say no to an appeal, the member has to wait this long before appealing again. 0 means no wait.' })}
${numberInput('rejoinInviteHours', Math.round(v.rejoinInviteMaxAgeSeconds / 3600), { label: 'Rejoin link lasts (hours)', min: 1, max: 168, help: 'Kicked members and members whose appeal was accepted get a one-time invite link back. This is how long it works.' })}
${numberInput('staleReportDays', Math.round(v.staleReportMs / DAY), { label: 'Close quiet reports after (days)', min: 1, max: 90, help: 'A report channel where nobody has written for this long is closed.' })}
${numberInput('staleAppealReminderDays', Math.round(v.staleAppealReminderMs / DAY), { label: 'Remind about quiet appeals after (days)', min: 1, max: 90, help: 'If an appeal has no decision and no new messages for this long, staff get a reminder and the member is told it is still open.' })}
</div>`);
        const review = postForm(ctx, 'enforcement', 'appeal-review', switchInput('independentAppealReview', v.independentAppealReview === true, {
            label: 'A different moderator decides each appeal',
            help: 'The moderator who gave the punishment cannot accept or deny the appeal against it. Someone else on the staff has to. The bot owner can still decide in an emergency, and that is logged. Punishments Mewvo gave by itself (automatic warn bans, automod) are not affected.',
        }));
        const mass = postForm(ctx, 'enforcement', 'mass-action', html`<div class="grid">
${numberInput('massActionLimit', v.massActionLimit, { label: 'Bans and kicks allowed', min: 1, max: 100, help: 'How many one moderator can do within the time below.' })}
${numberInput('massMuteLimit', v.massMuteLimit, { label: 'Mutes allowed', min: 1, max: 200, help: 'Counted separately from bans and kicks.' })}
${numberInput('massActionWindowMinutes', Math.round(v.massActionWindowMs / MINUTE), { label: 'Within (minutes)', min: 1, max: 1440 })}
${numberInput('massActionBlockMinutes', Math.round(v.massActionBlockMs / MINUTE), { label: 'Blocked for (minutes)', min: 1, max: 10080, help: 'How long a moderator who goes over the limit cannot punish anyone.' })}
</div>`);
        const ladder = table(['Level', 'Ban length'], Object.entries(enforcementConfig.ladderBans).map(([level, ms]) => [level, ms ? formatDuration(ms) : 'permanent']));
        const templates = Array.isArray(v.enforcementTemplates) ? v.enforcementTemplates : [];
        const reasonLabel = (key) => ENFORCEMENT_REASONS.find((r) => r.key === key)?.label || key;
        const templateList = templates.length
            ? table(['Name', 'What it does', 'Reason', ''], templates.map((t, i) => [t.name, templateLabel(t), reasonLabel(t.reasonKey),
                postForm(ctx, 'enforcement', 'template-remove', html`<input type="hidden" name="index" value="${String(i)}">`, { submit: 'Remove', inline: true, danger: true, confirm: `Remove the template "${t.name}"?` })]))
            : html`<p class="muted">No templates yet.</p>`;
        const templateAdd = templates.length >= MAX_TEMPLATES ? html`<p class="muted">You have the maximum of ${MAX_TEMPLATES} templates.</p>` : postForm(ctx, 'enforcement', 'template-add', html`<div class="grid">
<label>Name<input name="name" maxlength="${TEMPLATE_NAME_MAX}" required placeholder="Spam: short mute"><span class="hint">The name staff see in the menu.</span></label>
<label>Action<select name="action">${TEMPLATE_ACTIONS.map((a) => html`<option value="${a}">${a}</option>`)}</select></label>
<label>Reason<select name="reasonKey">${ENFORCEMENT_REASONS.map((r) => html`<option value="${r.key}">${r.label}</option>`)}</select></label>
<label>Duration<input name="duration" maxlength="20" placeholder="1h, 7d, or empty"><span class="hint">How long it lasts, for example 1h (one hour) or 7d (seven days). A mute needs one. A ban with no duration is permanent. Warns and kicks ignore it.</span></label>
</div>`, { submit: 'Add template' });
        const reasons = table(['Code', 'Reason', 'Serious'], ENFORCEMENT_REASONS.map((r) => [html`<code>${r.key}</code>`, r.label, r.severe ? 'yes' : 'no']));
        const steps = table(['Rule', 'What happens (1st, 2nd, 3rd and later time)'], Object.values(AUTOMOD_RULES).map((r) => [r.label, r.steps.map(stepText).join(' → ')]));
        const appealPanels = postForm(ctx, 'enforcement', 'appeal-panels',
            channelPicker(g, 'channelId', null, { label: 'Channel for the appeal panel', perms: PERMS.post, optional: false, help: 'The appeal panel is a message with a button members press to appeal. A second panel goes to #appeals in the support server, which Mewvo creates if it does not exist.' }),
            { submit: 'Post the appeal panels', canEdit: ctx.canEdit && ctx.canAct, confirm: 'Post the appeal panels now? Earlier appeal panels in these channels are replaced.' });
        // Admin-only (like the appeal panels): it publishes numbers about the server on the website.
        const transparency = toggleForm(ctx, 'enforcement', 'transparency', v.transparencyReportEnabled === true, {
            label: 'Publish a monthly transparency report on the website', canEdit: ctx.canEdit && ctx.canAct,
            confirmOff: 'Take the transparency report off the website?',
        });
        // Admin-only too: a public summary of how this server moderates (/trust).
        const trustOn = v.trustCardEnabled === true;
        const trust = html`${toggleForm(ctx, 'enforcement', 'trust-card', trustOn, {
            label: 'Publish trust card', canEdit: ctx.canEdit && ctx.canAct,
            confirmOff: 'Take the trust card off the website?',
        })}${trustOn ? html`<p class="muted">It is public at <a href="/trust">/trust</a>.</p>` : ''}`;
        // v6: cards grouped by topic (common.js topic/section).
        const adminOnly = ctx.canAct ? '' : ' You need the Administrator permission in this server for this.';
        const where = topic('Channels and roles', 'Where Mewvo writes about punishments, and the roles it uses.', html`${section('Channels', channels, 'Logs, evidence and the categories for appeals, reports and modmail.', { size: 'wide' })}
${section('Roles', roles, 'Warning roles show how many active warnings a member has. Mewvo gives and removes them by itself.', { size: 'full' })}`);
        const appeals = topic('Appeals', 'How members ask staff to lift a punishment.', html`${section('Appeal panels', appealPanels, `Posts the appeal panel here and in the support server, and removes the old ones. You can also do this with /setappeal in Discord.${adminOnly}`)}
${section('Independent appeal review', review, 'Off by default, so any staff member who handles appeals can decide any appeal.')}
${section('Appeals and reports', timings, 'An appeal is a member asking staff to lift a punishment.', { size: 'full' })}`);
        const safety = topic('Moderator tools and safety', 'Shortcuts for moderators, and a brake if a moderator account is misused.', html`${section('Safety limit: too many bans or kicks in a short time', mass, 'Protects the server if a moderator account is misused (default: more than 5 bans or kicks in 10 minutes). A moderator who punishes too many members in a short time is stopped for a while, and the bot owner gets a private message (DM).', { size: 'full' })}
${section('Templates', html`${templateList}${templateAdd}`, 'Ready-made punishments for /enforcements, like "Spam: 1h mute". They show as a menu under the buttons. Picking one skips straight to the last step, where you confirm.', { size: 'wide' })}`);
        const pages = topic('Public pages', 'Numbers about this server on the Mewvo website. Both are off by default.', html`${section('Transparency report', transparency, ['A monthly count of warnings, mutes, kicks, bans and appeals at /transparency.', `It shows numbers only. No names, IDs, case codes, reasons or moderators. A count of 1 or 2 shows as “fewer than 3”.${adminOnly}`])}
${section('Trust card', trust, ['A summary of the last 90 days at /trust.', `How fast appeals get a first answer, how many are accepted, how many members are in good standing, and how often members fix a message themselves after automod warns them privately first. Numbers only. Counts of 1 or 2 and rates based on fewer than 3 are hidden.${adminOnly}`])}`);
        const rules = topic('How punishments add up', 'Built in. You cannot change these here yet.', html`${section('Warn ladder', html`<p class="muted">A member with no earlier ban is banned at ${enforcementConfig.warnsPerLevel} warnings. After that, each new warning bans them again, for longer each time.</p>${ladder}`, 'When warnings turn into a ban.', { size: 'normal' })}
${section('Reasons', reasons, ['The reasons moderators can pick from.', 'They cannot be changed here yet, because each case saves the code of its reason.'], { size: 'normal' })}
${section('Automod steps', steps, 'What automod does when someone breaks the same rule again.', { size: 'full' })}`);
        return html`${where}${appeals}${safety}${pages}${rules}`;
    },

    actions: {
        'appeal-panels': {
            admin: true,
            async run(ctx, form) {
                const channelId = channelField(ctx.guild, form, 'channelId', { optional: false, label: 'Channel for the appeal panel' });
                const { mainChannel, supportChannel, created } = await ctx.services.postAppealPanels(ctx.client, ctx.guild, ctx.guild.channels.cache.get(channelId), { reason: `dashboard: ${ctx.actor.username}` });
                return {
                    changes: [{ key: 'appealPanels', old: null, new: { main: mainChannel.id, support: supportChannel.id } }],
                    message: `Appeal panels posted in #${mainChannel.name} and in #${supportChannel.name} of the support server${created ? ' (created)' : ''}.`,
                };
            },
        },
        async 'template-add'(ctx, form) {
            const list = Array.isArray(current(ctx).enforcementTemplates) ? current(ctx).enforcementTemplates : [];
            let next;
            try {
                next = cleanTemplates([...list, { name: text(form, 'name', TEMPLATE_NAME_MAX + 10), action: text(form, 'action', 10), reasonKey: text(form, 'reasonKey', 40), duration: text(form, 'duration', 20) }]);
            } catch (error) {
                throw new InputError(error.userMessage || 'That template is not valid.');
            }
            const result = await saveRegistry(ctx, { enforcementTemplates: next }, 'enforcement');
            return { ...result, message: `Template "${next[next.length - 1].name}" added.` };
        },
        async 'template-remove'(ctx, form) {
            const list = Array.isArray(current(ctx).enforcementTemplates) ? current(ctx).enforcementTemplates : [];
            const index = Number.parseInt(text(form, 'index', 3), 10);
            if (!Number.isInteger(index) || !list[index]) throw new InputError('That template is gone already. Reload the page.');
            const removed = list[index];
            const result = await saveRegistry(ctx, { enforcementTemplates: list.filter((_, i) => i !== index) }, 'enforcement');
            return { ...result, message: `Template "${removed.name}" removed.` };
        },
        transparency: {
            admin: true,
            async run(ctx, form) {
                const enabled = boolField(form, 'enabled', 'Transparency report');
                const patch = changedOnly({ transparencyReportEnabled: enabled }, current(ctx));
                if (!Object.keys(patch).length) return NOTHING;
                const result = await saveRegistry(ctx, patch, 'enforcement');
                return { ...result, message: `The transparency report is ${enabled ? 'on: /transparency is public' : 'off: /transparency is gone from the website'}.` };
            },
        },
        'trust-card': {
            admin: true,
            async run(ctx, form) {
                const enabled = boolField(form, 'enabled', 'Trust card');
                const patch = changedOnly({ trustCardEnabled: enabled }, current(ctx));
                if (!Object.keys(patch).length) return NOTHING;
                const result = await saveRegistry(ctx, patch, 'enforcement');
                return { ...result, message: `The trust card is ${enabled ? 'on: /trust is public' : 'off: /trust is gone from the website'}.` };
            },
        },
        async channels(ctx, form) {
            const g = ctx.guild;
            const invite = text(form, 'supportServerInvite', 100);
            // A field absent from the form stays unchanged (Setup step by step sends only its one field).
            const sent = (name, opts) => (form[name] !== undefined ? { [name]: channelField(g, form, name, opts) } : {});
            const patch = changedOnly({
                ...sent('modLogChannelId', { label: 'Mod log channel' }),
                ...sent('evidenceChannelId', { label: 'Evidence channel' }),
                ...sent('adminRequestChannelId', { label: 'Admin request channel' }),
                ...sent('appealsCategoryId', { kinds: ['category'], label: 'Appeals category' }),
                ...sent('reportsCategoryId', { kinds: ['category'], label: 'Staff reports category' }),
                ...sent('modmailCategoryId', { kinds: ['category'], label: 'Modmail category' }),
                ...(form.openChannelCap !== undefined ? { openChannelCap: durationField(form, 'openChannelCap', 1, { min: 1, max: 45, label: 'Most open reports and modmail' }) } : {}),
                ...(invite ? { supportServerInvite: invite } : {}),
            }, current(ctx));
            if (!Object.keys(patch).length) return NOTHING;
            return saveRegistry(ctx, patch, 'enforcement');
        },
        async roles(ctx, form) {
            const g = ctx.guild;
            // Absent from the form: unchanged (Setup step by step sends only the Muted role).
            const warnNames = ['warnRole1', 'warnRole2', 'warnRole3'];
            const warnSent = warnNames.some((name) => form[name] !== undefined);
            const warn = warnSent ? warnNames.map((name, i) => roleField(g, form, name, { label: `Warning role ${i + 1}` })).filter(Boolean) : null;
            const patch = changedOnly({
                ...(form.mutedRoleId !== undefined ? { mutedRoleId: roleField(g, form, 'mutedRoleId', { label: 'Muted role' }) } : {}),
                ...(warnSent ? { warnRoleIds: warn } : {}),
            }, current(ctx));
            if (!Object.keys(patch).length) return NOTHING;
            return saveRegistry(ctx, patch, 'enforcement');
        },
        async timings(ctx, form) {
            const patch = changedOnly({
                appealWindowMs: durationField(form, 'appealWindowDays', DAY, { min: 1, max: 365, label: 'Time to appeal' }),
                appealCooldownMs: durationField(form, 'appealCooldownDays', DAY, { min: 0, max: 90, label: 'Wait after a denied appeal' }),
                rejoinInviteMaxAgeSeconds: durationField(form, 'rejoinInviteHours', 3600, { min: 1, max: 168, label: 'Rejoin link lasts' }),
                staleReportMs: durationField(form, 'staleReportDays', DAY, { min: 1, max: 90, label: 'Close quiet reports after' }),
                staleAppealReminderMs: durationField(form, 'staleAppealReminderDays', DAY, { min: 1, max: 90, label: 'Remind about quiet appeals after' }),
            }, current(ctx));
            if (!Object.keys(patch).length) return NOTHING;
            return saveRegistry(ctx, patch, 'enforcement');
        },
        async 'appeal-review'(ctx, form) {
            const patch = changedOnly({ independentAppealReview: checkbox(form, 'independentAppealReview') }, current(ctx));
            if (!Object.keys(patch).length) return NOTHING;
            return saveRegistry(ctx, patch, 'enforcement');
        },
        async 'mass-action'(ctx, form) {
            const patch = changedOnly({
                massActionLimit: durationField(form, 'massActionLimit', 1, { min: 1, max: 100, label: 'Bans and kicks allowed' }),
                massMuteLimit: durationField(form, 'massMuteLimit', 1, { min: 1, max: 200, label: 'Mutes allowed' }),
                massActionWindowMs: durationField(form, 'massActionWindowMinutes', MINUTE, { min: 1, max: 1440, label: 'Within (minutes)' }),
                massActionBlockMs: durationField(form, 'massActionBlockMinutes', MINUTE, { min: 1, max: 10080, label: 'Blocked for (minutes)' }),
            }, current(ctx));
            if (!Object.keys(patch).length) return NOTHING;
            return saveRegistry(ctx, patch, 'enforcement');
        },
    },
};
