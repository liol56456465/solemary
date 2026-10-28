// messages.js — Messages: post as the bot from the web. A message and/or embed (replaces
// /embedbuilder), a reaction poll (/poll) and a countdown (/countdown). Everything goes
// through services/botMessageService.js, the same functions /poll and /countdown use:
// allowedMentions { parse: [] } (typed text never pings) and the bot's permissions in
// the channel are checked before anything is posted. Administrator only.
//
// Scheduled and recurring messages (services/scheduledMessageService.js): the same text
// and/or embed, posted later by the once-a-minute cron with postBotMessage, once, on
// chosen weekdays at a time, or every N hours, in an IANA time zone.

import { html, timeTag } from '../html.js';
import {
    InputError, PERMS, boolField, buttonForm, channelField, channelName, channelPicker, channelWarnings, checkbox, checkboxInput, choiceField, intField, numberInput,
    pill, postForm, selectInput, switchInput, text, textArea, textInput,
} from '../forms.js';
import { section, table } from './common.js';
import { DEFAULT_TIMEZONE, canonicalTimeZone } from '../../../utils/timezone.js';
import {
    INTERVAL_MAX_HOURS, SCHEDULED_MAX_PER_GUILD, FAILURE_LIMIT, WEEKDAYS, cleanSchedule, describeSchedule, formatInZone, nextRunAfter, zonedParts,
} from '../../scheduledMessageService.js';
import {
    COUNTDOWN_MAX_SECONDS, COUNTDOWN_TITLE_MAX, EMBED_COLOURS, EMBED_DESCRIPTION_MAX, EMBED_FOOTER_MAX, EMBED_TITLE_MAX, EMBED_TOTAL_MAX,
    IMAGE_URL_MAX, MESSAGE_CONTENT_MAX, POLL_MAX_OPTIONS, POLL_OPTION_MAX, POLL_QUESTION_MAX, colourFromKey, isEmbedImageUrl, parseHexColour,
} from '../../botMessageService.js';

const NO_PINGS = 'Mentions are shown as text but never ping: no @everyone, @here, role or member pings.';

/** A textarea value: line breaks normalised, trimmed, refused (not cut) over `max`. */
function longText(form, name, max, label) {
    const value = typeof form?.[name] === 'string' ? form[name].replace(/\r\n?/g, '\n').trim() : '';
    if (value.length > max) throw new InputError(`${label}: at most ${max} characters (${value.length} entered).`, 400, name);
    return value;
}

/** The chosen channel, refused when the bot lacks one of `perms` there (nothing is posted). */
function postChannel(guild, form, perms) {
    const channelId = channelField(guild, form, 'channelId', { optional: false, label: 'Channel' });
    const problems = channelWarnings(guild, channelId, perms);
    if (problems.length) throw new InputError(`Channel: ${problems.join('; ')}. Nothing was posted.`, 400, 'channelId');
    return guild.channels.cache.get(channelId);
}

/** The embed colour: a hex code when typed, else one of the fixed choices. */
function colourField(form) {
    const hex = text(form, 'hex', 7);
    if (hex) {
        const value = parseHexColour(hex);
        if (value === null) throw new InputError('Colour: use a hex code like #9B59B6, or leave it empty and pick from the list.', 400, 'hex');
        return value;
    }
    const key = text(form, 'colour', 20) || 'primary';
    const value = colourFromKey(key);
    if (value === null) throw new InputError('Colour: unknown choice.', 400, 'colour');
    return value;
}

/** Poll options: one per line, blank lines ignored. */
function pollOptions(form) {
    const options = longText(form, 'options', POLL_MAX_OPTIONS * (POLL_OPTION_MAX + 2), 'Options').split('\n').map((o) => o.trim()).filter(Boolean);
    if (options.length < 2) throw new InputError('Options: you must provide at least 2 options for the poll (one per line).', 400, 'options');
    if (options.length > POLL_MAX_OPTIONS) throw new InputError(`Options: a poll has at most ${POLL_MAX_OPTIONS} options (${options.length} entered).`, 400, 'options');
    const long = options.find((o) => o.length > POLL_OPTION_MAX);
    if (long) throw new InputError(`Options: each option is limited to ${POLL_OPTION_MAX} characters.`, 400, 'options');
    return options;
}

