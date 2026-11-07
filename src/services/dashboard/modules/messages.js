// messages.js — Messages: post as the bot from the web. A message and/or embed (replaces
// /embedbuilder), a poll (/poll create: a native Discord poll, or the reaction poll when
// "anonymous" is on), ending a native poll early (/poll end) and a countdown (/countdown). Everything goes
// through services/botMessageService.js, the same functions /poll and /countdown use:
// allowedMentions { parse: [] } (typed text never pings) and the bot's permissions in
// the channel are checked before anything is posted. Administrator only.
//
// Scheduled and recurring messages (services/scheduledMessageService.js): the same text
// and/or embed, posted later by the once-a-minute cron with postBotMessage, once, on
// chosen weekdays at a time, or every N hours, in an IANA time zone.
//
// Templates (config/messageTemplates.js): "Start from a template" is a plain GET form
// (?template=<id>, no script: CSP). The chosen template fills the Send and Schedule forms
// (box title, box text, colour, {server} = the server name); nothing is posted until the
// admin presses Post or Schedule, so posting goes through the same checks as typed text.

import { html, path, raw, timeTag } from '../html.js';
import { fillTemplate, messageTemplate, templatesByGroup } from '../../../config/messageTemplates.js';
import {
    InputError, PERMS, boolField, buttonForm, channelField, channelName, channelPicker, channelWarnings, checkbox, missingChannelPerms, checkboxInput, choiceField, intField, numberInput,
    isSnowflake, pill, postForm, selectInput, switchInput, text, textArea, textInput,
} from '../forms.js';
import { section, table } from './common.js';
import { planLimit } from '../../billing/premiumEffects.js';
import { DEFAULT_TIMEZONE, canonicalTimeZone } from '../../../utils/timezone.js';
import {
    INTERVAL_MAX_HOURS, FAILURE_LIMIT, WEEKDAYS, cleanSchedule, describeSchedule, formatInZone, nextRunAfter, zonedParts,
} from '../../scheduledMessageService.js';
import {
    COUNTDOWN_MAX_SECONDS, COUNTDOWN_TITLE_MAX, EMBED_COLOURS, EMBED_DESCRIPTION_MAX, EMBED_FOOTER_MAX, EMBED_TITLE_MAX, EMBED_TOTAL_MAX,
    IMAGE_URL_MAX, MESSAGE_CONTENT_MAX, NATIVE_POLL_ANSWER_MAX, NATIVE_POLL_DEFAULT_HOURS, NATIVE_POLL_MAX_HOURS, NATIVE_POLL_MIN_HOURS, NATIVE_POLL_QUESTION_MAX,
    POLL_MAX_OPTIONS, POLL_OPTION_MAX, POLL_QUESTION_MAX, buildMessageEmbed, colourFromKey, isEmbedImageUrl, noMentions, parseHexColour, parseMessageLink,
} from '../../botMessageService.js';

const NO_PINGS = 'Mentions show as names but never ping anyone. @everyone, @here, roles and members get no notification.';

/** A textarea value: line breaks normalised, trimmed, refused (not cut) over `max`. */
function longText(form, name, max, label) {
    const value = typeof form?.[name] === 'string' ? form[name].replace(/\r\n?/g, '\n').trim() : '';
    if (value.length > max) throw new InputError(`${label}: at most ${max} characters (you wrote ${value.length}).`, 400, name);
    return value;
}

/**
 * The chosen channel, refused when the bot lacks one of `perms` there (nothing is posted). The
 * refusal carries `fix` so the page shows a Fix permissions link next to it.
 */
function postChannel(guild, form, perms) {
    const channelId = channelField(guild, form, 'channelId', { optional: false, label: 'Channel' });
    const problems = channelWarnings(guild, channelId, perms);
    if (problems.length) {
        const lacks = missingChannelPerms(guild, guild.channels.cache.get(channelId), perms) || [];
        throw Object.assign(new InputError(`Channel: ${problems.join('; ')}. Nothing was posted.`, 400, 'channelId'), lacks.length ? { fix: { channelId, perms: lacks } } : {});
    }
    return guild.channels.cache.get(channelId);
}

/** The embed colour: a hex code when typed, else one of the fixed choices. */
function colourField(form) {
    const hex = text(form, 'hex', 7);
    if (hex) {
        const value = parseHexColour(hex);
        if (value === null) throw new InputError('Colour: write a colour code like #9B59B6, or leave it empty and pick from the list.', 400, 'hex');
        return value;
    }
    const key = text(form, 'colour', 20) || 'primary';
    const value = colourFromKey(key);
    if (value === null) throw new InputError('Colour: unknown choice.', 400, 'colour');
    return value;
}

