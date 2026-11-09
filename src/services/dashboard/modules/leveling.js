// leveling.js — Leveling: on/off, XP per message and cooldown, level-up messages,
// ignored channels/roles, XP boosts (channel and role multipliers), role rewards and the
// reward mode, Voice XP (on/off, XP per minute, daily cap, people needed, self-mute, excluded
// channels: updateVoiceXpConfig, row-locked), and (Administrators only) a member's level (reward roles re-synced after).
// Writes go through services/leveling/leveling.js (updateLevelingConfig /
// setLevelRoleReward are row-locked; addLevels/removeLevels/setUserLevel are the
// /level add|remove|set functions). The server cat's name and growth announcement are
// registry settings (catName, catAnnounce; saved by the settings service, which audits them).

import { html } from '../html.js';
import {
    InputError, PERMS, autoRoleField, boolField, buttonForm, channelField, channelName, channelPicker, checkbox, decimalField, roleField,
    switchInput, choiceField, intField, numberInput, postForm, rolePicker, roleName, roleWarnings, selectInput,
    isSnowflake, list, text, textArea, textInput, toggleForm, userIdField,
} from '../forms.js';
import { diffSnapshots } from '../audit.js';
import { NOTHING, changedOnly, registryValue, saveRegistry, section, table, topic } from './common.js';
import { CAT_NAME_MAX, sanitizeCatName } from '../../community/catModel.js';
import { BOOST_MAX, BOOST_MIN, MAX_BOOSTS, TOTAL_MULTIPLIER_CAP, rewardModeOf } from '../../leveling/levelBoosts.js';
import { roleSyncNote } from '../../leveling/levelRoleSyncService.js';
import { logger } from '../../../utils/logger.js';
import { EMBED_COLOURS, colourFromKey, parseHexColour } from '../../botMessageService.js';
import { cardAccentOf } from '../../leveling/levelCard.js';
import { textFor } from '../language.js';
import { managerActions } from './serverScope.js';
import {
    VOICE_CAP_MAX, VOICE_MAX_EXCLUDED, VOICE_MIN_HUMANS_MAX, VOICE_MIN_HUMANS_MIN, VOICE_XP_MAX, voiceConfigOf,
} from '../../leveling/voiceConfig.js';

// Words: src/content/dashboard/<lang>/leveling.json. The cat's sentence, stage and mood come from
// community/catModel.js and the role-sync note from leveling/levelRoleSyncService.js (English).
// The default level-up message is stored config posted in Discord and stays as it is.

const MAX_LEVEL = 1000;
/** Audit keys: "leveling.<config key>" (not catalog keys). */
const AUDIT = 'leveling.';

const BOOST_FIELD = { channel: 'channelMultipliers', role: 'roleMultipliers' };
const REWARD_MODES = ['keep', 'highest'];
const boostText = (value) => `x${Number(value).toFixed(1)}`;
const hexOf = (value) => `#${value.toString(16).padStart(6, '0').toUpperCase()}`;

/** The card colour from the form: a typed colour code wins, else one of the fixed choices. */
function cardAccentFromForm(form, tr) {
    const hex = text(form, 'hex', 7);
    if (hex) {
        const value = parseHexColour(hex);
        if (value === null) throw new InputError(tr.t('leveling.error.cardHex'), 400, 'hex');
        return hexOf(value);
    }
    const value = colourFromKey(text(form, 'colour', 20) || 'primary');
    if (value === null) throw new InputError(tr.t('leveling.error.cardColour'), 400, 'colour');
    return hexOf(value);
}

const xpRangeOf = (cfg) => ({
    min: cfg.xpRange?.min ?? cfg.xpPerMessage?.min ?? 15,
    max: cfg.xpRange?.max ?? cfg.xpPerMessage?.max ?? 25,
});

/** The default level-up message in the page language; {user} and {level} stay placeholders. */
const defaultLevelUpMessage = (tr) => tr.t('leveling.xp.defaultMessage', { user: '{user}', level: '{level}' });