/** The "Send a message" fields, prefilled from a stored payload (or empty). */
function messageFields(g, { channelId = null, payload = null } = {}) {
    const e = payload?.embed || {};
    const hex = Number.isInteger(e.colour) ? `#${e.colour.toString(16).padStart(6, '0').toUpperCase()}` : '';
    const known = hex ? EMBED_COLOURS.find(([, , h]) => h.toUpperCase() === hex) : EMBED_COLOURS[0];
    return html`${channelPicker(g, 'channelId', channelId, { label: 'Channel', perms: PERMS.post, optional: false })}
${textArea('content', payload?.content || '', { label: 'Message text', max: MESSAGE_CONTENT_MAX, rows: 4, help: `Optional when the embed is filled in. ${NO_PINGS}` })}
${textInput('title', e.title || '', { label: 'Embed title', max: EMBED_TITLE_MAX })}
${textArea('description', e.description || '', { label: 'Embed description', max: EMBED_DESCRIPTION_MAX, rows: 6, help: `Discord markdown works. Title, description and footer together: at most ${EMBED_TOTAL_MAX} characters.` })}
${selectInput('colour', known ? known[0] : 'primary', EMBED_COLOURS.map(([key, label, h]) => [key, `${label} (${h})`]), { label: 'Embed colour' })}
${textInput('hex', known ? '' : hex, { label: 'Or a hex colour', max: 7, placeholder: '#9B59B6', help: 'When filled in, it replaces the colour above.' })}
${textInput('imageUrl', e.imageUrl || '', { label: 'Image URL', max: IMAGE_URL_MAX, type: 'url', placeholder: 'https://…', help: 'Optional. A full https:// link to an image.' })}
${textInput('footer', e.footer || '', { label: 'Embed footer', max: EMBED_FOOTER_MAX, help: 'Optional small text under the embed.' })}`;
}

/**
 * The posted message: { channel, content, embed (with colour) | null, audit }. Refuses an
 * empty message, a footer-only embed, a non-https image and a channel the bot cannot post in.
 */
function messageFromForm(g, form) {
    const channel = postChannel(g, form, PERMS.post);
    const content = longText(form, 'content', MESSAGE_CONTENT_MAX, 'Message text');
    const embed = {
        title: text(form, 'title', EMBED_TITLE_MAX),
        description: longText(form, 'description', EMBED_DESCRIPTION_MAX, 'Embed description'),
        imageUrl: text(form, 'imageUrl', IMAGE_URL_MAX),
        footer: text(form, 'footer', EMBED_FOOTER_MAX),
    };
    if (embed.imageUrl && !isEmbedImageUrl(embed.imageUrl)) {
        throw new InputError('Image URL: must be a full https:// link (http, data: and other links are refused).', 400, 'imageUrl');
    }
    const hasEmbed = Boolean(embed.title || embed.description || embed.imageUrl || embed.footer);
    if (!content && !hasEmbed) throw new InputError('Write a message or fill in the embed: there is nothing to post.', 400, 'content');
    if (hasEmbed && !embed.title && !embed.description && !embed.imageUrl) {
        throw new InputError('Embed: add a title, a description or an image (a footer alone is not shown).', 400, 'title');
    }
    if (embed.title.length + embed.description.length + embed.footer.length > EMBED_TOTAL_MAX) {
        throw new InputError(`Embed: title, description and footer together are limited to ${EMBED_TOTAL_MAX} characters.`, 400, 'description');
    }
    const colour = colourField(form);
    return {
        channel, content, embed: hasEmbed ? { ...embed, colour } : null,
        audit: { channelId: channel.id, content: content || null, embed: hasEmbed ? { ...embed, colour: `#${colour.toString(16).padStart(6, '0')}` } : null },
    };
}

// ── Scheduling ────────────────────────────────────────────────────────────