/** Poll options: one per line, blank lines ignored; each at most `max` characters. */
function pollOptions(form, max = POLL_OPTION_MAX) {
    const options = longText(form, 'options', POLL_MAX_OPTIONS * (POLL_OPTION_MAX + 2), 'Options').split('\n').map((o) => o.trim()).filter(Boolean);
    if (options.length < 2) throw new InputError('Options: a poll needs at least 2 options, each on its own line.', 400, 'options');
    if (options.length > POLL_MAX_OPTIONS) throw new InputError(`Options: a poll can have at most ${POLL_MAX_OPTIONS} options (you wrote ${options.length}).`, 400, 'options');
    const long = options.find((o) => o.length > max);
    if (long) {
        const why = max === NATIVE_POLL_ANSWER_MAX ? ' in a Discord poll. Shorten it, or turn on Anonymous poll (up to 100 characters)' : '';
        throw new InputError(`Options: each option is limited to ${max} characters${why}. "${long.slice(0, 20)}..." has ${long.length}.`, 400, 'options');
    }
    return options;
}

/** The "Send a message" fields, prefilled from a stored payload (or empty). */
function messageFields(g, { channelId = null, payload = null } = {}) {
    const e = payload?.embed || {};
    const hex = Number.isInteger(e.colour) ? `#${e.colour.toString(16).padStart(6, '0').toUpperCase()}` : '';
    const known = hex ? EMBED_COLOURS.find(([, , h]) => h.toUpperCase() === hex) : EMBED_COLOURS[0];
    // A plain message needs no Embed Links; with a box filled in, the post itself checks it.
    return html`${channelPicker(g, 'channelId', channelId, { label: 'Channel', perms: PERMS.text, optional: false })}
${textArea('content', payload?.content || '', { label: 'Message text', max: MESSAGE_CONTENT_MAX, rows: 4, help: `The normal text of the message. You can leave it empty if you fill in the box below. ${NO_PINGS}` })}
${textInput('title', e.title || '', { label: 'Box title', max: EMBED_TITLE_MAX, help: 'An embed is a message box with a coloured edge, a bold title and text. Fill in these fields to send one. Leave them empty for a plain message.' })}
${textArea('description', e.description || '', { label: 'Box text', max: EMBED_DESCRIPTION_MAX, rows: 6, help: `The main text inside the box. Discord formatting works, like **bold**. Title, text and footer together can be at most ${EMBED_TOTAL_MAX} characters.` })}
${selectInput('colour', known ? known[0] : 'primary', EMBED_COLOURS.map(([key, label, h]) => [key, `${label} (${h})`]), { label: 'Box colour' })}
${textInput('hex', known ? '' : hex, { label: 'Or a colour code', max: 7, placeholder: '#9B59B6', help: 'A # and six letters or numbers. When filled in, it is used instead of the colour above.' })}
${textInput('imageUrl', e.imageUrl || '', { label: 'Image link', max: IMAGE_URL_MAX, type: 'url', placeholder: 'https://…', help: 'Optional. A link that starts with https:// and opens a picture. It shows large in the box.' })}
${textInput('footer', e.footer || '', { label: 'Box footer', max: EMBED_FOOTER_MAX, help: 'Optional small text at the bottom of the box.' })}`;
}

/**
 * The posted message: { channel, content, embed (with colour) | null, audit }. Refuses an
 * empty message, a footer-only embed, a non-https image and a channel the bot cannot post in.
 */
function messageFromForm(g, form) {
    const content = longText(form, 'content', MESSAGE_CONTENT_MAX, 'Message text');
    const embed = {
        title: text(form, 'title', EMBED_TITLE_MAX),
        description: longText(form, 'description', EMBED_DESCRIPTION_MAX, 'Embed description'),
        imageUrl: text(form, 'imageUrl', IMAGE_URL_MAX),
        footer: text(form, 'footer', EMBED_FOOTER_MAX),
    };
    if (embed.imageUrl && !isEmbedImageUrl(embed.imageUrl)) {
        throw new InputError('Image link: it must start with https://. Other kinds of links are not accepted.', 400, 'imageUrl');
    }
    const hasEmbed = Boolean(embed.title || embed.description || embed.imageUrl || embed.footer);
    // Embed Links only when a box is sent: plain text needs View Channel + Send Messages.
    const channel = postChannel(g, form, hasEmbed ? PERMS.post : PERMS.text);
    if (!content && !hasEmbed) throw new InputError('There is nothing to post. Write a message or fill in the box.', 400, 'content');
    if (hasEmbed && !embed.title && !embed.description && !embed.imageUrl) {
        throw new InputError('Box: add a title, text or an image. A footer on its own is not shown.', 400, 'title');
    }
    if (embed.title.length + embed.description.length + embed.footer.length > EMBED_TOTAL_MAX) {
        throw new InputError(`Box: title, text and footer together can be at most ${EMBED_TOTAL_MAX} characters.`, 400, 'description');
    }
    const colour = colourField(form);
    return {
        channel, content, embed: hasEmbed ? { ...embed, colour } : null,
        audit: { channelId: channel.id, content: content || null, embed: hasEmbed ? { ...embed, colour: `#${colour.toString(16).padStart(6, '0')}` } : null },
    };
}

