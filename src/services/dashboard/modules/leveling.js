// leveling.js — Leveling: on/off, XP per message and cooldown, level-up messages,
// ignored channels/roles, role rewards, and (Administrators only) a member's level.
// Writes go through services/leveling/leveling.js (updateLevelingConfig /
// setLevelRoleReward are row-locked; addLevels/removeLevels/setUserLevel are the
// /level add|remove|set functions).

import { html } from '../html.js';
import {
    InputError, PERMS, autoRoleField, boolField, buttonForm, channelField, channelName, channelPicker, checkbox,
    switchInput, choiceField, intField, numberInput, postForm, rolePicker, roleName, roleWarnings, selectInput,
    text, textArea, userIdField,
} from '../forms.js';
import { diffSnapshots } from '../audit.js';
import { NOTHING, changedOnly, section, table } from './common.js';

const MAX_LEVEL = 1000;

const xpRangeOf = (cfg) => ({
    min: cfg.xpRange?.min ?? cfg.xpPerMessage?.min ?? 15,
    max: cfg.xpRange?.max ?? cfg.xpPerMessage?.max ?? 25,
});

async function update(ctx, patch, message) {
    if (!Object.keys(patch).length) return NOTHING;
    const { before, after } = await ctx.services.updateLevelingConfig(ctx.client, ctx.guildId, patch);
    const changes = diffSnapshots(before, after, Object.keys(patch), 'leveling.');
    return { changes, message: changes.length ? message : 'Nothing changed.' };
}