/** One no-XP list change (leveling.js updateLevelIgnoreList); `unchanged` when it was already so. */
async function ignoreChange(ctx, field, action, id, message, unchanged) {
    const { before, after, changed } = await ctx.services.updateLevelIgnoreList(ctx.client, ctx.guildId, field, action, id);
    if (!changed) return { changes: [], message: unchanged };
    return { changes: diffSnapshots(before, after, [field], AUDIT), message };
}

/** The Voice XP card: one form with every voice setting. */
function voiceForm(ctx, cfg, tr) {
    const voice = voiceConfigOf(cfg);
    return postForm(ctx, 'leveling', 'voice', html`${switchInput('voiceEnabled', voice.enabled, { label: tr.t('leveling.voice.enabled'), help: tr.t('leveling.voice.enabledHelp') })}
<div class="grid">${numberInput('voiceXpMin', voice.xpMin, { label: tr.t('leveling.voice.xpMin'), min: 1, max: VOICE_XP_MAX, help: tr.t('leveling.voice.xpMinHelp') })}
${numberInput('voiceXpMax', voice.xpMax, { label: tr.t('leveling.voice.xpMax'), min: 1, max: VOICE_XP_MAX })}
${numberInput('voiceCap', voice.dailyCapMinutes, { label: tr.t('leveling.voice.cap'), min: 0, max: VOICE_CAP_MAX, help: tr.t('leveling.voice.capHelp') })}
${numberInput('voiceMinHumans', voice.minHumans, { label: tr.t('leveling.voice.minHumans'), min: VOICE_MIN_HUMANS_MIN, max: VOICE_MIN_HUMANS_MAX, help: tr.t('leveling.voice.minHumansHelp') })}</div>
${switchInput('voiceRequireUnmuted', voice.requireUnmuted, { label: tr.t('leveling.voice.requireUnmuted'), help: tr.t('leveling.voice.requireUnmutedHelp') })}
${channelPicker(ctx.guild, 'voiceExcluded', voice.excludedChannels, { label: tr.t('leveling.voice.excluded'), kinds: ['voice'], perms: [], multiple: true, help: tr.t('leveling.voice.excludedHelp') })}`);
}

/**
 * The excluded voice channels from the form: each must be a voice or stage channel of the
 * server; one that is already stored but was deleted in Discord may stay (it is shown as missing).
 */
function excludedFromForm(ctx, form, stored, tr) {
    const label = tr.t('leveling.voice.excluded');
    return list(form, 'voiceExcluded', { max: VOICE_MAX_EXCLUDED }).map((id) => (stored.includes(id) && !ctx.guild?.channels?.cache?.get(id)
        ? id
        : channelField(ctx.guild, { voiceExcluded: id }, 'voiceExcluded', { kinds: ['voice'], optional: false, label })));
}