const REPEATS = [['once', 'Once'], ['daily', 'Every day'], ['weekdays', 'On chosen weekdays'], ['hours', 'Every N hours']];
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
${textInput('date', date, { label: 'Date', max: 10, type: 'date', help: 'Once: the day it is posted. Every N hours: the first post.' })}
${textInput('time', time, { label: 'Time (24-hour)', max: 5, type: 'time' })}
${numberInput('hours', s.hours || 24, { label: `Every N hours (1–${INTERVAL_MAX_HOURS})`, min: 1, max: INTERVAL_MAX_HOURS, help: 'Only for "Every N hours".' })}
<label>Time zone<input type="text" name="timezone" value="${zone}" maxlength="64" list="tz-zones" autocomplete="off"><span class="hint">An IANA name such as Europe/Vilnius or UTC. Daylight saving time is handled.</span></label>
</div><fieldset class="weekdays"><legend>Weekdays (only for "On chosen weekdays")</legend>${DAY_ORDER.map((d) => checkboxInput(`day${d}`, days.has(d), { label: WEEKDAYS[d] }))}</fieldset>`;
}

/** { schedule, timezone } from the posted form; refused when invalid or (from now) never runs. */
function scheduleFromForm(form, now = Date.now()) {
    const repeat = choiceField(form, 'repeat', REPEATS.map(([key]) => key), 'Repeat');
    const timezone = canonicalTimeZone(text(form, 'timezone', 64) || DEFAULT_TIMEZONE);
    if (!timezone) throw new InputError('Time zone: not a known time zone. Use an IANA name such as Europe/London or UTC.', 400, 'timezone');
    const date = text(form, 'date', 10);
    const time = text(form, 'time', 8).slice(0, 5);
    const input = repeat === 'once' ? { kind: 'once', date, time }
        : repeat === 'daily' ? { kind: 'weekly', time, days: [0, 1, 2, 3, 4, 5, 6] }
            : repeat === 'weekdays' ? { kind: 'weekly', time, days: [0, 1, 2, 3, 4, 5, 6].filter((d) => checkbox(form, `day${d}`)) }
                : { kind: 'interval', date, time, hours: intField(form, 'hours', { min: 1, max: INTERVAL_MAX_HOURS, label: 'Every N hours' }) };
    let schedule;
    try {
        schedule = cleanSchedule(input);
    } catch (error) {
        const message = error.userMessage || error.message;
        const field = /^Date/.test(message) ? 'date' : /^Time/.test(message) ? 'time' : /^Days/.test(message) ? 'day1' : 'repeat';
        throw new InputError(message, 400, field);
    }
    if (nextRunAfter(schedule, timezone, now) === null) throw new InputError('That time has already passed: pick a time in the future.', 400, 'date');
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
        m.nextRunAt === null ? html`<span class="muted">—</span>` : html`${formatInZone(m.nextRunAt, m.timezone)} <span class="muted">${m.timezone}</span>`,
        describeSchedule(m.schedule),
        lastResult(m),
        statusPill(m),
        html`<div class="row-actions">${m.paused
            ? buttonForm(ctx, 'messages', 'schedule-pause', 'Resume', { id: m.id, paused: 'false' }, { canEdit: can })
            : m.nextRunAt === null ? '' : buttonForm(ctx, 'messages', 'schedule-pause', 'Pause', { id: m.id, paused: 'true' }, { canEdit: can })}
${buttonForm(ctx, 'messages', 'schedule-run', 'Run now', { id: m.id }, { canEdit: can, danger: false, confirm: 'Post this message now?' })}
${buttonForm(ctx, 'messages', 'schedule-delete', 'Delete', { id: m.id }, { canEdit: can, confirm: `Delete scheduled message #${m.id}? This cannot be undone.` })}</div>`,
    ]);
    const edits = list.map((m) => html`<details class="sub" id="edit-${m.id}" data-key="scheduled-${m.id}"><summary>Edit #${m.id} · ${describeSchedule(m.schedule)}</summary>
${postForm(ctx, 'messages', 'schedule-edit', html`<div class="grid">${messageFields(g, m)}</div>${scheduleFields(m, defaultZone)}`, { submit: 'Save scheduled message', hidden: { id: m.id }, canEdit: can })}</details>`);
    return html`<p>${list.length} of ${SCHEDULED_MAX_PER_GUILD} scheduled messages.</p>
${table(['Message', 'Channel', 'Next run', 'Repeat', 'Last result', 'Status', ''], rows, 'No scheduled messages.')}${edits}`;
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
    help: 'Post as the bot: a message or embed (now or scheduled, once or repeating), a poll, or a countdown. Replaces /embedbuilder, /poll and /countdown. Typed text never pings anyone. Everything here needs Administrator in the main server.',

    async load(ctx) {
        const [config, scheduled] = await Promise.all([
            ctx.services.getGuildConfig(ctx.client, ctx.guildId),
            ctx.services.listScheduledMessages(ctx.guildId),
        ]);
        return { scheduled, timezone: canonicalTimeZone(config?.birthdayTimezone) || DEFAULT_TIMEZONE };
    },

    render(ctx, data = {}) {
        const g = ctx.guild;
        const scheduled = data.scheduled || [];
        const canPost = ctx.canEdit && ctx.canAct;
        const adminNote = ctx.canAct ? '' : ' Posting needs Administrator in the main server.';
        const send = postForm(ctx, 'messages', 'send', html`<div class="grid">${messageFields(g)}</div>`, { submit: 'Post message', canEdit: canPost });
        const schedule = postForm(ctx, 'messages', 'schedule', html`<div class="grid">${messageFields(g)}</div>${scheduleFields(null, data.timezone || DEFAULT_TIMEZONE)}`,
            { submit: 'Schedule message', canEdit: canPost });
        const poll = postForm(ctx, 'messages', 'poll', html`<div class="grid">