export default {
    key: 'leveling',
    label: 'Leveling',
    state: 'leveling',
    help: 'XP for chatting, level-up messages and role rewards. Same settings as /level dashboard. Placeholders in the message: {user}, {level}.',

    async load(ctx) {
        return { cfg: await ctx.services.getLevelingConfig(ctx.client, ctx.guildId) };
    },

    render(ctx, { cfg }) {
        const g = ctx.guild;
        const range = xpRangeOf(cfg);
        const settings = postForm(ctx, 'leveling', 'settings', html`<div class="grid">
${numberInput('xpMin', range.min, { label: 'XP per message: minimum', min: 1, max: 500 })}
${numberInput('xpMax', range.max, { label: 'XP per message: maximum', min: 1, max: 500 })}
${numberInput('xpCooldown', cfg.xpCooldown ?? 60, { label: 'Seconds between XP grants', min: 0, max: 3600 })}
${channelPicker(g, 'levelUpChannel', cfg.levelUpChannel || null, { label: 'Level-up channel', perms: PERMS.post, noneLabel: 'where the member chatted' })}
${switchInput('announceLevelUp', cfg.announceLevelUp !== false, { label: 'Announce level-ups' })}
${textArea('levelUpMessage', cfg.levelUpMessage || '{user} has leveled up to level {level}!', { label: 'Level-up message', max: 500, rows: 2 })}</div>`);
        const ignoredRows = [
            ...(cfg.ignoredChannels || []).map((id) => ['channel', channelName(g, id), buttonForm(ctx, 'leveling', 'ignore-remove', 'Remove', { type: 'channel', id })]),
            ...(cfg.ignoredRoles || []).map((id) => ['role', roleName(g, id), buttonForm(ctx, 'leveling', 'ignore-remove', 'Remove', { type: 'role', id })]),
        ];
        const ignored = html`${table(['Type', 'No XP for', ''], ignoredRows, 'XP is earned everywhere.')}
<div class="grid">${postForm(ctx, 'leveling', 'ignore-add', html`<input type="hidden" name="type" value="channel">${channelPicker(g, 'id', null, { label: 'Channel', perms: [], optional: false })}`, { submit: 'Add', inline: true })}
${postForm(ctx, 'leveling', 'ignore-add', html`<input type="hidden" name="type" value="role">${rolePicker(g, 'id', null, { label: 'Role', optional: false, assign: false })}`, { submit: 'Add', inline: true })}</div>`;
        const rewards = Object.entries(cfg.roleRewards || {}).sort((a, b) => Number(a[0]) - Number(b[0]));
        const rewardTable = html`${table(['Level', 'Role', 'Problems', ''], rewards.map(([level, roleId]) => [level, roleName(g, roleId),
            roleWarnings(g, roleId, { autoAssign: true }).join('; ') || html`<span class="ok">ok</span>`,
            buttonForm(ctx, 'leveling', 'reward-remove', 'Remove', { level })]), 'No role rewards.')}
${postForm(ctx, 'leveling', 'reward-add', html`<div class="grid">${numberInput('level', '', { label: 'Level', min: 1, max: MAX_LEVEL })}
${rolePicker(g, 'roleId', null, { label: 'Role', optional: false, autoAssign: true })}</div>`, { submit: 'Add reward' })}`;
        const members = ctx.canAct
            ? postForm(ctx, 'leveling', 'member', html`<div class="grid">${html`<label>Member ID<input name="userId" inputmode="numeric" maxlength="20"></label>`}
${selectInput('op', 'add', [['add', 'Add levels'], ['remove', 'Remove levels'], ['set', 'Set level']], { label: 'Action' })}
${numberInput('levels', '', { label: 'Levels', min: 0, max: MAX_LEVEL })}</div>`, { submit: 'Apply', canEdit: ctx.canEdit && ctx.canAct })
            : html`<p class="muted">Changing a member's level needs Administrator in the main server.</p>`;
        // The on/off switch is in the page header (pages.js moduleSettingsPage).
        return html`${section('XP and messages', settings)}${section('No XP in', ignored)}
${section('Role rewards', rewardTable, 'Roles with staff permissions or above my highest role are refused (same rule as /level dashboard).')}
${section('Member levels', members, 'Same as /level add, /level remove and /level set.')}`;
    },

    actions: {
        async enabled(ctx, form) {
            const enabled = boolField(form, 'enabled', 'Leveling');
            return update(ctx, { enabled }, `Leveling is now ${enabled ? 'on' : 'off'}.`);
        },
        async settings(ctx, form) {
            const cfg = await ctx.services.getLevelingConfig(ctx.client, ctx.guildId);
            const min = intField(form, 'xpMin', { min: 1, max: 500, label: 'Minimum XP' });
            const max = intField(form, 'xpMax', { min: 1, max: 500, label: 'Maximum XP' });
            if (min > max) throw new InputError('Minimum XP must be less than or equal to maximum XP.');
            const range = xpRangeOf(cfg);
            const patch = changedOnly({
                xpCooldown: intField(form, 'xpCooldown', { min: 0, max: 3600, label: 'Cooldown' }),
                levelUpChannel: channelField(ctx.guild, form, 'levelUpChannel', { label: 'Level-up channel' }),
                announceLevelUp: checkbox(form, 'announceLevelUp'),
                levelUpMessage: text(form, 'levelUpMessage', 500) || cfg.levelUpMessage || '{user} has leveled up to level {level}!',
            }, { ...cfg, xpCooldown: cfg.xpCooldown ?? 60, announceLevelUp: cfg.announceLevelUp !== false, levelUpChannel: cfg.levelUpChannel || null });
            if (min !== range.min || max !== range.max) patch.xpRange = { min, max };
            return update(ctx, patch, 'Leveling settings saved.');
        },
        async 'ignore-add'(ctx, form) {
            const type = choiceField(form, 'type', ['channel', 'role'], 'Type');
            const cfg = await ctx.services.getLevelingConfig(ctx.client, ctx.guildId);
            const field = type === 'channel' ? 'ignoredChannels' : 'ignoredRoles';
            const id = type === 'channel'
                ? channelField(ctx.guild, form, 'id', { optional: false, kinds: ['text', 'voice', 'forum'], label: 'Channel' })
                : text(form, 'id', 25);
            if (type === 'role' && !ctx.guild?.roles?.cache?.get(id)) throw new InputError('Role: that role is not in the server.');
            const list = cfg[field] || [];
            if (list.includes(id)) return { changes: [], message: 'Already on the list.' };
            return update(ctx, { [field]: [...list, id] }, 'No XP there from now on.');
        },
        async 'ignore-remove'(ctx, form) {
            const type = choiceField(form, 'type', ['channel', 'role'], 'Type');
            const id = text(form, 'id', 25);
            const cfg = await ctx.services.getLevelingConfig(ctx.client, ctx.guildId);
            const field = type === 'channel' ? 'ignoredChannels' : 'ignoredRoles';
            const list = cfg[field] || [];
            if (!list.includes(id)) return { changes: [], message: 'It was not on the list.' };
            return update(ctx, { [field]: list.filter((x) => x !== id) }, 'Removed.');
        },
        async 'reward-add'(ctx, form) {
            const level = intField(form, 'level', { min: 1, max: MAX_LEVEL, label: 'Level' });
            const roleId = autoRoleField(ctx.guild, form, 'roleId', { optional: false, label: 'Reward role' });
            const { before, after } = await ctx.services.setLevelRoleReward(ctx.client, ctx.guildId, level, roleId);
            const changes = diffSnapshots(before?.roleRewards || {}, after?.roleRewards || {}, null, 'leveling.roleRewards.');
            return { changes, message: `Level ${level} now gives that role.` };
        },
        async 'reward-remove'(ctx, form) {
            const level = intField(form, 'level', { min: 1, max: MAX_LEVEL, label: 'Level' });
            const { before, after } = await ctx.services.setLevelRoleReward(ctx.client, ctx.guildId, level, null);
            const changes = diffSnapshots(before?.roleRewards || {}, after?.roleRewards || {}, null, 'leveling.roleRewards.');
            return { changes, message: changes.length ? `Removed the level ${level} reward.` : 'There was no reward for that level.' };
        },
        member: {
            admin: true,
            async run(ctx, form) {
                const userId = userIdField(form, 'userId', 'Member ID');
                const op = choiceField(form, 'op', ['add', 'remove', 'set'], 'Action');
                const levels = intField(form, 'levels', { min: op === 'set' ? 0 : 1, max: MAX_LEVEL, label: 'Levels' });
                const member = await ctx.guild?.members?.fetch?.(userId).catch(() => null);
                if (!member) throw new InputError('That member is not in the server.');
                const before = await ctx.services.getUserLevelData(ctx.client, ctx.guildId, userId);
                if (op === 'add') await ctx.services.addLevels(ctx.client, ctx.guildId, userId, levels);
                else if (op === 'remove') await ctx.services.removeLevels(ctx.client, ctx.guildId, userId, levels);
                else await ctx.services.setUserLevel(ctx.client, ctx.guildId, userId, levels);
                const after = await ctx.services.getUserLevelData(ctx.client, ctx.guildId, userId);
                return {
                    changes: [{ key: `member.${userId}.level`, old: before.level, new: after.level }],
                    message: `${member.user?.username || userId} is now level ${after.level}.`,
                };
            },
        },
    },
};