// ── Templates ─────────────────────────────────────────────────────────────

/**
 * The template asked for in ?template=, filled for this server: { template, payload } or
 * null. An unknown id gives { unknown: true } so the page can say so (nothing is filled).
 */
export function chosenTemplate(query, serverName) {
    const id = typeof query?.template === 'string' ? query.template.trim().slice(0, 60) : '';
    if (!id) return null;
    const template = messageTemplate(id);
    if (!template) return { unknown: true };
    const filled = fillTemplate(template, { server: serverName });
    return { template, payload: { content: '', embed: { title: filled.title, description: filled.text, colour: colourFromKey(filled.colour) } } };
}

/** The grouped template list (a GET form, no script) and, when one is chosen, what to do next. */
function templatePicker(chosen) {
    const current = chosen?.template?.id || '';
    const note = chosen?.unknown
        ? html`<p class="warn">That template does not exist (any more). Pick one from the list.</p>`
        : chosen ? html`<p class="ok">Template "${chosen.template.name}" is filled in below, in Send a message and in Schedule a message. Replace the parts in [square brackets], check the text, then post or schedule it. Nothing is posted until you press the button.</p>` : '';
    return html`${note}<form method="get" action="${path('/messages')}#s-send-a-message" class="settings-form"><div class="grid">
<label>Template<select name="template">${templatesByGroup().map((g) => html`<optgroup label="${g.label}">${g.templates.map((t) => html`<option value="${t.id}"${t.id === current ? raw(' selected') : ''}>${t.name}</option>`)}</optgroup>`)}</select><span class="hint">Ready-made texts for common announcements. Where a text names the server, this server's name is filled in. Parts in [square brackets] are for you to fill in.</span></label></div>
<div class="form-actions"><button type="submit" class="secondary">Use this template</button></div></form>`;
}

// ── Scheduling ────────────────────────────────────────────────────────────

const REPEATS = [['once', 'Once'], ['daily', 'Every day'], ['weekdays', 'On chosen weekdays'], ['hours', 'Every few hours']];
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const pad = (n) => String(n).padStart(2, '0');

let zoneNames = null;
function timeZoneList() {
    if (!zoneNames) {
        const supported = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
        zoneNames = ['UTC', ...supported.filter((z) => z !== 'UTC')];
    }
    return zoneNames;
}

/** The repeat choice of a stored schedule. */
function repeatOf(schedule) {
    if (!schedule) return 'once';
    if (schedule.kind === 'interval') return 'hours';
    if (schedule.kind === 'weekly') return (schedule.days || []).length === 7 ? 'daily' : 'weekdays';
    return 'once';
}

/** The schedule fields, prefilled from a stored message or with "next full hour today". */
function scheduleFields(row, defaultZone, now = Date.now()) {
    const zone = row?.timezone || defaultZone;
    const p = zonedParts(now + 60 * 60 * 1000, canonicalTimeZone(zone) || 'UTC');
    const s = row?.schedule || {};
    const date = s.date || `${p.year}-${pad(p.month)}-${pad(p.day)}`;
    const time = s.time || `${pad(p.hour)}:00`;
    const days = new Set(s.kind === 'weekly' ? s.days : [1, 2, 3, 4, 5]);
    return html`<div class="grid">
${selectInput('repeat', repeatOf(row?.schedule), REPEATS, { label: 'Repeat' })}
${textInput('date', date, { label: 'Date', max: 10, type: 'date', help: 'For Once, the day it is posted. For Every few hours, the day of the first post.' })}
${textInput('time', time, { label: 'Time (24-hour clock)', max: 5, type: 'time' })}
${numberInput('hours', s.hours || 24, { label: 'Hours between posts', min: 1, max: INTERVAL_MAX_HOURS, help: `Only for Every few hours. From 1 to ${INTERVAL_MAX_HOURS}.` })}
<label>Time zone<input type="text" name="timezone" value="${zone}" maxlength="64" list="tz-zones" autocomplete="off"><span class="hint">Region and city, like Europe/Vilnius, or UTC. Summer and winter time changes are handled for you.</span></label>
</div><fieldset class="weekdays"><legend>Weekdays (only for On chosen weekdays)</legend>${DAY_ORDER.map((d) => checkboxInput(`day${d}`, days.has(d), { label: WEEKDAYS[d] }))}</fieldset>`;
}

