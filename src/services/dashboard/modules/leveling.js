// leveling.js — Leveling: on/off, XP per message and cooldown, level-up messages,
// ignored channels/roles, role rewards, and (Administrators only) a member's level.
// Writes go through services/leveling/leveling.js (updateLevelingConfig /
// setLevelRoleReward are row-locked; addLevels/removeLevels/setUserLevel are the
// /level add|remove|set functions). The server cat's name and growth announcement are
// registry settings (catName, catAnnounce; saved by the settings service, which audits them).

import { html } from '../html.js';
import {
    InputError, PERMS, autoRoleField, boolField, buttonForm, channelField, channelName, channelPicker, checkbox,
    switchInput, choiceField, intField, numberInput, postForm, rolePicker, roleName, roleWarnings, selectInput,
    text, textArea, textInput, toggleForm, userIdField,
} from '../forms.js';
import { diffSnapshots } from '../audit.js';
import { NOTHING, changedOnly, registryValue, saveRegistry, section, table } from './common.js';
import { CAT_NAME_MAX, sanitizeCatName } from '../../community/catModel.js';

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
    help: 'Members earn points (XP) for chatting and go up in level as they collect more. You can post a message when someone levels up and give roles at certain levels. You can also change these with /level dashboard in Discord.',

    async load(ctx) {
        // The cat is extra: a failed read only shows a note in its section.
        const cat = await Promise.resolve().then(() => ctx.services.getServerCat(ctx.guildId)).catch(() => null);
        return { cfg: await ctx.services.getLevelingConfig(ctx.client, ctx.guildId), cat };
    },

    render(ctx, { cfg, cat }) {
        const g = ctx.guild;
        const range = xpRangeOf(cfg);
        const settings = postForm(ctx, 'leveling', 'settings', html`<div class="grid">
${numberInput('xpMin', range.min, { label: 'Least XP per message', min: 1, max: 500, help: 'Each message gives a random amount of XP between these two numbers.' })}
${numberInput('xpMax', range.max, { label: 'Most XP per message', min: 1, max: 500 })}
${numberInput('xpCooldown', cfg.xpCooldown ?? 60, { label: 'Wait between XP', min: 0, max: 3600, help: 'A member gets XP for one message at most this often, so spamming does not level them up faster. In seconds.' })}
${channelPicker(g, 'levelUpChannel', cfg.levelUpChannel || null, { label: 'Level-up channel', perms: PERMS.post, noneLabel: 'where the member chatted', help: 'Where the level-up message is posted.' })}
${switchInput('announceLevelUp', cfg.announceLevelUp !== false, { label: 'Announce level-ups', help: 'Off: members still level up, but no message is posted.' })}
${textArea('levelUpMessage', cfg.levelUpMessage || '{user} is now level {level}.', { label: 'Level-up message', max: 500, rows: 2, help: 'You can use {user} (mentions the member) and {level} (their new level).' })}</div>`);
        const ignoredRows = [
            ...(cfg.ignoredChannels || []).map((id) => ['channel', channelName(g, id), buttonForm(ctx, 'leveling', 'ignore-remove', 'Remove', { type: 'channel', id })]),
            ...(cfg.ignoredRoles || []).map((id) => ['role', roleName(g, id), buttonForm(ctx, 'leveling', 'ignore-remove', 'Remove', { type: 'role', id })]),
        ];
        const ignored = html`${table(['Type', 'No XP for', ''], ignoredRows, 'Members earn XP in every channel.')}
<div class="grid">${postForm(ctx, 'leveling', 'ignore-add', html`<input type="hidden" name="type" value="channel">${channelPicker(g, 'id', null, { label: 'No XP in this channel', perms: [], optional: false })}`, { submit: 'Add', inline: true })}
${postForm(ctx, 'leveling', 'ignore-add', html`<input type="hidden" name="type" value="role">${rolePicker(g, 'id', null, { label: 'No XP for this role', optional: false, assign: false })}`, { submit: 'Add', inline: true })}</div>`;
        const rewards = Object.entries(cfg.roleRewards || {}).sort((a, b) => Number(a[0]) - Number(b[0]));
        const rewardTable = html`${table(['Level', 'Role', 'Problems', ''], rewards.map(([level, roleId]) => [level, roleName(g, roleId),
            roleWarnings(g, roleId, { autoAssign: true }).join('; ') || html`<span class="ok">ok</span>`,
            buttonForm(ctx, 'leveling', 'reward-remove', 'Remove', { level })]), 'No role rewards.')}
${postForm(ctx, 'leveling', 'reward-add', html`<div class="grid">${numberInput('level', '', { label: 'At level', min: 1, max: MAX_LEVEL })}
${rolePicker(g, 'roleId', null, { label: 'Give this role', optional: false, autoAssign: true })}</div>`, { submit: 'Add reward' })}`;
        const members = ctx.canAct
            ? postForm(ctx, 'leveling', 'member', html`<div class="grid">${html`<label>Member (user ID)<input name="userId" inputmode="numeric" maxlength="20"><span class="hint">The long number that identifies a member. In Discord, turn on Developer Mode, right-click the member and pick Copy User ID.</span></label>`}
${selectInput('op', 'add', [['add', 'Add levels'], ['remove', 'Remove levels'], ['set', 'Set level']], { label: 'What to do' })}
${numberInput('levels', '', { label: 'Levels', min: 0, max: MAX_LEVEL })}</div>`, { submit: 'Apply', canEdit: ctx.canEdit && ctx.canAct })
            : html`<p class="muted">To change a member's level you need the Administrator permission in the main server.</p>`;
        const catEdit = ctx.canEdit && ctx.canAct;
        const catNow = cat
            ? html`<div class="cat-now"><img src="/img/cat/${cat.image}" width="96" height="96" alt="${cat.name}, a ${cat.stage.name.toLowerCase()}, looking ${cat.mood}"><p>${cat.sentence} Stage: ${cat.stage.name}. ${Number(cat.total).toLocaleString('en-US')} messages counted.</p></div>`
            : html`<p class="muted">The cat could not be loaded right now (the database is not responding). Reload to try again.</p>`;
        const catName = postForm(ctx, 'leveling', 'cat-name', textInput('catName', registryValue(ctx, 'catName'), {
            label: 'Name', max: CAT_NAME_MAX, help: 'Letters, numbers and spaces. Other characters are left out.',
        }), { submit: 'Save name', canEdit: catEdit });
        const catAnnounce = toggleForm(ctx, 'leveling', 'cat-announce', registryValue(ctx, 'catAnnounce') !== false, {
            label: 'Post in the level-up channel when the cat grows', canEdit: catEdit,
        });
        const catPart = html`${catNow}${catName}${catAnnounce}${ctx.canAct ? '' : html`<p class="muted">You need the Administrator permission in the main server to change the cat.</p>`}`;
        // The on/off switch is in the page header (pages.js moduleSettingsPage).
        return html`${section('XP and messages', settings)}${section('No XP in', ignored, 'Members get no XP in these channels, and members with these roles get none at all. Useful for bot or spam channels.')}
${section('Role rewards', rewardTable, 'Members get these roles by themselves when they reach the level. Mewvo can only give roles below its own role in the role list, and it will not give roles with staff powers.')}
${section('Member levels', members, 'Change one member\'s level by hand. You can also do this with /level add, /level remove and /level set in Discord.')}
${section('Server cat', catPart, 'The server has a cat that grows as members chat, from Kitten to Legend. Members see it with /cat view and on the website leaderboard. When it grows, Mewvo posts once in the level-up channel (if one is set).')}`;
    },

    actions: {
        'cat-name': {
            admin: true,
            async run(ctx, form) {
                const name = sanitizeCatName(text(form, 'catName', CAT_NAME_MAX));
                if (!name) throw new InputError('Name: use letters, numbers and spaces.', 400, 'catName');
                const patch = changedOnly({ catName: name }, { catName: registryValue(ctx, 'catName') });
                if (!Object.keys(patch).length) return NOTHING;
                const result = await saveRegistry(ctx, patch, 'leveling');
                return { ...result, message: `The server cat is now called ${name}.` };
            },
        },
        'cat-announce': {
            admin: true,
            async run(ctx, form) {
                const enabled = boolField(form, 'enabled', 'Cat growth announcement');
                const patch = changedOnly({ catAnnounce: enabled }, { catAnnounce: registryValue(ctx, 'catAnnounce') !== false });
                if (!Object.keys(patch).length) return NOTHING;
                const result = await saveRegistry(ctx, patch, 'leveling');
                return { ...result, message: `Cat growth posts are ${enabled ? 'on' : 'off'}.` };
            },
        },
        async enabled(ctx, form) {
            const enabled = boolField(form, 'enabled', 'Leveling');
            return update(ctx, { enabled }, `Leveling is now ${enabled ? 'on' : 'off'}.`);
        },
        async settings(ctx, form) {
            const cfg = await ctx.services.getLevelingConfig(ctx.client, ctx.guildId);
            const min = intField(form, 'xpMin', { min: 1, max: 500, label: 'Least XP per message' });
            const max = intField(form, 'xpMax', { min: 1, max: 500, label: 'Most XP per message' });
            if (min > max) throw new InputError('Least XP per message cannot be more than Most XP per message.');
            const range = xpRangeOf(cfg);
            const patch = changedOnly({
                xpCooldown: intField(form, 'xpCooldown', { min: 0, max: 3600, label: 'Wait between XP' }),
                levelUpChannel: channelField(ctx.guild, form, 'levelUpChannel', { label: 'Level-up channel' }),
                announceLevelUp: checkbox(form, 'announceLevelUp'),
                levelUpMessage: text(form, 'levelUpMessage', 500) || cfg.levelUpMessage || '{user} is now level {level}.',
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
