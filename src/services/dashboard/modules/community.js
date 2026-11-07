// community.js — Community: suggestions channel, starboard, sticky messages, tags and
// YouTube feeds. Writes go through the community services (settingsService,
// starboardSettingsPatch, stickyService, tagService, feedService), as /community and
// /tag do; their validators produce the error messages. Open suggestions are decided
// with decideSuggestion, as /suggest status does (status, message update, DM to the author).

import { STARBOARD_MAX_THRESHOLD } from '../../community/starboardService.js';
import { STICKY_MAX_LENGTH } from '../../community/stickyService.js';
import { TAG_CONTENT_MAX, TRIGGER_KINDS } from '../../community/tagService.js';
import { SUGGESTION_REASON_MAX, SUGGESTION_STATUSES } from '../../community/suggestionService.js';
import { FEED_TEMPLATE_MAX } from '../../community/feedService.js';
import { html } from '../html.js';
import {
    InputError, PERMS, buttonForm, channelField, channelListField, channelName, channelPicker, choiceField, intField, multiline, numberInput, postForm,
    selectInput, text, textArea, textInput,
} from '../forms.js';
import { diffSnapshots } from '../audit.js';
import { section, table } from './common.js';
import { textFor } from '../language.js';

// Words: src/content/dashboard/<lang>/community.json (trigger kinds and statuses stay codes in the form values).