${channelPicker(g, 'channelId', null, { label: 'Channel', perms: PERMS.poll, optional: false })}
${textInput('question', '', { label: 'Question', max: POLL_QUESTION_MAX })}
${textArea('options', '', { label: `Options (one per line, 2–${POLL_MAX_OPTIONS})`, max: POLL_MAX_OPTIONS * (POLL_OPTION_MAX + 2), rows: 5, help: 'Members vote with the number reactions under the poll.' })}
${switchInput('anonymous', false, { label: 'Anonymous poll', help: 'Only changes the poll text: reactions always show who voted.' })}</div>`,
        { submit: 'Post poll', canEdit: canPost });
        const countdown = postForm(ctx, 'messages', 'countdown', html`<div class="grid">
${channelPicker(g, 'channelId', null, { label: 'Channel', perms: PERMS.post, optional: false })}
${textInput('title', '', { label: 'Title', max: COUNTDOWN_TITLE_MAX, placeholder: 'Countdown Timer' })}
${numberInput('minutes', 5, { label: 'Minutes (0–1440)', min: 0, max: 1440 })}
${numberInput('seconds', 0, { label: 'Seconds (0–59)', min: 0, max: 59 })}</div>`,
        { submit: 'Start countdown', canEdit: canPost });
        return html`${section('Send a message', send, `Same as /embedbuilder: the bot posts the text and/or embed in the channel.${adminNote}`)}
${section('Schedule a message', schedule, `The same message, posted later: once, every day or on chosen weekdays at a time, or every N hours. Checked once a minute; the bot's permissions are checked again when it posts. After ${FAILURE_LIMIT} failed posts in a row it is paused and the alerts channel is told. At most ${SCHEDULED_MAX_PER_GUILD} per server.${adminNote}`)}
${section('Scheduled messages', scheduledSection(ctx, scheduled, data.timezone || DEFAULT_TIMEZONE), 'Next run is shown in each message\'s own time zone.')}
<datalist id="tz-zones">${timeZoneList().map((z) => html`<option value="${z}"></option>`)}</datalist>
${section('Start a poll', poll, `Same as /poll.${adminNote}`)}
${section('Start a countdown', countdown, `Same as /countdown: up to 24 hours, with Pause and Cancel buttons for Administrators. A bot restart stops running countdowns.${adminNote}`)}`;
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
                const channel = postChannel(g, form, PERMS.poll);
                const question = text(form, 'question', POLL_QUESTION_MAX);
                if (!question) throw new InputError('Question: the poll needs a question.', 400, 'question');
                const options = pollOptions(form);
                const anonymous = checkbox(form, 'anonymous');
                const { message, reacted } = await ctx.services.createPoll(g, { channel, question, options, anonymous });
                return {
                    changes: [{ key: `poll.${message.id}`, old: null, new: { channelId: channel.id, question, options, anonymous } }],
                    message: `Poll posted in #${channel.name}.`,
                    warnings: reacted < options.length ? [`Only ${reacted} of ${options.length} vote reactions could be added: add the rest by hand in Discord.`] : [],
                };
            },
        },
        countdown: {
            admin: true,
            async run(ctx, form) {
                const g = ctx.guild;
                const channel = postChannel(g, form, PERMS.post);
                const title = text(form, 'title', COUNTDOWN_TITLE_MAX) || 'Countdown Timer';
                const minutes = intField(form, 'minutes', { min: 0, max: 1440, label: 'Minutes', fallback: 0 });
                const seconds = intField(form, 'seconds', { min: 0, max: 59, label: 'Seconds', fallback: 0 });
                const totalSeconds = minutes * 60 + seconds;
                if (totalSeconds <= 0) throw new InputError('Duration: please specify a duration of at least 1 second.', 400, 'minutes');
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