/** { schedule, timezone } from the posted form; refused when invalid or (from now) never runs. */
function scheduleFromForm(form, now = Date.now()) {
    const repeat = choiceField(form, 'repeat', REPEATS.map(([key]) => key), 'Repeat');
    const timezone = canonicalTimeZone(text(form, 'timezone', 64) || DEFAULT_TIMEZONE);
    if (!timezone) throw new InputError('Time zone: that time zone is not known. Write region and city, like Europe/London, or UTC.', 400, 'timezone');
    const date = text(form, 'date', 10);
    const time = text(form, 'time', 8).slice(0, 5);
    const input = repeat === 'once' ? { kind: 'once', date, time }
        : repeat === 'daily' ? { kind: 'weekly', time, days: [0, 1, 2, 3, 4, 5, 6] }
            : repeat === 'weekdays' ? { kind: 'weekly', time, days: [0, 1, 2, 3, 4, 5, 6].filter((d) => checkbox(form, `day${d}`)) }
                : { kind: 'interval', date, time, hours: intField(form, 'hours', { min: 1, max: INTERVAL_MAX_HOURS, label: 'Hours between posts' }) };
    let schedule;
    try {
        schedule = cleanSchedule(input);
    } catch (error) {
        const message = error.userMessage || error.message;
        const field = /^Date/.test(message) ? 'date' : /^Time/.test(message) ? 'time' : /^Days/.test(message) ? 'day1' : 'repeat';
        throw new InputError(message, 400, field);
    }
    if (nextRunAfter(schedule, timezone, now) === null) throw new InputError('That time has already passed. Pick a time in the future.', 400, 'date');
    return { schedule, timezone };
}

function idField(form) {
    return intField(form, 'id', { min: 1, max: 2147483647, label: 'Scheduled message' });
}

function findScheduled(list, id) {
    const row = list.find((m) => m.id === id);
    if (!row) throw new InputError(`There is no scheduled message #${id}.`);
    return row;
}

const auditOf = (m) => (m ? { channelId: m.channelId, schedule: m.schedule, timezone: m.timezone, paused: m.paused, payload: m.payload } : null);

function statusPill(m) {
    if (m.paused) return pill(false, 'paused', 'warn');
    if (m.nextRunAt === null) return pill(false, 'done', 'off');
    return pill(true, 'active');
}

function lastResult(m) {
    if (m.lastError) {
        return html`<span class="warn">${m.lastError}</span>${m.failureCount ? html` <span class="muted">(${m.failureCount} of ${FAILURE_LIMIT} failures)</span>` : ''}${m.lastRunAt ? html` <span class="muted">${timeTag(m.lastRunAt)}</span>` : ''}`;
    }
    if (m.lastRunAt) return html`Posted ${timeTag(m.lastRunAt)}`;
    return html`<span class="muted">Not run yet</span>`;
}

/** How the message will look: the text as typed and the embed parts, plain (no colours from the message: CSP). */
export function messagePreview(payload) {
    const e = payload?.embed;
    return html`<div class="msg-preview"><p class="muted">Preview</p>${payload?.content ? html`<p class="msg-text">${payload.content}</p>` : ''}${e && (e.title || e.description || e.imageUrl || e.footer)
        ? html`<div class="msg-embed">${e.title ? html`<p><b>${e.title}</b></p>` : ''}${e.description ? html`<p class="msg-text">${e.description}</p>` : ''}${e.imageUrl ? html`<p class="muted">Image: ${e.imageUrl}</p>` : ''}${e.footer ? html`<p class="muted">${e.footer}</p>` : ''}</div>` : ''}
<p class="muted">Shown as you typed it. Discord turns **bold**, links and mentions into formatting when it posts. Mentions never ping.</p></div>`;
}

/** The next `count` times a scheduled message posts, in its own time zone. Pure. */
export function upcomingRuns(m, count = 3) {
    if (m.paused || m.nextRunAt === null || m.nextRunAt === undefined) return [];
    const out = [Number(new Date(m.nextRunAt))];
    while (out.length < count) {
        const next = nextRunAfter(m.schedule, m.timezone, out[out.length - 1]);
        if (next === null || next === undefined || next <= out[out.length - 1]) break;
        out.push(next);
    }
    return out;
}

/** DMs a scheduled message to the admin who asked (Send me a test). Refuses with a readable message. */
async function sendScheduledTest(client, userId, payload) {
    const text = String(payload?.content || '').trim();
    const embed = payload?.embed && (payload.embed.title || payload.embed.description || payload.embed.imageUrl || payload.embed.footer) ? buildMessageEmbed(payload.embed) : null;
    if (!text && !embed) throw new InputError('This message is empty, so there is nothing to send.');
    const user = await client.users.fetch(userId).catch(() => null);
    if (!user) throw new InputError('Mewvo could not find your Discord account.');
    try {
        await user.send({ ...(text ? { content: text } : {}), ...(embed ? { embeds: [embed] } : {}), allowedMentions: noMentions() });
    } catch {
        throw new InputError('Your private messages (DMs) are closed for Mewvo, so the test could not be sent. In Discord, allow direct messages from server members and try again.');
    }
}

