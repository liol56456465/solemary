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
import { formatDate, html } from '../html.js';
import {
    InputError, PERMS, buttonForm, channelField, channelListField, channelName, channelPicker, choiceField, intField, multiline, numberInput, postForm,
    selectInput, text, textArea, textInput,
} from '../forms.js';
import { diffSnapshots } from '../audit.js';
import { section, table } from './common.js';

const clip = (value, max = 120) => {
    const t = String(value ?? '').replace(/\s+/g, ' ');
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

const OPEN_SUGGESTIONS_SHOWN = 25;
const TRIGGER_HELP = 'none: only posted with /tag show. word: replies when a message contains the word or phrase below. regex: replies when a message matches a pattern (for advanced users).';
const STATUS_CHOICES = { approved: 'Approve', denied: 'Deny', considering: 'Under consideration' };
const STATUS_TEXT = { pending: 'open for votes', considering: 'under consideration', approved: 'approved', denied: 'denied' };

function openSuggestionsSection(ctx, open) {
    const canDecide = ctx.canEdit && ctx.canAct;
    if (!open.length) return html`<p class="muted">No open suggestions.</p>`;
    const blocks = open.map((row) => html`<details class="sub" data-key="suggestion-${row.id}"><summary>#${row.id} · ${clip(row.content, 80)} · ${row.upvotes ?? 0} up, ${row.downvotes ?? 0} down · ${STATUS_TEXT[row.status] || row.status}</summary>
<p class="value">${row.content}</p>
<p class="muted">By ${ctx.client?.users?.cache?.get?.(row.user_id)?.username || row.user_id}${row.created_at ? html` on ${formatDate(row.created_at)}` : ''}${row.channel_id ? html` in ${channelName(ctx.guild, row.channel_id)}` : ''}.</p>
${postForm(ctx, 'community', 'suggestion-status', html`<div class="grid">
${selectInput('status', 'approved', SUGGESTION_STATUSES.map((st) => [st, STATUS_CHOICES[st] || st]), { label: 'Decision' })}
${textArea('reason', row.status_reason || '', { label: 'Reason', max: SUGGESTION_REASON_MAX, rows: 2, help: 'Shown on the suggestion and sent to the member who made it.' })}</div>`,
        { submit: 'Send decision', hidden: { id: row.id }, canEdit: canDecide })}</details>`);
    return html`${open.length >= OPEN_SUGGESTIONS_SHOWN ? html`<p class="muted">Newest ${OPEN_SUGGESTIONS_SHOWN} shown.</p>` : ''}${blocks}
${canDecide ? '' : html`<p class="muted">To decide suggestions you need the Administrator permission in the main server.</p>`}`;
}

async function updateSettings(ctx, patch, message) {
    const before = ctx.services.getCommunitySettings(ctx.guildId);
    const after = await ctx.services.updateCommunitySettings(ctx.guildId, patch, ctx.actor.userId);
    const changes = diffSnapshots(before, after, Object.keys(patch), 'community.');
    return { changes, message: changes.length ? message : 'Nothing changed.' };
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
        const suggestions = postForm(ctx, 'community', 'suggestions', html`<div class="grid">${channelPicker(g, 'channelId', s.suggestionsChannelId, { label: 'Suggestions channel', perms: PERMS.post, noneLabel: 'off', help: 'Where new suggestions are posted for members to vote on.' })}</div>`);
        const starboard = html`${postForm(ctx, 'community', 'starboard', html`<div class="grid">
${channelPicker(g, 'channelId', s.starboardChannelId, { label: 'Starboard channel', perms: PERMS.post, optional: false, help: 'Where the popular messages are copied to.' })}
${textInput('emoji', s.starboardEmoji, { label: 'Emoji', max: 64, help: 'The reaction that counts, for example ⭐.' })}
${numberInput('threshold', s.starboardThreshold, { label: 'Reactions needed', min: 1, max: STARBOARD_MAX_THRESHOLD, help: 'How many of those reactions a message needs before it is copied.' })}</div>`, { submit: s.starboardChannelId ? 'Save' : 'Turn on' })}
${s.starboardChannelId ? buttonForm(ctx, 'community', 'starboard-off', 'Turn starboard off') : html`<p class="muted">Starboard is off.</p>`}`;
        const stickyRows = stickies.map((st) => [channelName(g, st.channelId), clip(st.content), buttonForm(ctx, 'community', 'sticky-remove', 'Remove', { channelId: st.channelId }, { confirm: 'Remove this sticky message?' })]);
        const stickyEdits = stickies.map((st) => html`<details class="sub" data-key="sticky-${st.channelId}"><summary>Edit the sticky in ${channelName(g, st.channelId)}</summary>
${postForm(ctx, 'community', 'sticky-set', textArea('content', st.content, { label: 'Sticky message', max: STICKY_MAX_LENGTH, rows: 3 }), { submit: 'Save sticky', hidden: { channelId: st.channelId } })}</details>`);
        const sticky = html`${table(['Channel', 'Message', ''], stickyRows, 'No sticky messages.')}${stickyEdits}
<h3>New sticky</h3>
${postForm(ctx, 'community', 'sticky-set', html`<div class="grid">${channelPicker(g, 'channelId', null, { label: 'Channel', perms: [...PERMS.post, 'ManageMessages'], optional: false, help: 'Mewvo needs the Manage Messages permission here to remove its old copy.' })}
${textArea('content', '', { label: 'Sticky message', max: STICKY_MAX_LENGTH, rows: 3, help: 'If the channel already has a sticky message, this replaces it.' })}</div>`, { submit: 'Set sticky' })}`;
        const tagRows = tags.map((t) => [html`<code>${t.name}</code>`, clip(t.content), t.triggerKind === 'none' ? '-' : `${t.triggerKind}: ${clip(t.trigger, 40)}`,
            buttonForm(ctx, 'community', 'tag-delete', 'Delete', { name: t.name }, { confirm: `Delete the tag "${t.name}"?` })]);
        const tagEdits = tags.map((t) => html`<details class="sub" data-key="tag-${t.name}"><summary>Edit <code>${t.name}</code></summary>
${postForm(ctx, 'community', 'tag-edit', html`<div class="grid">
${selectInput('triggerKind', t.triggerKind || 'none', TRIGGER_KINDS.map((k) => [k, k]), { label: 'Reply by itself', help: TRIGGER_HELP })}
${textInput('trigger', t.trigger || '', { label: 'Word or pattern', max: 200 })}
${numberInput('cooldownS', t.cooldownS ?? '', { label: 'Wait between replies (seconds)', min: 0, max: 86400, help: 'After replying in a channel, the tag waits this long before it replies there again.' })}
${channelPicker(g, 'allowChannels', t.allowChannels || [], { label: 'Only in these channels', kinds: ['text', 'category'], perms: PERMS.post, multiple: true, help: 'Pick none to allow every channel.' })}
${channelPicker(g, 'denyChannels', t.denyChannels || [], { label: 'Never in these channels', kinds: ['text', 'category'], perms: [], multiple: true })}
${textArea('content', t.content, { label: 'Text', max: TAG_CONTENT_MAX, rows: 3 })}</div>`, { submit: 'Save tag', hidden: { name: t.name } })}</details>`);
        const tagForms = html`${table(['Name', 'Content', 'Trigger', ''], tagRows, 'No tags.')}${tagEdits}
<h3>New tag</h3>
${postForm(ctx, 'community', 'tag-create', html`<div class="grid">${textInput('name', '', { label: 'Name', max: 32, help: 'Members post the tag with /tag show and this name. Small letters, numbers, - and _ only, like rules or how-to-join.' })}
${selectInput('triggerKind', 'none', TRIGGER_KINDS.map((k) => [k, k]), { label: 'Reply by itself', help: TRIGGER_HELP })}
${textInput('trigger', '', { label: 'Word or pattern', max: 200 })}
${numberInput('cooldownS', '', { label: 'Wait between replies (seconds)', min: 0, max: 86400, help: 'After replying in a channel, the tag waits this long before it replies there again. Leave empty for the default.' })}
${textArea('content', '', { label: 'Text', max: TAG_CONTENT_MAX, rows: 3 })}</div>`, { submit: 'Create tag' })}`;
        const feedRows = feeds.map((f) => [`#${f.id}`, html`<code>${f.sourceId}</code>`, channelName(g, f.channelId), clip(f.template || 'default message', 60),
            buttonForm(ctx, 'community', 'feed-remove', 'Remove', { id: f.id }, { confirm: 'Remove this feed?' })]);
        const feedForms = html`${table(['Feed', 'YouTube channel', 'Posts in', 'Message', ''], feedRows, 'No feeds.')}
${postForm(ctx, 'community', 'feed-add', html`<div class="grid">${textInput('source', '', { label: 'YouTube channel', max: 200, help: 'The link to the YouTube channel, or its channel ID (it starts with UC).' })}
${channelPicker(g, 'channelId', null, { label: 'Post in', perms: PERMS.post, optional: false, help: 'Where new videos are announced.' })}
${textArea('template', '', { label: 'Message', max: FEED_TEMPLATE_MAX, rows: 2, help: 'Leave empty for the default message. You can use {author} (the channel name), {title} (the video title) and {url} (the link to the video).' })}</div>`, { submit: 'Add feed' })}`;
        return html`${section('Suggestions', suggestions, 'Members share ideas with /suggest new in Discord. Each idea is posted in this channel, and members vote with the buttons under it.')}
${section(`Open suggestions (${openSuggestions.length})`, openSuggestionsSection(ctx, openSuggestions), 'Approving or denying ends the voting. The suggestion message is updated and the member who made it gets a private message (DM). You can also do this with /suggest status in Discord.', { key: 'open-suggestions' })}
${section('Starboard', starboard, 'When a message gets enough of one reaction, Mewvo copies it to the starboard channel, so the best moments are easy to find.')}${section('Sticky messages', sticky, 'A sticky message stays at the bottom of a channel. When members write, Mewvo posts it again under their messages, so rules or notes are always easy to see.')}${section('Tags', tagForms, 'Saved answers members can post with /tag show. A tag can also reply by itself when someone writes a certain word.')}${section('YouTube feeds', feedForms, 'Mewvo announces new videos from a YouTube channel. It checks every 15 minutes.')}`;
    },

    actions: {
        'suggestion-status': {
            admin: true,
            async run(ctx, form) {
                const id = intField(form, 'id', { min: 1, max: 2147483647, label: 'Suggestion' });
                const status = choiceField(form, 'status', SUGGESTION_STATUSES, 'Decision');
                const reason = multiline(form, 'reason', SUGGESTION_REASON_MAX + 1);
                if (reason.length > SUGGESTION_REASON_MAX) throw new InputError(`The reason is limited to ${SUGGESTION_REASON_MAX} characters.`, 400, 'reason');
                const before = await ctx.services.getSuggestion(ctx.guildId, id);
                if (!before) throw new InputError(`There is no suggestion #${id} in this server.`);
                const decided = await ctx.services.decideSuggestion({ client: ctx.client, guild: ctx.guild, suggestionId: id, status, reason, decidedBy: ctx.actor.userId });
                if (!decided) throw new InputError(`There is no suggestion #${id} in this server.`);
                const { row, edited, dmed } = decided;
                const warnings = [];
                if (!edited) warnings.push('The suggestion message could not be updated (deleted or no access).');
                if (!dmed) warnings.push('The author could not be DMed.');
                return {
                    changes: [{ key: `suggestion.${id}`, old: { status: before.status, reason: before.status_reason ?? null }, new: { status: row.status, reason: row.status_reason ?? null } }],
                    message: `Suggestion #${id}: ${STATUS_TEXT[row.status] || row.status}.${dmed ? ' The author was told by DM.' : ''}`,
                    warnings,
                };
            },
        },
        async suggestions(ctx, form) {
            const channelId = channelField(ctx.guild, form, 'channelId', { label: 'Suggestions channel' });
            return updateSettings(ctx, { suggestionsChannelId: channelId }, channelId ? 'Suggestions channel saved.' : 'Suggestions are off.');
        },
        async starboard(ctx, form) {
            const channelId = channelField(ctx.guild, form, 'channelId', { optional: false, label: 'Starboard channel' });
            const threshold = intField(form, 'threshold', { min: 1, max: STARBOARD_MAX_THRESHOLD, label: 'Reactions needed' });
            const patch = ctx.services.starboardSettingsPatch({ channelId, emoji: text(form, 'emoji', 64) || null, threshold });
            return updateSettings(ctx, patch, 'Starboard saved.');
        },
        async 'starboard-off'(ctx) {
            return updateSettings(ctx, { starboardChannelId: null }, 'Starboard is off. Existing starboard posts stay.');
        },
        async 'sticky-set'(ctx, form) {
            const channelId = channelField(ctx.guild, form, 'channelId', { optional: false, label: 'Channel' });
            const content = multiline(form, 'content', STICKY_MAX_LENGTH + 1);
            const before = ctx.services.listStickies(ctx.guildId).find((st) => st.channelId === channelId)?.content ?? null;
            const { posted } = await ctx.services.setSticky({ guildId: ctx.guildId, channel: ctx.guild.channels.cache.get(channelId), content, updatedBy: ctx.actor.userId });
            const result = { changes: before === content.trim() ? [] : [{ key: `sticky.${channelId}`, old: before, new: content.trim() }], message: 'Sticky message saved.' };
            if (!posted) result.warnings = ['It could not be posted right now (check my permissions there); it will be posted after the next message.'];
            return result;
        },
        async 'sticky-remove'(ctx, form) {
            const channelId = text(form, 'channelId', 25);
            const before = ctx.services.listStickies(ctx.guildId).find((st) => st.channelId === channelId);
            if (!before) throw new InputError('That channel has no sticky message.');
            await ctx.services.removeSticky({ channelId, channel: ctx.guild?.channels?.cache?.get(channelId) || null });
            return { changes: [{ key: `sticky.${channelId}`, old: before.content, new: null }], message: 'Sticky message removed.' };
        },
        async 'tag-create'(ctx, form) {
            const triggerKind = text(form, 'triggerKind', 10) || 'none';
            const tag = await ctx.services.createTag({
                guildId: ctx.guildId,
                name: text(form, 'name', 40),
                content: multiline(form, 'content', TAG_CONTENT_MAX + 1),
                triggerKind,
                trigger: triggerKind === 'none' ? null : text(form, 'trigger', 200),
                cooldownS: intField(form, 'cooldownS', { min: 0, max: 86400, label: 'Wait between replies', fallback: null }),
                createdBy: ctx.actor.userId,
            });
            return { changes: [{ key: `tag.${tag?.name}`, old: null, new: tag?.content ?? null }], message: `Tag "${tag?.name}" created.` };
        },
        async 'tag-edit'(ctx, form) {
            const name = text(form, 'name', 40).toLowerCase();
            const before = ctx.services.listTags(ctx.guildId).find((t) => t.name === name);
            if (!before) throw new InputError('There is no such tag.');
            const triggerKind = choiceField(form, 'triggerKind', TRIGGER_KINDS, 'Trigger');
            const content = multiline(form, 'content', TAG_CONTENT_MAX + 1);
            if (!content) throw new InputError('The tag text cannot be empty.');
            const next = {
                content,
                triggerKind,
                trigger: triggerKind === 'none' ? null : text(form, 'trigger', 200),
                cooldownS: intField(form, 'cooldownS', { min: 0, max: 86400, label: 'Wait between replies', fallback: before.cooldownS ?? null }),
                allowChannels: channelListField(ctx.guild, form, 'allowChannels', { label: 'Only in these channels' }),
                denyChannels: channelListField(ctx.guild, form, 'denyChannels', { label: 'Never in these channels' }),
            };
            const current = { content: before.content, triggerKind: before.triggerKind || 'none', trigger: before.trigger ?? null, cooldownS: before.cooldownS ?? null, allowChannels: before.allowChannels || [], denyChannels: before.denyChannels || [] };
            const changed = Object.fromEntries(Object.entries(next).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(current[k])));
            if (!Object.keys(changed).length) return { changes: [], message: 'Nothing changed.' };
            // A trigger change always sends the kind with it (the service validates the pair).
            if (Object.hasOwn(changed, 'trigger') || Object.hasOwn(changed, 'triggerKind')) Object.assign(changed, { triggerKind, trigger: next.trigger });
            const tag = await ctx.services.editTag({ guildId: ctx.guildId, name, ...changed });
            if (!tag) throw new InputError('There is no such tag.');
            return {
                changes: Object.keys(changed).map((key) => ({ key: `tag.${name}.${key}`, old: current[key] ?? null, new: next[key] ?? null })),
                message: `Tag "${name}" saved.`,
            };
        },
        async 'tag-delete'(ctx, form) {
            const name = text(form, 'name', 40).toLowerCase();
            const before = ctx.services.listTags(ctx.guildId).find((t) => t.name === name);
            const removed = await ctx.services.deleteTag(ctx.guildId, name);
            if (!removed) throw new InputError('There is no such tag.');
            return { changes: [{ key: `tag.${name}`, old: before?.content ?? null, new: null }], message: `Tag "${name}" deleted.` };
        },
        async 'feed-add'(ctx, form) {
            const channelId = channelField(ctx.guild, form, 'channelId', { optional: false, label: 'Post in' });
            const { feed } = await ctx.services.addFeed({
                guildId: ctx.guildId, sourceInput: text(form, 'source', 200), channelId,
                template: multiline(form, 'template', FEED_TEMPLATE_MAX + 1) || null, createdBy: ctx.actor.userId,
            });
            return { changes: [{ key: `feed.${feed.id}`, old: null, new: { source: feed.sourceId, channelId } }], message: `Feed #${feed.id} added.` };
        },
        async 'feed-remove'(ctx, form) {
            const id = intField(form, 'id', { min: 1, max: 2147483647, label: 'Feed' });
            const before = ctx.services.listFeeds(ctx.guildId).find((f) => f.id === id);
            const removed = await ctx.services.removeFeed(ctx.guildId, id);
            if (!removed) throw new InputError(`There is no feed #${id}.`);
            return { changes: [{ key: `feed.${id}`, old: before ? { source: before.sourceId, channelId: before.channelId } : null, new: null }], message: `Feed #${id} removed.` };
        },
    },
};