const clip = (value, max = 120) => {
    const t = String(value ?? '').replace(/\s+/g, ' ');
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

const OPEN_SUGGESTIONS_SHOWN = 25;

/** The words for the trigger kinds (TRIGGER_KINDS), the decisions and the suggestion states. */
function words(tr) {
    return {
        kind: { none: tr.t('community.tag.kind.none'), word: tr.t('community.tag.kind.word'), regex: tr.t('community.tag.kind.regex') },
        choice: { approved: tr.t('community.open.choice.approved'), denied: tr.t('community.open.choice.denied'), considering: tr.t('community.open.choice.considering') },
        status: { pending: tr.t('community.open.status.pending'), considering: tr.t('community.open.status.considering'), approved: tr.t('community.open.status.approved'), denied: tr.t('community.open.status.denied') },
    };
}

function openSuggestionsSection(ctx, open) {
    const tr = textFor(ctx);
    const w = words(tr);
    const canDecide = ctx.canEdit && ctx.canAct;
    if (!open.length) return html`<p class="muted">${tr.tx('community.open.empty')}</p>`;
    const blocks = open.map((row) => html`<details class="sub" data-key="suggestion-${row.id}"><summary>#${row.id} · ${clip(row.content, 80)} · ${tr.tx('community.open.votes', { up: tr.fmtNumber(row.upvotes ?? 0), down: tr.fmtNumber(row.downvotes ?? 0) })} · ${w.status[row.status] || row.status}</summary>
<p class="value">${row.content}</p>
<p class="muted">${tr.tx('community.open.by', {
        user: ctx.client?.users?.cache?.get?.(row.user_id)?.username || row.user_id,
        date: row.created_at ? tr.tx('community.open.onDate', { date: tr.fmtDateTime(row.created_at) }) : '',
        channel: row.channel_id ? tr.tx('community.open.inChannel', { channel: channelName(ctx.guild, row.channel_id) }) : '',
    })}</p>
${postForm(ctx, 'community', 'suggestion-status', html`<div class="grid">
${selectInput('status', 'approved', SUGGESTION_STATUSES.map((st) => [st, w.choice[st] || st]), { label: tr.t('community.open.decision') })}
${textArea('reason', row.status_reason || '', { label: tr.t('community.open.reason'), max: SUGGESTION_REASON_MAX, rows: 2, help: tr.t('community.open.reasonHelp') })}</div>`,
        { submit: tr.t('community.open.submit'), hidden: { id: row.id }, canEdit: canDecide })}</details>`);
    return html`${open.length >= OPEN_SUGGESTIONS_SHOWN ? html`<p class="muted">${tr.tx('community.open.newestShown', { count: tr.fmtNumber(OPEN_SUGGESTIONS_SHOWN) })}</p>` : ''}${blocks}
${canDecide ? '' : html`<p class="muted">${tr.tx('community.open.needsAdmin')}</p>`}`;
}

async function updateSettings(ctx, patch, message) {
    const before = ctx.services.getCommunitySettings(ctx.guildId);
    const after = await ctx.services.updateCommunitySettings(ctx.guildId, patch, ctx.actor.userId);
    const changes = diffSnapshots(before, after, Object.keys(patch), 'community.');
    return { changes, message: changes.length ? message : textFor(ctx).t('community.action.nothing') };
}

export default {
    key: 'community',
    label: 'Community',
    help: 'Tools that make the server livelier: members can suggest ideas and vote on them, popular messages get a place of honour (the starboard), important notes stay at the bottom of a channel, saved replies answer common questions, and new YouTube videos are announced.',

    async load(ctx) {
        return {
            settings: ctx.services.getCommunitySettings(ctx.guildId),
            stickies: ctx.services.listStickies(ctx.guildId),
            tags: ctx.services.listTags(ctx.guildId),
            feeds: ctx.services.listFeeds(ctx.guildId),
            openSuggestions: await ctx.services.listOpenSuggestions(ctx.guildId, OPEN_SUGGESTIONS_SHOWN),
        };
    },

    render(ctx, { settings: s, stickies, tags, feeds, openSuggestions = [] }) {
        const g = ctx.guild;
        const tr = textFor(ctx);
        const w = words(tr);
        const kinds = TRIGGER_KINDS.map((k) => [k, w.kind[k] || k]);
        const triggerHelp = tr.t('community.tag.triggerHelp');
        const suggestions = postForm(ctx, 'community', 'suggestions', html`<div class="grid">${channelPicker(g, 'channelId', s.suggestionsChannelId, { label: tr.t('community.suggestions.channel'), perms: PERMS.post, noneLabel: tr.t('community.suggestions.off'), help: tr.t('community.suggestions.channelHelp') })}</div>`);
        // `reset`: a translated "Save" is not recognised by its word (forms.js postForm).
        const starboard = html`${postForm(ctx, 'community', 'starboard', html`<div class="grid">
${channelPicker(g, 'channelId', s.starboardChannelId, { label: tr.t('community.starboard.channel'), perms: PERMS.post, optional: false, help: tr.t('community.starboard.channelHelp') })}
${textInput('emoji', s.starboardEmoji, { label: tr.t('community.starboard.emoji'), max: 64, help: tr.t('community.starboard.emojiHelp') })}
${numberInput('threshold', s.starboardThreshold, { label: tr.t('community.starboard.threshold'), min: 1, max: STARBOARD_MAX_THRESHOLD, help: tr.t('community.starboard.thresholdHelp') })}</div>`, { submit: s.starboardChannelId ? tr.t('community.starboard.save') : tr.t('community.starboard.turnOn'), reset: Boolean(s.starboardChannelId) })}
${s.starboardChannelId ? buttonForm(ctx, 'community', 'starboard-off', tr.t('community.starboard.turnOff')) : html`<p class="muted">${tr.tx('community.starboard.isOff')}</p>`}`;
        const stickyRows = stickies.map((st) => [channelName(g, st.channelId), clip(st.content), buttonForm(ctx, 'community', 'sticky-remove', tr.t('community.remove'), { channelId: st.channelId }, { confirm: tr.t('community.sticky.removeConfirm') })]);
        const stickyEdits = stickies.map((st) => html`<details class="sub" data-key="sticky-${st.channelId}"><summary>${tr.tx('community.sticky.editIn', { channel: channelName(g, st.channelId) })}</summary>
${postForm(ctx, 'community', 'sticky-set', textArea('content', st.content, { label: tr.t('community.sticky.message'), max: STICKY_MAX_LENGTH, rows: 3 }), { submit: tr.t('community.sticky.save'), reset: true, hidden: { channelId: st.channelId } })}</details>`);
        const sticky = html`${table([tr.t('community.sticky.channel'), tr.t('community.sticky.messageColumn'), ''], stickyRows, tr.t('community.sticky.empty'))}${stickyEdits}
<h3>${tr.tx('community.sticky.new')}</h3>
${postForm(ctx, 'community', 'sticky-set', html`<div class="grid">${channelPicker(g, 'channelId', null, { label: tr.t('community.sticky.channel'), perms: [...PERMS.post, 'ManageMessages'], optional: false, help: tr.t('community.sticky.channelHelp') })}
${textArea('content', '', { label: tr.t('community.sticky.message'), max: STICKY_MAX_LENGTH, rows: 3, help: tr.t('community.sticky.messageHelp') })}</div>`, { submit: tr.t('community.sticky.set') })}`;
        const tagRows = tags.map((t) => [html`<code>${t.name}</code>`, clip(t.content), t.triggerKind === 'none' ? '-' : tr.t('community.tag.triggerCell', { kind: w.kind[t.triggerKind] || t.triggerKind, trigger: clip(t.trigger, 40) }),
            buttonForm(ctx, 'community', 'tag-delete', tr.t('community.tag.delete'), { name: t.name }, { confirm: tr.t('community.tag.deleteConfirm', { name: t.name }) })]);
        const tagEdits = tags.map((t) => html`<details class="sub" data-key="tag-${t.name}"><summary>${tr.tx('community.tag.edit', { name: html`<code>${t.name}</code>` })}</summary>
${postForm(ctx, 'community', 'tag-edit', html`<div class="grid">
${selectInput('triggerKind', t.triggerKind || 'none', kinds, { label: tr.t('community.tag.replyByItself'), help: triggerHelp })}
${textInput('trigger', t.trigger || '', { label: tr.t('community.tag.trigger'), max: 200 })}
${numberInput('cooldownS', t.cooldownS ?? '', { label: tr.t('community.tag.cooldown'), min: 0, max: 86400, help: tr.t('community.tag.cooldownHelp') })}
${channelPicker(g, 'allowChannels', t.allowChannels || [], { label: tr.t('community.tag.allowChannels'), kinds: ['text', 'category'], perms: PERMS.post, multiple: true, help: tr.t('community.tag.allowChannelsHelp') })}
${channelPicker(g, 'denyChannels', t.denyChannels || [], { label: tr.t('community.tag.denyChannels'), kinds: ['text', 'category'], perms: [], multiple: true })}
${textArea('content', t.content, { label: tr.t('community.tag.text'), max: TAG_CONTENT_MAX, rows: 3 })}</div>`, { submit: tr.t('community.tag.save'), reset: true, hidden: { name: t.name } })}</details>`);
        const tagForms = html`${table([tr.t('community.tag.name'), tr.t('community.tag.content'), tr.t('community.tag.triggerColumn'), ''], tagRows, tr.t('community.tag.empty'))}${tagEdits}
<h3>${tr.tx('community.tag.new')}</h3>
${postForm(ctx, 'community', 'tag-create', html`<div class="grid">${textInput('name', '', { label: tr.t('community.tag.name'), max: 32, help: tr.t('community.tag.nameHelp') })}
${selectInput('triggerKind', 'none', kinds, { label: tr.t('community.tag.replyByItself'), help: triggerHelp })}
${textInput('trigger', '', { label: tr.t('community.tag.trigger'), max: 200 })}
${numberInput('cooldownS', '', { label: tr.t('community.tag.cooldown'), min: 0, max: 86400, help: tr.t('community.tag.cooldownNewHelp') })}
${textArea('content', '', { label: tr.t('community.tag.text'), max: TAG_CONTENT_MAX, rows: 3 })}</div>`, { submit: tr.t('community.tag.create') })}`;
        const feedRows = feeds.map((f) => [`#${f.id}`, html`<code>${f.sourceId}</code>`, channelName(g, f.channelId), clip(f.template || tr.t('community.feed.defaultMessage'), 60),
            buttonForm(ctx, 'community', 'feed-remove', tr.t('community.remove'), { id: f.id }, { confirm: tr.t('community.feed.removeConfirm') })]);
        const feedForms = html`${table([tr.t('community.feed.feed'), tr.t('community.feed.source'), tr.t('community.feed.postsIn'), tr.t('community.feed.message'), ''], feedRows, tr.t('community.feed.empty'))}
${postForm(ctx, 'community', 'feed-add', html`<div class="grid">${textInput('source', '', { label: tr.t('community.feed.source'), max: 200, help: tr.t('community.feed.sourceHelp') })}
${channelPicker(g, 'channelId', null, { label: tr.t('community.feed.postIn'), perms: PERMS.post, optional: false, help: tr.t('community.feed.postInHelp') })}
${textArea('template', '', { label: tr.t('community.feed.message'), max: FEED_TEMPLATE_MAX, rows: 2, help: tr.t('community.feed.messageHelp', { author: '{author}', title: '{title}', url: '{url}' }) })}</div>`, { submit: tr.t('community.feed.add') })}`;
        // Explicit keys: the card ids stay the English slugs in every language.
        return html`${section(tr.t('community.suggestions.title'), suggestions, tr.t('community.suggestions.help'), { key: 'suggestions' })}
${section(tr.t('community.open.title', { count: tr.fmtNumber(openSuggestions.length) }), openSuggestionsSection(ctx, openSuggestions), tr.t('community.open.help'), { key: 'open-suggestions' })}
${section(tr.t('community.starboard.title'), starboard, tr.t('community.starboard.help'), { key: 'starboard' })}${section(tr.t('community.sticky.title'), sticky, tr.t('community.sticky.help'), { key: 'sticky-messages' })}${section(tr.t('community.tag.title'), tagForms, tr.t('community.tag.help'), { key: 'tags' })}${section(tr.t('community.feed.title'), feedForms, tr.t('community.feed.help'), { key: 'youtube-feeds' })}`;
    },

    actions: {
        'suggestion-status': {
            admin: true,
            async run(ctx, form) {
                const tr = textFor(ctx);
                const id = intField(form, 'id', { min: 1, max: 2147483647, label: tr.t('community.action.suggestion') });
                const status = choiceField(form, 'status', SUGGESTION_STATUSES, tr.t('community.open.decision'));
                const reason = multiline(form, 'reason', SUGGESTION_REASON_MAX + 1);
                if (reason.length > SUGGESTION_REASON_MAX) throw new InputError(tr.t('community.action.reasonTooLong', { max: tr.fmtNumber(SUGGESTION_REASON_MAX) }), 400, 'reason');
                const before = await ctx.services.getSuggestion(ctx.guildId, id);
                if (!before) throw new InputError(tr.t('community.action.noSuggestion', { id }));
                const decided = await ctx.services.decideSuggestion({ client: ctx.client, guild: ctx.guild, suggestionId: id, status, reason, decidedBy: ctx.actor.userId });
                if (!decided) throw new InputError(tr.t('community.action.noSuggestion', { id }));
                const { row, edited, dmed } = decided;
                const warnings = [];
                if (!edited) warnings.push(tr.t('community.action.notUpdated'));
                if (!dmed) warnings.push(tr.t('community.action.notDmed'));
                const state = words(tr).status[row.status] || row.status;
                return {
                    changes: [{ key: `suggestion.${id}`, old: { status: before.status, reason: before.status_reason ?? null }, new: { status: row.status, reason: row.status_reason ?? null } }],
                    message: tr.t(dmed ? 'community.action.decidedDm' : 'community.action.decided', { id, status: state }),
                    warnings,
                };
            },
        },
        async suggestions(ctx, form) {
            const tr = textFor(ctx);
            const channelId = channelField(ctx.guild, form, 'channelId', { label: tr.t('community.suggestions.channel') });
            return updateSettings(ctx, { suggestionsChannelId: channelId }, tr.t(channelId ? 'community.action.suggestionsSaved' : 'community.action.suggestionsOff'));
        },
        async starboard(ctx, form) {
            const tr = textFor(ctx);
            const channelId = channelField(ctx.guild, form, 'channelId', { optional: false, label: tr.t('community.starboard.channel') });
            const threshold = intField(form, 'threshold', { min: 1, max: STARBOARD_MAX_THRESHOLD, label: tr.t('community.starboard.threshold') });
            const patch = ctx.services.starboardSettingsPatch({ channelId, emoji: text(form, 'emoji', 64) || null, threshold });
            return updateSettings(ctx, patch, tr.t('community.action.starboardSaved'));
        },
        async 'starboard-off'(ctx) {
            return updateSettings(ctx, { starboardChannelId: null }, textFor(ctx).t('community.action.starboardOff'));
        },
        async 'sticky-set'(ctx, form) {
            const tr = textFor(ctx);
            const channelId = channelField(ctx.guild, form, 'channelId', { optional: false, label: tr.t('community.sticky.channel') });
            const content = multiline(form, 'content', STICKY_MAX_LENGTH + 1);
            const before = ctx.services.listStickies(ctx.guildId).find((st) => st.channelId === channelId)?.content ?? null;
            const { posted } = await ctx.services.setSticky({ guildId: ctx.guildId, channel: ctx.guild.channels.cache.get(channelId), content, updatedBy: ctx.actor.userId });
            const result = { changes: before === content.trim() ? [] : [{ key: `sticky.${channelId}`, old: before, new: content.trim() }], message: tr.t('community.action.stickySaved') };
            if (!posted) result.warnings = [tr.t('community.action.stickyNotPosted')];
            return result;
        },
        async 'sticky-remove'(ctx, form) {
            const tr = textFor(ctx);
            const channelId = text(form, 'channelId', 25);
            const before = ctx.services.listStickies(ctx.guildId).find((st) => st.channelId === channelId);
            if (!before) throw new InputError(tr.t('community.action.noSticky'));
            await ctx.services.removeSticky({ channelId, channel: ctx.guild?.channels?.cache?.get(channelId) || null });
            return { changes: [{ key: `sticky.${channelId}`, old: before.content, new: null }], message: tr.t('community.action.stickyRemoved') };
        },
        async 'tag-create'(ctx, form) {
            const triggerKind = text(form, 'triggerKind', 10) || 'none';
            const tag = await ctx.services.createTag({
                guildId: ctx.guildId,
                name: text(form, 'name', 40),
                content: multiline(form, 'content', TAG_CONTENT_MAX + 1),
                triggerKind,
                trigger: triggerKind === 'none' ? null : text(form, 'trigger', 200),
                cooldownS: intField(form, 'cooldownS', { min: 0, max: 86400, label: textFor(ctx).t('community.action.cooldownLabel'), fallback: null }),
                createdBy: ctx.actor.userId,
            });
            return { changes: [{ key: `tag.${tag?.name}`, old: null, new: tag?.content ?? null }], message: textFor(ctx).t('community.action.tagCreated', { name: tag?.name }) };
        },
        async 'tag-edit'(ctx, form) {
            const tr = textFor(ctx);
            const name = text(form, 'name', 40).toLowerCase();
            const before = ctx.services.listTags(ctx.guildId).find((t) => t.name === name);
            if (!before) throw new InputError(tr.t('community.action.noTag'));
            const triggerKind = choiceField(form, 'triggerKind', TRIGGER_KINDS, tr.t('community.tag.triggerColumn'));
            const content = multiline(form, 'content', TAG_CONTENT_MAX + 1);
            if (!content) throw new InputError(tr.t('community.action.emptyTag'));
            const next = {
                content,
                triggerKind,
                trigger: triggerKind === 'none' ? null : text(form, 'trigger', 200),
                cooldownS: intField(form, 'cooldownS', { min: 0, max: 86400, label: tr.t('community.action.cooldownLabel'), fallback: before.cooldownS ?? null }),
                allowChannels: channelListField(ctx.guild, form, 'allowChannels', { label: tr.t('community.tag.allowChannels') }),
                denyChannels: channelListField(ctx.guild, form, 'denyChannels', { label: tr.t('community.tag.denyChannels') }),
            };
            const current = { content: before.content, triggerKind: before.triggerKind || 'none', trigger: before.trigger ?? null, cooldownS: before.cooldownS ?? null, allowChannels: before.allowChannels || [], denyChannels: before.denyChannels || [] };
            const changed = Object.fromEntries(Object.entries(next).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(current[k])));
            if (!Object.keys(changed).length) return { changes: [], message: tr.t('community.action.nothing') };
            // A trigger change always sends the kind with it (the service validates the pair).
            if (Object.hasOwn(changed, 'trigger') || Object.hasOwn(changed, 'triggerKind')) Object.assign(changed, { triggerKind, trigger: next.trigger });
            const tag = await ctx.services.editTag({ guildId: ctx.guildId, name, ...changed });
            if (!tag) throw new InputError(tr.t('community.action.noTag'));
            return {
                changes: Object.keys(changed).map((key) => ({ key: `tag.${name}.${key}`, old: current[key] ?? null, new: next[key] ?? null })),
                message: tr.t('community.action.tagSaved', { name }),
            };
        },
        async 'tag-delete'(ctx, form) {
            const tr = textFor(ctx);
            const name = text(form, 'name', 40).toLowerCase();
            const before = ctx.services.listTags(ctx.guildId).find((t) => t.name === name);
            const removed = await ctx.services.deleteTag(ctx.guildId, name);
            if (!removed) throw new InputError(tr.t('community.action.noTag'));
            return { changes: [{ key: `tag.${name}`, old: before?.content ?? null, new: null }], message: tr.t('community.action.tagDeleted', { name }) };
        },
        async 'feed-add'(ctx, form) {
            const channelId = channelField(ctx.guild, form, 'channelId', { optional: false, label: textFor(ctx).t('community.feed.postIn') });
            const { feed } = await ctx.services.addFeed({
                guildId: ctx.guildId, sourceInput: text(form, 'source', 200), channelId,
                template: multiline(form, 'template', FEED_TEMPLATE_MAX + 1) || null, createdBy: ctx.actor.userId,
            });
            return { changes: [{ key: `feed.${feed.id}`, old: null, new: { source: feed.sourceId, channelId } }], message: textFor(ctx).t('community.action.feedAdded', { id: feed.id }) };
        },
        async 'feed-remove'(ctx, form) {
            const tr = textFor(ctx);
            const id = intField(form, 'id', { min: 1, max: 2147483647, label: tr.t('community.feed.feed') });
            const before = ctx.services.listFeeds(ctx.guildId).find((f) => f.id === id);
            const removed = await ctx.services.removeFeed(ctx.guildId, id);
            if (!removed) throw new InputError(tr.t('community.action.noFeed', { id }));
            return { changes: [{ key: `feed.${id}`, old: before ? { source: before.sourceId, channelId: before.channelId } : null, new: null }], message: tr.t('community.action.feedRemoved', { id }) };
        },
    },
};