function preview(payload) {
    const textPart = payload?.content || payload?.embed?.title || payload?.embed?.description || '(image)';
    return textPart.length > 80 ? `${textPart.slice(0, 79)}…` : textPart;
}

function scheduledSection(ctx, list, defaultZone) {
    const g = ctx.guild;
    const can = ctx.canEdit && ctx.canAct;
    const rows = list.map((m) => [
        html`<a href="#edit-${m.id}">#${m.id}</a> <span class="muted">${preview(m.payload)}</span>`,
        channelName(g, m.channelId),
        m.nextRunAt === null ? html`<span class="muted">-</span>` : html`${formatInZone(m.nextRunAt, m.timezone)} <span class="muted">${m.timezone}</span>`,
        describeSchedule(m.schedule),
        lastResult(m),
        statusPill(m),
        html`<div class="row-actions">${m.paused
            ? buttonForm(ctx, 'messages', 'schedule-pause', 'Resume', { id: m.id, paused: 'false' }, { canEdit: can })
            : m.nextRunAt === null ? '' : buttonForm(ctx, 'messages', 'schedule-pause', 'Pause', { id: m.id, paused: 'true' }, { canEdit: can })}
${buttonForm(ctx, 'messages', 'schedule-run', 'Run now', { id: m.id }, { canEdit: can, danger: false, confirm: 'Post this message now?' })}
${buttonForm(ctx, 'messages', 'schedule-delete', 'Delete', { id: m.id }, { canEdit: can, confirm: `Delete scheduled message #${m.id}? This cannot be undone.` })}</div>`,
    ]);
    const edits = list.map((m) => html`<details class="sub" id="edit-${m.id}" data-key="scheduled-${m.id}"><summary>Preview and edit #${m.id} · ${describeSchedule(m.schedule)}</summary>
${messagePreview(m.payload)}
<p>${upcomingRuns(m).length ? html`Next posts: ${upcomingRuns(m).map((ms, i) => html`${i ? ', ' : ''}${formatInZone(ms, m.timezone)}`)} <span class="muted">(${m.timezone})</span>` : html`<span class="muted">${m.paused ? 'Paused: it will not post until you resume it.' : 'It will not post again.'}</span>`}</p>
${buttonForm(ctx, 'messages', 'schedule-test', 'Send me a test', { id: m.id }, { canEdit: can, danger: false })} <span class="muted">Sends it only to you as a private message (DM), so you can check it before it posts.</span>
${postForm(ctx, 'messages', 'schedule-edit', html`<div class="grid">${messageFields(g, m)}</div>${scheduleFields(m, defaultZone)}`, { submit: 'Save scheduled message', hidden: { id: m.id }, canEdit: can })}</details>`);
    return html`<p>${list.length} of ${planLimit(ctx.guildId, 'scheduled')} scheduled messages.</p>
${table(['Message', 'Channel', 'Next run', 'Repeat', 'Last result', 'Status', ''], rows, 'No scheduled messages.')}${edits}`;
}

/** "End a poll": Mewvo's open Discord polls (pollList.js), an End button each. */
function openPollList(ctx, openPolls, canPost) {
    if (openPolls === null) return html`<p class="warn">The open polls could not be loaded. You can still end a poll by its link below.</p>`;
    const polls = openPolls?.polls || [];
    const rows = polls.map((p) => [
        p.question || html`<span class="muted">(no question)</span>`,
        html`#${p.channelName}`,
        p.endsAt ? timeTag(p.endsAt) : html`<span class="muted">-</span>`,
        buttonForm(ctx, 'messages', 'poll-end', 'End poll', { channelId: p.channelId, messageId: p.messageId },
            { canEdit: canPost, confirm: 'End this poll now? The final results are shown and nobody can vote any more.' }),
    ]);
    return html`${table(['Question', 'Channel', 'Closes', ''], rows, 'Mewvo has no open polls in this server.')}
<p class="muted">Lists polls posted from the dashboard in the last 7 days and polls posted with /poll since Mewvo last restarted.${openPolls?.partial ? ' The dashboard history could not be read just now, so some polls may be missing.' : ''}</p>`;
}

function clock(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return [h ? `${h} h` : '', m ? `${m} min` : '', s ? `${s} s` : ''].filter(Boolean).join(' ');
}