async function update(ctx, patch, message) {
    if (!Object.keys(patch).length) return NOTHING;
    const { before, after } = await ctx.services.updateLevelingConfig(ctx.client, ctx.guildId, patch);
    const changes = diffSnapshots(before, after, Object.keys(patch), AUDIT);
    return { changes, message: changes.length ? message : textFor(ctx).t('leveling.action.nothing') };
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
        const tr = textFor(ctx);
        const g = ctx.guild;
        const range = xpRangeOf(cfg);
        const typeName = (type) => tr.t(type === 'channel' ? 'leveling.type.channel' : 'leveling.type.role');
        const settings = postForm(ctx, 'leveling', 'settings', html`<div class="grid">
${numberInput('xpMin', range.min, { label: tr.t('leveling.xp.min'), min: 1, max: 500, help: tr.t('leveling.xp.minHelp') })}
${numberInput('xpMax', range.max, { label: tr.t('leveling.xp.max'), min: 1, max: 500 })}
${numberInput('xpCooldown', cfg.xpCooldown ?? 60, { label: tr.t('leveling.xp.cooldown'), min: 0, max: 3600, help: tr.t('leveling.xp.cooldownHelp') })}
${channelPicker(g, 'levelUpChannel', cfg.levelUpChannel || null, { label: tr.t('leveling.xp.channel'), perms: PERMS.post, noneLabel: tr.t('leveling.xp.channelNone'), help: tr.t('leveling.xp.channelHelp') })}
${switchInput('announceLevelUp', cfg.announceLevelUp !== false, { label: tr.t('leveling.xp.announce'), help: tr.t('leveling.xp.announceHelp') })}
${textArea('levelUpMessage', cfg.levelUpMessage || defaultLevelUpMessage(tr), { label: tr.t('leveling.xp.message'), max: 500, rows: 2, help: tr.t('leveling.xp.messageHelp', { user: '{user}', level: '{level}' }) })}</div>`);
        const accent = cardAccentOf(cfg.cardAccent);
        const knownAccent = EMBED_COLOURS.find(([, , h]) => h.toUpperCase() === accent);
        const colourLabel = (key, label) => (tr.has(`leveling.colours.${key}`) ? tr.t(`leveling.colours.${key}`) : label);
        const card = postForm(ctx, 'leveling', 'card', html`${switchInput('levelUpCard', cfg.levelUpCard === true, { label: tr.t('leveling.card.toggle'), help: tr.t('leveling.card.toggleHelp') })}
<div class="grid">${selectInput('colour', knownAccent ? knownAccent[0] : 'primary', EMBED_COLOURS.map(([key, label, h]) => [key, `${colourLabel(key, label)} (${h})`]), { label: tr.t('leveling.card.colour'), help: tr.t('leveling.card.colourHelp') })}
${textInput('hex', knownAccent ? '' : accent, { label: tr.t('leveling.card.hex'), max: 7, placeholder: '#9B59B6', help: tr.t('leveling.card.hexHelp') })}</div>`);
        const remove = tr.t('leveling.remove');
        const add = tr.t('leveling.add');
        const ignoredRows = [
            ...(cfg.ignoredChannels || []).map((id) => [typeName('channel'), channelName(g, id), buttonForm(ctx, 'leveling', 'ignore-remove', remove, { type: 'channel', id })]),
            ...(cfg.ignoredRoles || []).map((id) => [typeName('role'), roleName(g, id), buttonForm(ctx, 'leveling', 'ignore-remove', remove, { type: 'role', id })]),
        ];
        const ignored = html`${table([tr.t('leveling.ignored.type'), tr.t('leveling.ignored.noXpFor'), ''], ignoredRows, tr.t('leveling.ignored.empty'))}
<div class="grid">${postForm(ctx, 'leveling', 'ignore-add', html`<input type="hidden" name="type" value="channel">${channelPicker(g, 'id', null, { label: tr.t('leveling.ignored.addChannel'), perms: [], optional: false })}`, { submit: add, inline: true })}
${postForm(ctx, 'leveling', 'ignore-add', html`<input type="hidden" name="type" value="role">${rolePicker(g, 'id', null, { label: tr.t('leveling.ignored.addRole'), optional: false, assign: false })}`, { submit: add, inline: true })}</div>`;
        const boostRows = [
            ...Object.entries(cfg.channelMultipliers || {}).map(([id, value]) => [typeName('channel'), channelName(g, id), boostText(value), buttonForm(ctx, 'leveling', 'boost-remove', remove, { type: 'channel', id })]),
            ...Object.entries(cfg.roleMultipliers || {}).map(([id, value]) => [typeName('role'), roleName(g, id), boostText(value), buttonForm(ctx, 'leveling', 'boost-remove', remove, { type: 'role', id })]),
        ];
        const boostRange = { min: tr.fmtNumber(BOOST_MIN), max: tr.fmtNumber(BOOST_MAX) };
        const boostInput = numberInput('multiplier', '', { label: tr.t('leveling.boosts.boost'), min: BOOST_MIN, max: BOOST_MAX, step: 0.1, help: tr.t('leveling.boosts.boostHelp', { ...boostRange, example: tr.fmtNumber(1.5) }) });
        const boosts = html`${table([tr.t('leveling.ignored.type'), tr.t('leveling.boosts.boosted'), tr.t('leveling.boosts.boost'), ''], boostRows, tr.t('leveling.boosts.empty'))}
<div class="grid">${postForm(ctx, 'leveling', 'boost-add', html`<input type="hidden" name="type" value="channel">${channelPicker(g, 'id', null, { label: tr.t('leveling.boosts.channel'), kinds: ['text', 'voice', 'forum'], perms: [], optional: false })}${boostInput}`, { submit: tr.t('leveling.boosts.addChannel') })}
${postForm(ctx, 'leveling', 'boost-add', html`<input type="hidden" name="type" value="role">${rolePicker(g, 'id', null, { label: tr.t('leveling.boosts.role'), optional: false, assign: false, includeManaged: true })}${boostInput}`, { submit: tr.t('leveling.boosts.addRole') })}</div>`;
        const rewards = Object.entries(cfg.roleRewards || {}).sort((a, b) => Number(a[0]) - Number(b[0]));
        const rewardTable = html`${table([tr.t('leveling.rewards.level'), tr.t('leveling.rewards.role'), tr.t('leveling.rewards.problems'), ''], rewards.map(([level, roleId]) => [level, roleName(g, roleId),
            roleWarnings(g, roleId, { autoAssign: true }).join('; ') || html`<span class="ok">${tr.t('leveling.rewards.ok')}</span>`,
            buttonForm(ctx, 'leveling', 'reward-remove', remove, { level }, { canEdit: ctx.canEdit && ctx.canAct })]), tr.t('leveling.rewards.empty'))}
${postForm(ctx, 'leveling', 'reward-add', html`<div class="grid">${numberInput('level', '', { label: tr.t('leveling.rewards.atLevel'), min: 1, max: MAX_LEVEL })}
${rolePicker(g, 'roleId', null, { label: tr.t('leveling.rewards.giveRole'), optional: false, autoAssign: true })}</div>`, { submit: tr.t('leveling.rewards.add'), canEdit: ctx.canEdit && ctx.canAct })}
${postForm(ctx, 'leveling', 'reward-mode', selectInput('rewardMode', rewardModeOf(cfg), REWARD_MODES.map((mode) => [mode, tr.t(`leveling.rewards.mode.${mode}`)]), {
            label: tr.t('leveling.rewards.modeLabel'),
            help: tr.t('leveling.rewards.modeHelp'),
        }), { submit: tr.t('leveling.rewards.modeSubmit'), reset: true, canEdit: ctx.canEdit && ctx.canAct })}`;
        const members = ctx.canAct
            ? postForm(ctx, 'leveling', 'member', html`<div class="grid">${html`<label>${tr.t('leveling.member.userId')}<input name="userId" inputmode="numeric" maxlength="20"><span class="hint">${tr.t('leveling.member.userIdHelp')}</span></label>`}
${selectInput('op', 'add', [['add', tr.t('leveling.member.op.add')], ['remove', tr.t('leveling.member.op.remove')], ['set', tr.t('leveling.member.op.set')]], { label: tr.t('leveling.member.opLabel') })}
${numberInput('levels', '', { label: tr.t('leveling.member.levels'), min: 0, max: MAX_LEVEL })}</div>`, { submit: tr.t('leveling.member.apply'), canEdit: ctx.canEdit && ctx.canAct })
            : html`<p class="muted">${tr.tx('leveling.member.needsAdmin')}</p>`;
        const catEdit = ctx.canEdit && ctx.canAct;
        // English keeps the en-US grouping it always showed ("12,345").
        const catTotal = cat ? (tr.lang === 'en' ? Number(cat.total).toLocaleString('en-US') : tr.fmtNumber(Number(cat.total))) : '';
        const catNow = cat
            ? html`<div class="cat-now"><img src="/img/cat/${cat.image}" width="96" height="96" alt="${tr.t('leveling.cat.alt', { name: cat.name, stage: cat.stage.name.toLowerCase(), mood: cat.mood })}"><p>${tr.tp('leveling.cat.now', Number(cat.total) || 0, { sentence: cat.sentence, stage: cat.stage.name, total: catTotal })}</p></div>`
            : html`<p class="muted">${tr.t('leveling.cat.notLoaded')}</p>`;
        const catName = postForm(ctx, 'leveling', 'cat-name', textInput('catName', registryValue(ctx, 'catName'), {
            label: tr.t('leveling.cat.name'), max: CAT_NAME_MAX, help: tr.t('leveling.cat.nameHelp'),
        }), { submit: tr.t('leveling.cat.saveName'), canEdit: catEdit, reset: true });
        const catAnnounce = toggleForm(ctx, 'leveling', 'cat-announce', registryValue(ctx, 'catAnnounce') !== false, {
            label: tr.t('leveling.cat.announce'), canEdit: catEdit,
        });
        const catPart = html`${catNow}${catName}${catAnnounce}${ctx.canAct ? '' : html`<p class="muted">${tr.t('leveling.cat.needsAdmin')}</p>`}`;
        // The on/off switch is in the page header (pages.js moduleSettingsPage).
        // v6: cards grouped by topic (common.js topic/section). Keys: the English titles' slugs (stable ids in every language).
        return html`${topic(tr.t('leveling.topic.earning'), tr.t('leveling.topic.earningLine'), html`${section(tr.t('leveling.xp.title'), settings, tr.t('leveling.xp.help'), { key: 'xp-and-messages' })}
${section(tr.t('leveling.card.title'), card, [tr.t('leveling.card.help'), tr.t('leveling.card.more')], { key: 'level-up-card' })}
${section(tr.t('leveling.voice.title'), voiceForm(ctx, cfg, tr), [tr.t('leveling.voice.help'), tr.t('leveling.voice.more')], { key: 'voice-xp' })}
${section(tr.t('leveling.boosts.title'), boosts, [tr.t('leveling.boosts.help', boostRange), tr.t('leveling.boosts.more', { cap: tr.fmtNumber(TOTAL_MULTIPLIER_CAP) })], { key: 'xp-boosts', size: 'normal' })}
${section(tr.t('leveling.ignored.title'), ignored, tr.t('leveling.ignored.help'), { key: 'no-xp-in', size: 'normal' })}`, { key: 'earning-xp' })}
${topic(tr.t('leveling.topic.rewards'), tr.t('leveling.topic.rewardsLine'), html`${section(tr.t('leveling.rewards.title'), rewardTable, tr.t('leveling.rewards.help'), { key: 'role-rewards', size: 'normal' })}
${section(tr.t('leveling.member.title'), members, tr.t('leveling.member.help'), { key: 'member-levels' })}`, { key: 'rewards-and-levels' })}
${topic(tr.t('leveling.topic.cat'), tr.t('leveling.topic.catLine'), section(tr.t('leveling.cat.title'), catPart, [tr.t('leveling.cat.help'), tr.t('leveling.cat.more')], { key: 'server-cat', size: 'full' }), { key: 'server-cat' })}`;
    },

    actions: managerActions(['enabled', 'settings', 'card', 'voice'], {
        'cat-name': {
            admin: true,
            async run(ctx, form) {
                const tr = textFor(ctx);
                const name = sanitizeCatName(text(form, 'catName', CAT_NAME_MAX));
                if (!name) throw new InputError(tr.t('leveling.error.catName'), 400, 'catName');
                const patch = changedOnly({ catName: name }, { catName: registryValue(ctx, 'catName') });
                if (!Object.keys(patch).length) return NOTHING;
                const result = await saveRegistry(ctx, patch, 'leveling');
                return { ...result, message: tr.t('leveling.action.catNamed', { name }) };
            },
        },
        'cat-announce': {
            admin: true,
            async run(ctx, form) {
                const tr = textFor(ctx);
                const enabled = boolField(form, 'enabled', tr.t('leveling.action.catAnnounceLabel'));
                const patch = changedOnly({ catAnnounce: enabled }, { catAnnounce: registryValue(ctx, 'catAnnounce') !== false });
                if (!Object.keys(patch).length) return NOTHING;
                const result = await saveRegistry(ctx, patch, 'leveling');
                return { ...result, message: tr.t(enabled ? 'leveling.action.catPostsOn' : 'leveling.action.catPostsOff') };
            },
        },
        async enabled(ctx, form) {
            const tr = textFor(ctx);
            const enabled = boolField(form, 'enabled', tr.t('leveling.action.enabledLabel'));
            return update(ctx, { enabled }, tr.t(enabled ? 'leveling.action.enabledOn' : 'leveling.action.enabledOff'));
        },
        async settings(ctx, form) {
            const tr = textFor(ctx);
            const cfg = await ctx.services.getLevelingConfig(ctx.client, ctx.guildId);
            const min = intField(form, 'xpMin', { min: 1, max: 500, label: tr.t('leveling.xp.min') });
            const max = intField(form, 'xpMax', { min: 1, max: 500, label: tr.t('leveling.xp.max') });
            if (min > max) throw new InputError(tr.t('leveling.error.minMax'));
            const range = xpRangeOf(cfg);
            const patch = changedOnly({
                xpCooldown: intField(form, 'xpCooldown', { min: 0, max: 3600, label: tr.t('leveling.xp.cooldown') }),
                levelUpChannel: channelField(ctx.guild, form, 'levelUpChannel', { label: tr.t('leveling.xp.channel') }),
                announceLevelUp: checkbox(form, 'announceLevelUp'),
                levelUpMessage: text(form, 'levelUpMessage', 500) || defaultLevelUpMessage(tr), // cleared = back to the default message
            }, { ...cfg, xpCooldown: cfg.xpCooldown ?? 60, announceLevelUp: cfg.announceLevelUp !== false, levelUpChannel: cfg.levelUpChannel || null });
            if (min !== range.min || max !== range.max) patch.xpRange = { min, max };
            return update(ctx, patch, tr.t('leveling.action.settingsSaved'));
        },
        async card(ctx, form) {
            const tr = textFor(ctx);
            const cfg = await ctx.services.getLevelingConfig(ctx.client, ctx.guildId);
            const patch = changedOnly({
                levelUpCard: checkbox(form, 'levelUpCard'),
                cardAccent: cardAccentFromForm(form, tr),
            }, { levelUpCard: cfg.levelUpCard === true, cardAccent: cardAccentOf(cfg.cardAccent) });
            return update(ctx, patch, tr.t('leveling.action.cardSaved'));
        },
        // Voice XP: only the changed fields are sent; they are merged under the config row lock.
        async voice(ctx, form) {
            const tr = textFor(ctx);
            const current = voiceConfigOf(await ctx.services.getLevelingConfig(ctx.client, ctx.guildId));
            const xpMin = intField(form, 'voiceXpMin', { min: 1, max: VOICE_XP_MAX, label: tr.t('leveling.voice.xpMin') });
            const xpMax = intField(form, 'voiceXpMax', { min: 1, max: VOICE_XP_MAX, label: tr.t('leveling.voice.xpMax') });
            if (xpMin > xpMax) throw new InputError(tr.t('leveling.error.voiceMinMax'), 400, 'voiceXpMin');
            const patch = changedOnly({
                enabled: checkbox(form, 'voiceEnabled'),
                xpMin,
                xpMax,
                dailyCapMinutes: intField(form, 'voiceCap', { min: 0, max: VOICE_CAP_MAX, label: tr.t('leveling.voice.cap') }),
                minHumans: intField(form, 'voiceMinHumans', { min: VOICE_MIN_HUMANS_MIN, max: VOICE_MIN_HUMANS_MAX, label: tr.t('leveling.voice.minHumans') }),
                requireUnmuted: checkbox(form, 'voiceRequireUnmuted'),
                excludedChannels: excludedFromForm(ctx, form, current.excludedChannels, tr),
            }, current);
            if (!Object.keys(patch).length) return NOTHING;
            const { before, after } = await ctx.services.updateVoiceXpConfig(ctx.client, ctx.guildId, patch);
            const changes = diffSnapshots(voiceConfigOf(before), voiceConfigOf(after), Object.keys(patch), `${AUDIT}voice.`);
            return { changes, message: changes.length ? tr.t('leveling.action.voiceSaved') : tr.t('leveling.action.nothing') };
        },
        // Add / remove under the config row lock (updateLevelIgnoreList), never a cached read plus a whole-list save.
        async 'ignore-add'(ctx, form) {
            const tr = textFor(ctx);
            const type = choiceField(form, 'type', ['channel', 'role'], tr.t('leveling.ignored.type'));
            const field = type === 'channel' ? 'ignoredChannels' : 'ignoredRoles';
            const id = type === 'channel'
                ? channelField(ctx.guild, form, 'id', { optional: false, kinds: ['text', 'voice', 'forum'], label: tr.t('leveling.boosts.channel') })
                : text(form, 'id', 25);
            if (type === 'role' && !ctx.guild?.roles?.cache?.get(id)) throw new InputError(tr.t('leveling.error.roleMissing'));
            return ignoreChange(ctx, field, 'add', id, tr.t('leveling.action.ignoreAdded'), tr.t('leveling.action.alreadyListed'));
        },
        async 'ignore-remove'(ctx, form) {
            const tr = textFor(ctx);
            const type = choiceField(form, 'type', ['channel', 'role'], tr.t('leveling.ignored.type'));
            const id = text(form, 'id', 25);
            if (!isSnowflake(id)) return { changes: [], message: tr.t('leveling.action.notListed') };
            const field = type === 'channel' ? 'ignoredChannels' : 'ignoredRoles';
            return ignoreChange(ctx, field, 'remove', id, tr.t('leveling.action.removed'), tr.t('leveling.action.notListed'));
        },
        async 'boost-add'(ctx, form) {
            const tr = textFor(ctx);
            const type = choiceField(form, 'type', ['channel', 'role'], tr.t('leveling.ignored.type'));
            const id = type === 'channel'
                ? channelField(ctx.guild, form, 'id', { optional: false, kinds: ['text', 'voice', 'forum'], label: tr.t('leveling.boosts.channel') })
                : roleField(ctx.guild, form, 'id', { optional: false, label: tr.t('leveling.boosts.role'), allowManaged: true });
            const multiplier = decimalField(form, 'multiplier', { min: BOOST_MIN, max: BOOST_MAX, decimals: 1, label: tr.t('leveling.boosts.boost') });
            const field = BOOST_FIELD[type];
            const cfg = await ctx.services.getLevelingConfig(ctx.client, ctx.guildId);
            const current = cfg[field] || {};
            if (current[id] === multiplier) return { changes: [], message: tr.t('leveling.action.boostSame') };
            if (!(id in current) && Object.keys(current).length >= MAX_BOOSTS) {
                throw new InputError(tr.tp(type === 'channel' ? 'leveling.error.maxChannelBoosts' : 'leveling.error.maxRoleBoosts', MAX_BOOSTS));
            }
            const { before, after } = await ctx.services.setLevelBoost(ctx.client, ctx.guildId, type, id, multiplier);
            const changes = diffSnapshots(before?.[field] || {}, after?.[field] || {}, null, `${AUDIT}${field}.`);
            return { changes, message: tr.t(type === 'channel' ? 'leveling.action.channelBoostSet' : 'leveling.action.roleBoostSet', { boost: boostText(multiplier) }) };
        },
        async 'boost-remove'(ctx, form) {
            const tr = textFor(ctx);
            const type = choiceField(form, 'type', ['channel', 'role'], tr.t('leveling.ignored.type'));
            const id = text(form, 'id', 25);
            const field = BOOST_FIELD[type];
            const cfg = await ctx.services.getLevelingConfig(ctx.client, ctx.guildId);
            if (!(id in (cfg[field] || {}))) return { changes: [], message: tr.t('leveling.action.noBoost') };
            const { before, after } = await ctx.services.setLevelBoost(ctx.client, ctx.guildId, type, id, null);
            const changes = diffSnapshots(before?.[field] || {}, after?.[field] || {}, null, `${AUDIT}${field}.`);
            return { changes, message: tr.t('leveling.action.boostRemoved') };
        },
        // Administrator only: roles the bot gives as level rewards.
        'reward-mode': {
            admin: true,
            async run(ctx, form) {
                const tr = textFor(ctx);
                const rewardMode = choiceField(form, 'rewardMode', REWARD_MODES, tr.t('leveling.rewards.modeLabel'));
                const cfg = await ctx.services.getLevelingConfig(ctx.client, ctx.guildId);
                const patch = changedOnly({ rewardMode }, { rewardMode: rewardModeOf(cfg) });
                return update(ctx, patch, tr.t(rewardMode === 'highest' ? 'leveling.action.modeHighest' : 'leveling.action.modeKeep'));
            },
        },
        // Administrator only: roles the bot gives as level rewards.
        'reward-add': {
            admin: true,
            async run(ctx, form) {
                const tr = textFor(ctx);
                const level = intField(form, 'level', { min: 1, max: MAX_LEVEL, label: tr.t('leveling.rewards.level') });
                const roleId = autoRoleField(ctx.guild, form, 'roleId', { optional: false, label: tr.t('leveling.rewards.rewardRole') });
                const { before, after } = await ctx.services.setLevelRoleReward(ctx.client, ctx.guildId, level, roleId);
                const changes = diffSnapshots(before?.roleRewards || {}, after?.roleRewards || {}, null, `${AUDIT}roleRewards.`);
                return { changes, message: tr.t('leveling.action.rewardAdded', { level: tr.fmtNumber(level) }) };
            },
        },
        // Administrator only: roles the bot gives as level rewards.
        'reward-remove': {
            admin: true,
            async run(ctx, form) {
                const tr = textFor(ctx);
                const level = intField(form, 'level', { min: 1, max: MAX_LEVEL, label: tr.t('leveling.rewards.level') });
                const { before, after } = await ctx.services.setLevelRoleReward(ctx.client, ctx.guildId, level, null);
                const changes = diffSnapshots(before?.roleRewards || {}, after?.roleRewards || {}, null, `${AUDIT}roleRewards.`);
                return { changes, message: changes.length ? tr.t('leveling.action.rewardRemoved', { level: tr.fmtNumber(level) }) : tr.t('leveling.action.noReward') };
            },
        },
        member: {
            admin: true,
            async run(ctx, form) {
                const tr = textFor(ctx);
                const userId = userIdField(form, 'userId', tr.t('leveling.member.memberId'));
                const op = choiceField(form, 'op', ['add', 'remove', 'set'], tr.t('leveling.member.actionLabel'));
                const levels = intField(form, 'levels', { min: op === 'set' ? 0 : 1, max: MAX_LEVEL, label: tr.t('leveling.member.levels') });
                const member = await ctx.guild?.members?.fetch?.(userId).catch(() => null);
                if (!member) throw new InputError(tr.t('leveling.error.memberMissing'));
                const before = await ctx.services.getUserLevelData(ctx.client, ctx.guildId, userId);
                if (op === 'add') await ctx.services.addLevels(ctx.client, ctx.guildId, userId, levels);
                else if (op === 'remove') await ctx.services.removeLevels(ctx.client, ctx.guildId, userId, levels);
                else await ctx.services.setUserLevel(ctx.client, ctx.guildId, userId, levels);
                const after = await ctx.services.getUserLevelData(ctx.client, ctx.guildId, userId);
                // Reward roles follow the new level, as with /level add|remove|set.
                const roleSync = await Promise.resolve()
                    .then(() => ctx.services.syncLevelRolesForMember(ctx.client, member, { level: after.level, removeUnearned: true, reason: 'Level changed on the dashboard' }))
                    .catch((error) => {
                        logger.warn(`Level reward roles not synced for ${userId} in guild ${ctx.guildId}: ${error.message}`);
                        return { added: [], removed: [], skipped: [], errors: 1 };
                    });
                const note = roleSyncNote(roleSync);
                const done = tr.t('leveling.action.memberDone', { name: member.user?.username || userId, level: tr.fmtNumber(after.level) });
                return {
                    changes: [{ key: `member.${userId}.level`, old: before.level, new: after.level }],
                    message: `${done}${note ? ` ${note}` : ''}`,
                };
            },
        },
    }),
};