export default {
    key: 'messages',
    label: 'Messages',
    help: 'Post a message as Mewvo: an announcement right now or later, a message that repeats, a poll, or a countdown. Text you type here never pings anyone. Everything here needs the Administrator permission in this server.',

    async load(ctx) {
        const [config, scheduled] = await Promise.all([
            ctx.services.getGuildConfig(ctx.client, ctx.guildId),
            ctx.services.listScheduledMessages(ctx.guildId),
        ]);
        // Mewvo's open Discord polls for "End a poll" (pollList.js); null = could not be loaded.
        const openPolls = typeof ctx.services.openPollsFor === 'function'
            ? await ctx.services.openPollsFor(ctx.guild, ctx.guildId).catch(() => null)
            : { polls: [], partial: false };
        return { scheduled, timezone: canonicalTimeZone(config?.birthdayTimezone) || DEFAULT_TIMEZONE, openPolls };
    },

    render(ctx, data = {}) {
        const g = ctx.guild;
        const scheduled = data.scheduled || [];
        const canPost = ctx.canEdit && ctx.canAct;
        const adminNote = ctx.canAct ? '' : ' To post you need the Administrator permission in this server.';
        const chosen = chosenTemplate(ctx.query, g?.name);
        const prefill = chosen?.payload ? { payload: chosen.payload } : {};
        const send = postForm(ctx, 'messages', 'send', html`<div class="grid">${messageFields(g, prefill)}</div>`, { submit: 'Post message', canEdit: canPost });
        const schedule = postForm(ctx, 'messages', 'schedule', html`<div class="grid">${messageFields(g, prefill)}</div>${scheduleFields(null, data.timezone || DEFAULT_TIMEZONE)}`,
            { submit: 'Schedule message', canEdit: canPost });
        const poll = postForm(ctx, 'messages', 'poll', html`<div class="grid">
${channelPicker(g, 'channelId', null, { label: 'Channel', perms: PERMS.nativePoll, optional: false })}
${textInput('question', '', { label: 'Question', max: NATIVE_POLL_QUESTION_MAX })}
${textArea('options', '', { label: 'Options', max: POLL_MAX_OPTIONS * (POLL_OPTION_MAX + 2), rows: 5, help: `The answers members can vote for, each on its own line. From 2 to ${POLL_MAX_OPTIONS}, each up to ${NATIVE_POLL_ANSWER_MAX} characters (up to ${POLL_OPTION_MAX} for an anonymous poll).` })}
${numberInput('hours', NATIVE_POLL_DEFAULT_HOURS, { label: 'Open for (hours)', min: NATIVE_POLL_MIN_HOURS, max: NATIVE_POLL_MAX_HOURS, help: `From ${NATIVE_POLL_MIN_HOURS} to ${NATIVE_POLL_MAX_HOURS} hours (7 days). Discord closes the poll and shows the results when the time is up.` })}
${switchInput('multiSelect', false, { label: 'Allow more than one answer', help: 'Members can pick several options instead of one.' })}
${switchInput('anonymous', false, { label: 'Anonymous poll', help: 'A Discord poll shows everyone who voted for what. Turn this on to post a number-reaction poll instead: no names on the poll itself, but anyone can still open the reactions and see who reacted. It has no time limit, cannot be ended early, and ignores the two settings above.' })}</div>`,
        { submit: 'Post poll', canEdit: canPost });
        const endPollForm = html`${openPollList(ctx, data.openPolls, canPost)}
<details class="sub" data-key="poll-end-link"><summary>A poll is not in the list? End it by its link</summary>
${postForm(ctx, 'messages', 'poll-end', html`<div class="grid">
${textInput('link', '', { label: 'Poll message link', max: 200, type: 'url', placeholder: 'https://discord.com/channels/...', help: 'In Discord, right-click the poll (or long-press it on a phone), choose Copy Message Link and paste it here.' })}</div>`,
        { submit: 'End poll now', canEdit: canPost })}</details>`;
        const countdown = postForm(ctx, 'messages', 'countdown', html`<div class="grid">
${channelPicker(g, 'channelId', null, { label: 'Channel', perms: PERMS.post, optional: false })}
${textInput('title', '', { label: 'Title', max: COUNTDOWN_TITLE_MAX, placeholder: 'Countdown', help: 'What you are counting down to.' })}
${numberInput('minutes', 5, { label: 'Minutes', min: 0, max: 1440, help: 'From 0 to 1440 (24 hours).' })}
${numberInput('seconds', 0, { label: 'Seconds', min: 0, max: 59, help: 'From 0 to 59.' })}</div>`,
        { submit: 'Start countdown', canEdit: canPost });
        return html`${section('Start from a template', templatePicker(chosen), 'Pick a ready-made announcement, like how to appeal or a scam warning. It fills in the forms below so you can edit it before posting.')}
${section('Send a message', send, `Mewvo posts your text, your box, or both in the channel right away.${adminNote}`)}
${section('Schedule a message', schedule, `Write a message now and let Mewvo post it later: once, every day, on the weekdays you choose, or every few hours. If posting fails ${FAILURE_LIMIT} times in a row, for example because Mewvo lost access to the channel, it is paused and staff are told in the alerts channel. A server can have up to ${planLimit(ctx.guildId, 'scheduled')}, depending on the server owner's plan.${adminNote}`)}
${section('Scheduled messages', scheduledSection(ctx, scheduled, data.timezone || DEFAULT_TIMEZONE), 'The next post time is shown in each message\'s own time zone.')}
<datalist id="tz-zones">${timeZoneList().map((z) => html`<option value="${z}"></option>`)}</datalist>
${section('Start a poll', poll, `Ask members a question and let them vote with a Discord poll. Mewvo needs the Send Polls permission in the channel (Add Reactions for an anonymous poll).${adminNote}`)}
${section('End a poll', endPollForm, `Closes one of Mewvo's Discord polls now, before its time is up, and shows the final results. Discord only lets Mewvo end polls it posted itself.${adminNote}`)}
${section('Start a countdown', countdown, `Posts a timer that counts down in the channel, for up to 24 hours. Administrators get Pause and Cancel buttons on it. If the bot restarts, running countdowns stop.${adminNote}`)}`;
    },

    actions: {
        send: {
            admin: true,
            async run(ctx, form) {
                const g = ctx.guild;
                const { channel, content, embed, audit } = messageFromForm(g, form);
                const { message } = await ctx.services.postBotMessage(g, { channel, content, embed });
                return {
                    changes: [{ key: `message.${message.id}`, old: null, new: audit }],
                    message: `Posted in #${channel.name}.`,
                };
            },
        },
        schedule: {
            admin: true,
            async run(ctx, form) {
                const { channel, content, embed } = messageFromForm(ctx.guild, form);
                const { schedule, timezone } = scheduleFromForm(form);
                const row = await ctx.services.createScheduledMessage({
                    guildId: ctx.guildId, channelId: channel.id, payload: { content, embed }, schedule, timezone, createdBy: ctx.actor.userId,
                });
                return {
                    changes: [{ key: `scheduled.${row.id}`, old: null, new: auditOf(row) }],
                    message: `Scheduled message #${row.id} saved for #${channel.name}: ${describeSchedule(row.schedule)} (${row.timezone}). First post ${formatInZone(row.nextRunAt, row.timezone)}.`,
                };
            },
        },
        'schedule-edit': {
            admin: true,
            async run(ctx, form) {
                const id = idField(form);
                findScheduled(await ctx.services.listScheduledMessages(ctx.guildId), id);
                const { channel, content, embed } = messageFromForm(ctx.guild, form);
                const { schedule, timezone } = scheduleFromForm(form);
                const { before, after } = await ctx.services.updateScheduledMessage(ctx.guildId, id, { channelId: channel.id, payload: { content, embed }, schedule, timezone });
                return {
                    changes: [{ key: `scheduled.${id}`, old: auditOf(before), new: auditOf(after) }],
                    message: `Scheduled message #${id} saved. Next post ${after.paused ? 'when resumed' : `${formatInZone(after.nextRunAt, after.timezone)} (${after.timezone})`}.`,
                };
            },
        },
        'schedule-pause': {
            admin: true,
            async run(ctx, form) {
                const id = idField(form);
                const paused = boolField(form, 'paused', 'Paused');
                const current = findScheduled(await ctx.services.listScheduledMessages(ctx.guildId), id);
                if (current.paused === paused) return { changes: [], message: `Scheduled message #${id} is already ${paused ? 'paused' : 'running'}.` };
                const { before, after } = await ctx.services.setScheduledMessagePaused(ctx.guildId, id, paused);
                return {
                    changes: [{ key: `scheduled.${id}.paused`, old: before.paused, new: after.paused }],
                    message: paused ? `Scheduled message #${id} paused.` : `Scheduled message #${id} resumed. Next post ${formatInZone(after.nextRunAt, after.timezone)} (${after.timezone}).`,
                };
            },
        },
        'schedule-run': {
            admin: true,
            async run(ctx, form) {
                const id = idField(form);
                findScheduled(await ctx.services.listScheduledMessages(ctx.guildId), id);
                const { message, channel } = await ctx.services.runScheduledMessageNow(ctx.guild, id);
                return {
                    changes: [{ key: `scheduled.${id}.run`, old: null, new: { messageId: message?.id || null, channelId: channel.id } }],
                    message: `Scheduled message #${id} posted in #${channel.name}.`,
                };
            },
        },
        'schedule-test': {
            admin: true,
            async run(ctx, form) {
                const id = idField(form);
                const row = findScheduled(await ctx.services.listScheduledMessages(ctx.guildId), id);
                await (ctx.services.sendScheduledTest || sendScheduledTest)(ctx.client, ctx.actor.userId, row.payload);
                return {
                    changes: [{ key: `scheduled.${id}.test`, old: null, new: 'sent to their own DMs' }],
                    message: `Scheduled message #${id} was sent to your DMs as a test. Nothing was posted in the server.`,
                };
            },
        },
        'schedule-delete': {
            admin: true,
            async run(ctx, form) {
                const id = idField(form);
                findScheduled(await ctx.services.listScheduledMessages(ctx.guildId), id);
                const before = await ctx.services.deleteScheduledMessage(ctx.guildId, id);
                if (!before) throw new InputError(`There is no scheduled message #${id}.`);
                return { changes: [{ key: `scheduled.${id}`, old: auditOf(before), new: null }], message: `Scheduled message #${id} deleted.` };
            },
        },
        poll: {
            admin: true,
            async run(ctx, form) {
                const g = ctx.guild;
                const anonymous = checkbox(form, 'anonymous');
                const channel = postChannel(g, form, anonymous ? PERMS.poll : PERMS.nativePoll);
                const question = text(form, 'question', Math.max(POLL_QUESTION_MAX, NATIVE_POLL_QUESTION_MAX));
                if (!question) throw new InputError('Question: the poll needs a question.', 400, 'question');
                if (anonymous) {
                    const options = pollOptions(form, POLL_OPTION_MAX);
                    const { message, reacted } = await ctx.services.createPoll(g, { channel, question, options, anonymous: true });
                    return {
                        changes: [{ key: `poll.${message.id}`, old: null, new: { channelId: channel.id, question, options, anonymous: true } }],
                        message: `Anonymous reaction poll posted in #${channel.name}.`,
                        warnings: reacted < options.length ? [`Only ${reacted} of ${options.length} vote reactions could be added: add the rest by hand in Discord.`] : [],
                    };
                }
                const options = pollOptions(form, NATIVE_POLL_ANSWER_MAX);
                const durationHours = intField(form, 'hours', { min: NATIVE_POLL_MIN_HOURS, max: NATIVE_POLL_MAX_HOURS, label: 'Open for (hours)', fallback: NATIVE_POLL_DEFAULT_HOURS });
                const multiSelect = checkbox(form, 'multiSelect');
                const { message, endsAt } = await ctx.services.createNativePoll(g, { channel, question, options, durationHours, multiSelect });
                return {
                    changes: [{ key: `poll.${message.id}`, old: null, new: { channelId: channel.id, question, options, durationHours, multiSelect, anonymous: false } }],
                    message: `Poll posted in #${channel.name}. It closes ${new Date(endsAt).toISOString().replace('T', ' ').slice(0, 16)} UTC.`,
                };
            },
        },
        'poll-end': {
            admin: true,
            async run(ctx, form) {
                // The End button of the open-polls list sends the channel and message; the link field a link.
                // Either way endPoll re-checks everything (this server, a native poll, Mewvo's, still open).
                const channelId = text(form, 'channelId', 25);
                const messageId = text(form, 'messageId', 25);
                const picked = isSnowflake(channelId) && isSnowflake(messageId);
                const link = picked ? `https://discord.com/channels/${ctx.guildId}/${channelId}/${messageId}` : text(form, 'link', 200);
                const target = parseMessageLink(link);
                if (!target) throw new InputError('Poll message link: paste the link from Copy Message Link in Discord, like https://discord.com/channels/...', 400, 'link');
                if (target.guildId !== ctx.guildId) throw new InputError('Poll message link: that message is in another server.', 400, 'link');
                const { channel, question } = await ctx.services.endPoll(ctx.guild, link);
                return {
                    changes: [{ key: `poll.${target.messageId}.ended`, old: null, new: { channelId: channel.id, question } }],
                    message: `Poll ended in #${channel.name}. The final results are now shown on it.`,
                };
            },
        },
        countdown: {
            admin: true,
            async run(ctx, form) {
                const g = ctx.guild;
                const channel = postChannel(g, form, PERMS.post);
                const title = text(form, 'title', COUNTDOWN_TITLE_MAX) || 'Countdown';
                const minutes = intField(form, 'minutes', { min: 0, max: 1440, label: 'Minutes', fallback: 0 });
                const seconds = intField(form, 'seconds', { min: 0, max: 59, label: 'Seconds', fallback: 0 });
                const totalSeconds = minutes * 60 + seconds;
                if (totalSeconds <= 0) throw new InputError('Duration: the countdown needs at least 1 second.', 400, 'minutes');
                if (totalSeconds > COUNTDOWN_MAX_SECONDS) throw new InputError('Duration: a countdown cannot be longer than 24 hours.', 400, 'minutes');
                const { message, endTime } = await ctx.services.startCountdownMessage(g, { channel, totalSeconds, title });
                return {
                    changes: [{ key: `countdown.${message.id}`, old: null, new: { channelId: channel.id, title, seconds: totalSeconds, endsAt: new Date(endTime).toISOString() } }],
                    message: `Countdown started in #${channel.name}: ${clock(totalSeconds)}.`,
                };
            },
        },
    },
};
