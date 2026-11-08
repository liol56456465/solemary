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
import { currentText, textFor } from '../language.js';
import { planLimit } from '../../billing/premiumEffects.js';
import { DEFAULT_TIMEZONE, canonicalTimeZone } from '../../../utils/timezone.js';
import {
    INTERVAL_MAX_HOURS, FAILURE_LIMIT, cleanSchedule, formatInZone, nextRunAfter, zonedParts,
} from '../../scheduledMessageService.js';
import {
    COUNTDOWN_MAX_SECONDS, COUNTDOWN_TITLE_MAX, EMBED_COLOURS, EMBED_DESCRIPTION_MAX, EMBED_FOOTER_MAX, EMBED_TITLE_MAX, EMBED_TOTAL_MAX,
    IMAGE_URL_MAX, MESSAGE_CONTENT_MAX, NATIVE_POLL_ANSWER_MAX, NATIVE_POLL_DEFAULT_HOURS, NATIVE_POLL_MAX_HOURS, NATIVE_POLL_MIN_HOURS, NATIVE_POLL_QUESTION_MAX,
    POLL_MAX_OPTIONS, POLL_OPTION_MAX, POLL_QUESTION_MAX, buildMessageEmbed, colourFromKey, isEmbedImageUrl, noMentions, parseHexColour, parseMessageLink,
} from '../../botMessageService.js';

// Words: src/content/dashboard/<lang>/messages.json. Helpers without a ctx (form parsing) use the
// request's language (mt()). Template names and texts (config/messageTemplates.js), the default
// countdown title and the schedule errors of scheduledMessageService stay as they are.
const mt = () => currentText();

/** A textarea value: line breaks normalised, trimmed, refused (not cut) over `max`. */
function longText(form, name, max, label) {
    const value = typeof form?.[name] === 'string' ? form[name].replace(/\r\n?/g, '\n').trim() : '';
    if (value.length > max) throw new InputError(mt().t('messages.error.tooLong', { label, max: mt().fmtNumber(max), length: mt().fmtNumber(value.length) }), 400, name);
    return value;
}

/** "Once on 2026-11-01 at 09:00", "Mon, Fri at 09:00", … in the page's language (describeSchedule's words in English). */
function scheduleText(tr, schedule) {
    switch (schedule?.kind) {
        case 'once': return tr.t('messages.when.once', { date: schedule.date, time: schedule.time });
        case 'weekly': {
            const days = [...new Set(schedule.days || [])].sort();
            if (days.length === 7) return tr.t('messages.when.daily', { time: schedule.time });
            return tr.t('messages.when.weekdays', { days: DAY_ORDER.filter((d) => days.includes(d)).map((d) => weekdayName(tr, d)).join(', '), time: schedule.time });
        }
        case 'interval': return tr.tp('messages.when.interval', schedule.hours, { date: schedule.date, time: schedule.time });
        default: return tr.t('messages.when.unknown');
    }
}

/** A weekday's short name (0 = Sunday): "Mon" in English, as WEEKDAYS. 2023-01-01 was a Sunday. */
function weekdayName(tr, day) {
    return tr.weekday(new Date(Date.UTC(2023, 0, 1 + day)));
}

/**
 * The chosen channel, refused when the bot lacks one of `perms` there (nothing is posted). The
 * refusal carries `fix` so the page shows a Fix permissions link next to it.
 */
function postChannel(guild, form, perms) {
    const channelId = channelField(guild, form, 'channelId', { optional: false, label: mt().t('messages.fields.channel') });
    const problems = channelWarnings(guild, channelId, perms);
    if (problems.length) {
        const lacks = missingChannelPerms(guild, guild.channels.cache.get(channelId), perms) || [];
        throw Object.assign(new InputError(mt().t('messages.error.channel', { problems: problems.join('; ') }), 400, 'channelId'), lacks.length ? { fix: { channelId, perms: lacks } } : {});
    }
    return guild.channels.cache.get(channelId);
}

/** The embed colour: a hex code when typed, else one of the fixed choices. */
function colourField(form) {
    const hex = text(form, 'hex', 7);
    if (hex) {
        const value = parseHexColour(hex);
        if (value === null) throw new InputError(mt().t('messages.error.colourCode'), 400, 'hex');
        return value;
    }
    const key = text(form, 'colour', 20) || 'primary';
    const value = colourFromKey(key);
    if (value === null) throw new InputError(mt().t('messages.error.colourChoice'), 400, 'colour');
    return value;
}

/** Poll options: one per line, blank lines ignored; each at most `max` characters. */
function pollOptions(form, max = POLL_OPTION_MAX) {
    const tr = mt();
    const options = longText(form, 'options', POLL_MAX_OPTIONS * (POLL_OPTION_MAX + 2), tr.t('messages.poll.options')).split('\n').map((o) => o.trim()).filter(Boolean);
    if (options.length < 2) throw new InputError(tr.t('messages.error.optionsFew'), 400, 'options');
    if (options.length > POLL_MAX_OPTIONS) throw new InputError(tr.tp('messages.error.optionsMany', POLL_MAX_OPTIONS, { written: tr.fmtNumber(options.length) }), 400, 'options');
    const long = options.find((o) => o.length > max);
    if (long) {
        const params = { max: tr.fmtNumber(max), start: long.slice(0, 20), length: tr.fmtNumber(long.length) };
        throw new InputError(tr.t(max === NATIVE_POLL_ANSWER_MAX ? 'messages.error.optionLongNative' : 'messages.error.optionLong', params), 400, 'options');
    }
    return options;
}

/** The "Send a message" fields, prefilled from a stored payload (or empty). */
function messageFields(tr, g, { channelId = null, payload = null } = {}) {
    const e = payload?.embed || {};
    const hex = Number.isInteger(e.colour) ? `#${e.colour.toString(16).padStart(6, '0').toUpperCase()}` : '';
    const known = hex ? EMBED_COLOURS.find(([, , h]) => h.toUpperCase() === hex) : EMBED_COLOURS[0];
    // A plain message needs no Embed Links; with a box filled in, the post itself checks it.
    const colourName = (key, label) => (tr.has(`messages.colour.${key}`) ? tr.t(`messages.colour.${key}`) : label);
    return html`${channelPicker(g, 'channelId', channelId, { label: tr.t('messages.fields.channel'), perms: PERMS.text, optional: false })}
${textArea('content', payload?.content || '', { label: tr.t('messages.fields.content'), max: MESSAGE_CONTENT_MAX, rows: 4, help: tr.t('messages.fields.contentHelp') })}
${textInput('title', e.title || '', { label: tr.t('messages.fields.title'), max: EMBED_TITLE_MAX, help: tr.t('messages.fields.titleHelp') })}
${textArea('description', e.description || '', { label: tr.t('messages.fields.description'), max: EMBED_DESCRIPTION_MAX, rows: 6, help: tr.t('messages.fields.descriptionHelp', { max: tr.fmtNumber(EMBED_TOTAL_MAX) }) })}
${selectInput('colour', known ? known[0] : 'primary', EMBED_COLOURS.map(([key, label, h]) => [key, `${colourName(key, label)} (${h})`]), { label: tr.t('messages.fields.colour') })}
${textInput('hex', known ? '' : hex, { label: tr.t('messages.fields.hex'), max: 7, placeholder: '#9B59B6', help: tr.t('messages.fields.hexHelp') })}
${textInput('imageUrl', e.imageUrl || '', { label: tr.t('messages.fields.imageUrl'), max: IMAGE_URL_MAX, type: 'url', placeholder: 'https://…', help: tr.t('messages.fields.imageUrlHelp') })}
${textInput('footer', e.footer || '', { label: tr.t('messages.fields.footer'), max: EMBED_FOOTER_MAX, help: tr.t('messages.fields.footerHelp') })}`;
}

/**
 * The posted message: { channel, content, embed (with colour) | null, audit }. Refuses an
 * empty message, a footer-only embed, a non-https image and a channel the bot cannot post in.
 */
function messageFromForm(g, form) {
    const tr = mt();
    const content = longText(form, 'content', MESSAGE_CONTENT_MAX, tr.t('messages.fields.content'));
    const embed = {
        title: text(form, 'title', EMBED_TITLE_MAX),
        description: longText(form, 'description', EMBED_DESCRIPTION_MAX, tr.t('messages.fields.embedDescription')),
        imageUrl: text(form, 'imageUrl', IMAGE_URL_MAX),
        footer: text(form, 'footer', EMBED_FOOTER_MAX),
    };
    if (embed.imageUrl && !isEmbedImageUrl(embed.imageUrl)) {
        throw new InputError(tr.t('messages.error.imageUrl'), 400, 'imageUrl');
    }
    const hasEmbed = Boolean(embed.title || embed.description || embed.imageUrl || embed.footer);
    // Embed Links only when a box is sent: plain text needs View Channel + Send Messages.
    const channel = postChannel(g, form, hasEmbed ? PERMS.post : PERMS.text);
    if (!content && !hasEmbed) throw new InputError(tr.t('messages.error.empty'), 400, 'content');
    if (hasEmbed && !embed.title && !embed.description && !embed.imageUrl) {
        throw new InputError(tr.t('messages.error.footerOnly'), 400, 'title');
    }
    if (embed.title.length + embed.description.length + embed.footer.length > EMBED_TOTAL_MAX) {
        throw new InputError(tr.t('messages.error.boxTooLong', { max: tr.fmtNumber(EMBED_TOTAL_MAX) }), 400, 'description');
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
function templatePicker(tr, chosen) {
    const current = chosen?.template?.id || '';
    const note = chosen?.unknown
        ? html`<p class="warn">${tr.tx('messages.template.unknown')}</p>`
        : chosen ? html`<p class="ok">${tr.tx('messages.template.filled', { name: chosen.template.name })}</p>` : '';
    return html`${note}<form method="get" action="${path('/messages')}#s-send-a-message" class="settings-form"><div class="grid">
<label>${tr.tx('messages.template.label')}<select name="template">${templatesByGroup().map((g) => html`<optgroup label="${g.label}">${g.templates.map((t) => html`<option value="${t.id}"${t.id === current ? raw(' selected') : ''}>${t.name}</option>`)}</optgroup>`)}</select><span class="hint">${tr.tx('messages.template.hint')}</span></label></div>
<div class="form-actions"><button type="submit" class="secondary">${tr.tx('messages.template.use')}</button></div></form>`;
}

// ── Scheduling ────────────────────────────────────────────────────────────

const REPEATS = ['once', 'daily', 'weekdays', 'hours'];
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
function scheduleFields(tr, row, defaultZone, now = Date.now()) {
    const zone = row?.timezone || defaultZone;
    const p = zonedParts(now + 60 * 60 * 1000, canonicalTimeZone(zone) || 'UTC');
    const s = row?.schedule || {};
    const date = s.date || `${p.year}-${pad(p.month)}-${pad(p.day)}`;
    const time = s.time || `${pad(p.hour)}:00`;
    const days = new Set(s.kind === 'weekly' ? s.days : [1, 2, 3, 4, 5]);
    return html`<div class="grid">
${selectInput('repeat', repeatOf(row?.schedule), REPEATS.map((key) => [key, tr.t(`messages.repeat.${key}`)]), { label: tr.t('messages.schedule.repeat') })}
${textInput('date', date, { label: tr.t('messages.schedule.date'), max: 10, type: 'date', help: tr.t('messages.schedule.dateHelp') })}
${textInput('time', time, { label: tr.t('messages.schedule.time'), max: 5, type: 'time' })}
${numberInput('hours', s.hours || 24, { label: tr.t('messages.schedule.hours'), min: 1, max: INTERVAL_MAX_HOURS, help: tr.t('messages.schedule.hoursHelp', { max: tr.fmtNumber(INTERVAL_MAX_HOURS) }) })}
<label>${tr.tx('messages.schedule.timezone')}<input type="text" name="timezone" value="${zone}" maxlength="64" list="tz-zones" autocomplete="off"><span class="hint">${tr.tx('messages.schedule.timezoneHelp')}</span></label>
</div><fieldset class="weekdays"><legend>${tr.tx('messages.schedule.weekdays')}</legend>${DAY_ORDER.map((d) => checkboxInput(`day${d}`, days.has(d), { label: weekdayName(tr, d) }))}</fieldset>`;
}

/** { schedule, timezone } from the posted form; refused when invalid or (from now) never runs. */
function scheduleFromForm(form, now = Date.now()) {
    const tr = mt();
    const repeat = choiceField(form, 'repeat', REPEATS, tr.t('messages.schedule.repeat'));
    const timezone = canonicalTimeZone(text(form, 'timezone', 64) || DEFAULT_TIMEZONE);
    if (!timezone) throw new InputError(tr.t('messages.error.timezone'), 400, 'timezone');
    const date = text(form, 'date', 10);
    const time = text(form, 'time', 8).slice(0, 5);
    const input = repeat === 'once' ? { kind: 'once', date, time }
        : repeat === 'daily' ? { kind: 'weekly', time, days: [0, 1, 2, 3, 4, 5, 6] }
            : repeat === 'weekdays' ? { kind: 'weekly', time, days: [0, 1, 2, 3, 4, 5, 6].filter((d) => checkbox(form, `day${d}`)) }
                : { kind: 'interval', date, time, hours: intField(form, 'hours', { min: 1, max: INTERVAL_MAX_HOURS, label: tr.t('messages.schedule.hours') }) };
    let schedule;
    try {
        schedule = cleanSchedule(input);
    } catch (error) {
        const message = error.userMessage || error.message;
        const field = /^Date/.test(message) ? 'date' : /^Time/.test(message) ? 'time' : /^Days/.test(message) ? 'day1' : 'repeat';
        throw new InputError(message, 400, field);
    }
    if (nextRunAfter(schedule, timezone, now) === null) throw new InputError(tr.t('messages.error.past'), 400, 'date');
    return { schedule, timezone };
}

function idField(form) {
    return intField(form, 'id', { min: 1, max: 2147483647, label: mt().t('messages.scheduled.idLabel') });
}

function findScheduled(list, id) {
    const row = list.find((m) => m.id === id);
    if (!row) throw new InputError(mt().t('messages.error.noScheduled', { id }));
    return row;
}

const auditOf = (m) => (m ? { channelId: m.channelId, schedule: m.schedule, timezone: m.timezone, paused: m.paused, payload: m.payload } : null);

function statusPill(tr, m) {
    if (m.paused) return pill(false, tr.t('messages.scheduled.pillPaused'), 'warn');
    if (m.nextRunAt === null) return pill(false, tr.t('messages.scheduled.pillDone'), 'off');
    return pill(true, tr.t('messages.scheduled.pillActive'));
}

function lastResult(tr, m) {
    if (m.lastError) {
        return html`<span class="warn">${m.lastError}</span>${m.failureCount ? html` <span class="muted">${tr.tp('messages.scheduled.failures', FAILURE_LIMIT, { failed: tr.fmtNumber(m.failureCount) })}</span>` : ''}${m.lastRunAt ? html` <span class="muted">${timeTag(m.lastRunAt)}</span>` : ''}`;
    }
    if (m.lastRunAt) return tr.tx('messages.scheduled.posted', { time: timeTag(m.lastRunAt) });
    return html`<span class="muted">${tr.t('messages.scheduled.notRun')}</span>`;
}

/** How the message will look: the text as typed and the embed parts, plain (no colours from the message: CSP). */
export function messagePreview(payload) {
    const e = payload?.embed;
    const tr = mt();
    return html`<div class="msg-preview"><p class="muted">${tr.t('messages.preview.title')}</p>${payload?.content ? html`<p class="msg-text">${payload.content}</p>` : ''}${e && (e.title || e.description || e.imageUrl || e.footer)
        ? html`<div class="msg-embed">${e.title ? html`<p><b>${e.title}</b></p>` : ''}${e.description ? html`<p class="msg-text">${e.description}</p>` : ''}${e.imageUrl ? html`<p class="muted">${tr.tx('messages.preview.image', { url: e.imageUrl })}</p>` : ''}${e.footer ? html`<p class="muted">${e.footer}</p>` : ''}</div>` : ''}
<p class="muted">${tr.tx('messages.preview.note')}</p></div>`;
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
    if (!text && !embed) throw new InputError(mt().t('messages.error.testEmpty'));
    const user = await client.users.fetch(userId).catch(() => null);
    if (!user) throw new InputError(mt().t('messages.error.testNoUser'));
    try {
        await user.send({ ...(text ? { content: text } : {}), ...(embed ? { embeds: [embed] } : {}), allowedMentions: noMentions() });
    } catch {
        throw new InputError(mt().t('messages.error.testDmClosed'));
    }
}

function preview(tr, payload) {
    const textPart = payload?.content || payload?.embed?.title || payload?.embed?.description || tr.t('messages.scheduled.imageOnly');
    return textPart.length > 80 ? `${textPart.slice(0, 79)}…` : textPart;
}

function scheduledSection(ctx, list, defaultZone) {
    const g = ctx.guild;
    const tr = textFor(ctx);
    const can = ctx.canEdit && ctx.canAct;
    const rows = list.map((m) => [
        html`<a href="#edit-${m.id}">#${m.id}</a> <span class="muted">${preview(tr, m.payload)}</span>`,
        channelName(g, m.channelId),
        m.nextRunAt === null ? html`<span class="muted">-</span>` : html`${formatInZone(m.nextRunAt, m.timezone)} <span class="muted">${m.timezone}</span>`,
        scheduleText(tr, m.schedule),
        lastResult(tr, m),
        statusPill(tr, m),
        html`<div class="row-actions">${m.paused
            ? buttonForm(ctx, 'messages', 'schedule-pause', tr.t('messages.scheduled.resume'), { id: m.id, paused: 'false' }, { canEdit: can })
            : m.nextRunAt === null ? '' : buttonForm(ctx, 'messages', 'schedule-pause', tr.t('messages.scheduled.pause'), { id: m.id, paused: 'true' }, { canEdit: can })}
${buttonForm(ctx, 'messages', 'schedule-run', tr.t('messages.scheduled.runNow'), { id: m.id }, { canEdit: can, danger: false, confirm: tr.t('messages.scheduled.runConfirm') })}
${buttonForm(ctx, 'messages', 'schedule-delete', tr.t('messages.scheduled.delete'), { id: m.id }, { canEdit: can, confirm: tr.t('messages.scheduled.deleteConfirm', { id: m.id }) })}</div>`,
    ]);
    const edits = list.map((m) => html`<details class="sub" id="edit-${m.id}" data-key="scheduled-${m.id}"><summary>${tr.tx('messages.scheduled.editSummary', { id: m.id, schedule: scheduleText(tr, m.schedule) })}</summary>
${messagePreview(m.payload)}
<p>${upcomingRuns(m).length ? html`${tr.tx('messages.scheduled.nextPosts', { times: html`${upcomingRuns(m).map((ms, i) => html`${i ? ', ' : ''}${formatInZone(ms, m.timezone)}`)}` })} <span class="muted">(${m.timezone})</span>` : html`<span class="muted">${tr.t(m.paused ? 'messages.scheduled.pausedNote' : 'messages.scheduled.doneNote')}</span>`}</p>
${buttonForm(ctx, 'messages', 'schedule-test', tr.t('messages.scheduled.test'), { id: m.id }, { canEdit: can, danger: false })} <span class="muted">${tr.tx('messages.scheduled.testNote')}</span>
${postForm(ctx, 'messages', 'schedule-edit', html`<div class="grid">${messageFields(tr, g, m)}</div>${scheduleFields(tr, m, defaultZone)}`, { submit: tr.t('messages.scheduled.save'), hidden: { id: m.id }, canEdit: can, reset: true })}</details>`);
    return html`<p>${tr.tp('messages.scheduled.count', planLimit(ctx.guildId, 'scheduled'), { used: tr.fmtNumber(list.length) })}</p>
${table([tr.t('messages.scheduled.colMessage'), tr.t('messages.scheduled.colChannel'), tr.t('messages.scheduled.colNext'), tr.t('messages.scheduled.colRepeat'), tr.t('messages.scheduled.colLast'), tr.t('messages.scheduled.colStatus'), ''], rows, tr.t('messages.scheduled.empty'))}${edits}`;
}

/** "End a poll": Mewvo's open Discord polls (pollList.js), an End button each. */
function openPollList(ctx, openPolls, canPost) {
    const tr = textFor(ctx);
    if (openPolls === null) return html`<p class="warn">${tr.tx('messages.endPoll.loadFailed')}</p>`;
    const polls = openPolls?.polls || [];
    const rows = polls.map((p) => [
        p.question || html`<span class="muted">${tr.t('messages.endPoll.noQuestion')}</span>`,
        html`#${p.channelName}`,
        p.endsAt ? timeTag(p.endsAt) : html`<span class="muted">-</span>`,
        buttonForm(ctx, 'messages', 'poll-end', tr.t('messages.endPoll.end'), { channelId: p.channelId, messageId: p.messageId },
            { canEdit: canPost, confirm: tr.t('messages.endPoll.confirm') }),
    ]);
    return html`${table([tr.t('messages.endPoll.colQuestion'), tr.t('messages.endPoll.colChannel'), tr.t('messages.endPoll.colCloses'), ''], rows, tr.t('messages.endPoll.empty'))}
<p class="muted">${tr.tx(openPolls?.partial ? 'messages.endPoll.notePartial' : 'messages.endPoll.note')}</p>`;
}

function clock(tr, seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return [h ? tr.t('messages.clock.hours', { n: h }) : '', m ? tr.t('messages.clock.minutes', { n: m }) : '', s ? tr.t('messages.clock.seconds', { n: s }) : ''].filter(Boolean).join(' ');
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
        const tr = textFor(ctx);
        const scheduled = data.scheduled || [];
        const canPost = ctx.canEdit && ctx.canAct;
        const adminNote = ctx.canAct ? '' : ` ${tr.t('messages.adminNote')}`;
        const chosen = chosenTemplate(ctx.query, g?.name);
        const prefill = chosen?.payload ? { payload: chosen.payload } : {};
        const send = postForm(ctx, 'messages', 'send', html`<div class="grid">${messageFields(tr, g, prefill)}</div>`, { submit: tr.t('messages.send.submit'), canEdit: canPost });
        const schedule = postForm(ctx, 'messages', 'schedule', html`<div class="grid">${messageFields(tr, g, prefill)}</div>${scheduleFields(tr, null, data.timezone || DEFAULT_TIMEZONE)}`,
            { submit: tr.t('messages.schedule.submit'), canEdit: canPost });
        const poll = postForm(ctx, 'messages', 'poll', html`<div class="grid">
${channelPicker(g, 'channelId', null, { label: tr.t('messages.fields.channel'), perms: PERMS.nativePoll, optional: false })}
${textInput('question', '', { label: tr.t('messages.poll.question'), max: NATIVE_POLL_QUESTION_MAX })}
${textArea('options', '', { label: tr.t('messages.poll.options'), max: POLL_MAX_OPTIONS * (POLL_OPTION_MAX + 2), rows: 5, help: tr.t('messages.poll.optionsHelp', { max: tr.fmtNumber(POLL_MAX_OPTIONS), answerMax: tr.fmtNumber(NATIVE_POLL_ANSWER_MAX), anonymousMax: tr.fmtNumber(POLL_OPTION_MAX) }) })}
${numberInput('hours', NATIVE_POLL_DEFAULT_HOURS, { label: tr.t('messages.poll.hours'), min: NATIVE_POLL_MIN_HOURS, max: NATIVE_POLL_MAX_HOURS, help: tr.t('messages.poll.hoursHelp', { min: tr.fmtNumber(NATIVE_POLL_MIN_HOURS), max: tr.fmtNumber(NATIVE_POLL_MAX_HOURS) }) })}
${switchInput('multiSelect', false, { label: tr.t('messages.poll.multiSelect'), help: tr.t('messages.poll.multiSelectHelp') })}
${switchInput('anonymous', false, { label: tr.t('messages.poll.anonymous'), help: tr.t('messages.poll.anonymousHelp') })}</div>`,
        { submit: tr.t('messages.poll.submit'), canEdit: canPost });
        const endPollForm = html`${openPollList(ctx, data.openPolls, canPost)}
<details class="sub" data-key="poll-end-link"><summary>${tr.tx('messages.endPoll.byLink')}</summary>
${postForm(ctx, 'messages', 'poll-end', html`<div class="grid">
${textInput('link', '', { label: tr.t('messages.endPoll.link'), max: 200, type: 'url', placeholder: 'https://discord.com/channels/...', help: tr.t('messages.endPoll.linkHelp') })}</div>`,
        { submit: tr.t('messages.endPoll.submit'), canEdit: canPost })}</details>`;
        const countdown = postForm(ctx, 'messages', 'countdown', html`<div class="grid">
${channelPicker(g, 'channelId', null, { label: tr.t('messages.fields.channel'), perms: PERMS.post, optional: false })}
${textInput('title', '', { label: tr.t('messages.countdown.title'), max: COUNTDOWN_TITLE_MAX, placeholder: tr.t('messages.countdown.placeholder'), help: tr.t('messages.countdown.titleHelp') })}
${numberInput('minutes', 5, { label: tr.t('messages.countdown.minutes'), min: 0, max: 1440, help: tr.t('messages.countdown.minutesHelp', { max: tr.fmtNumber(1440) }) })}
${numberInput('seconds', 0, { label: tr.t('messages.countdown.seconds'), min: 0, max: 59, help: tr.t('messages.countdown.secondsHelp') })}</div>`,
        { submit: tr.t('messages.countdown.submit'), canEdit: canPost });
        return html`${section(tr.t('messages.template.title'), templatePicker(tr, chosen), tr.t('messages.template.help'), { key: 'start-from-a-template' })}
${section(tr.t('messages.send.title'), send, `${tr.t('messages.send.help')}${adminNote}`, { key: 'send-a-message' })}
${section(tr.t('messages.schedule.title'), schedule, `${tr.tp('messages.schedule.help', FAILURE_LIMIT, { limit: tr.fmtNumber(planLimit(ctx.guildId, 'scheduled')) })}${adminNote}`, { key: 'schedule-a-message' })}
${section(tr.t('messages.scheduled.title'), scheduledSection(ctx, scheduled, data.timezone || DEFAULT_TIMEZONE), tr.t('messages.scheduled.help'), { key: 'scheduled-messages' })}
<datalist id="tz-zones">${timeZoneList().map((z) => html`<option value="${z}"></option>`)}</datalist>
${section(tr.t('messages.poll.title'), poll, `${tr.t('messages.poll.help')}${adminNote}`, { key: 'start-a-poll' })}
${section(tr.t('messages.endPoll.title'), endPollForm, `${tr.t('messages.endPoll.help')}${adminNote}`, { key: 'end-a-poll' })}
${section(tr.t('messages.countdown.sectionTitle'), countdown, `${tr.t('messages.countdown.help')}${adminNote}`, { key: 'start-a-countdown' })}`;
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
                    message: textFor(ctx).t('messages.action.posted', { channel: channel.name }),
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
                    message: textFor(ctx).t('messages.action.scheduled', { id: row.id, channel: channel.name, schedule: scheduleText(textFor(ctx), row.schedule), zone: row.timezone, time: formatInZone(row.nextRunAt, row.timezone) }),
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
                    message: after.paused ? textFor(ctx).t('messages.action.editedPaused', { id })
                        : textFor(ctx).t('messages.action.edited', { id, time: formatInZone(after.nextRunAt, after.timezone), zone: after.timezone }),
                };
            },
        },
        'schedule-pause': {
            admin: true,
            async run(ctx, form) {
                const tr = textFor(ctx);
                const id = idField(form);
                const paused = boolField(form, 'paused', tr.t('messages.scheduled.pausedLabel'));
                const current = findScheduled(await ctx.services.listScheduledMessages(ctx.guildId), id);
                if (current.paused === paused) return { changes: [], message: tr.t(paused ? 'messages.action.alreadyPaused' : 'messages.action.alreadyRunning', { id }) };
                const { before, after } = await ctx.services.setScheduledMessagePaused(ctx.guildId, id, paused);
                return {
                    changes: [{ key: `scheduled.${id}.paused`, old: before.paused, new: after.paused }],
                    message: paused ? tr.t('messages.action.paused', { id }) : tr.t('messages.action.resumed', { id, time: formatInZone(after.nextRunAt, after.timezone), zone: after.timezone }),
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
                    message: textFor(ctx).t('messages.action.ran', { id, channel: channel.name }),
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
                    message: textFor(ctx).t('messages.action.tested', { id }),
                };
            },
        },
        'schedule-delete': {
            admin: true,
            async run(ctx, form) {
                const id = idField(form);
                findScheduled(await ctx.services.listScheduledMessages(ctx.guildId), id);
                const before = await ctx.services.deleteScheduledMessage(ctx.guildId, id);
                if (!before) throw new InputError(textFor(ctx).t('messages.error.noScheduled', { id }));
                return { changes: [{ key: `scheduled.${id}`, old: auditOf(before), new: null }], message: textFor(ctx).t('messages.action.deleted', { id }) };
            },
        },
        poll: {
            admin: true,
            async run(ctx, form) {
                const g = ctx.guild;
                const tr = textFor(ctx);
                const anonymous = checkbox(form, 'anonymous');
                const channel = postChannel(g, form, anonymous ? PERMS.poll : PERMS.nativePoll);
                const question = text(form, 'question', Math.max(POLL_QUESTION_MAX, NATIVE_POLL_QUESTION_MAX));
                if (!question) throw new InputError(tr.t('messages.error.noQuestion'), 400, 'question');
                if (anonymous) {
                    const options = pollOptions(form, POLL_OPTION_MAX);
                    const { message, reacted } = await ctx.services.createPoll(g, { channel, question, options, anonymous: true });
                    return {
                        changes: [{ key: `poll.${message.id}`, old: null, new: { channelId: channel.id, question, options, anonymous: true } }],
                        message: tr.t('messages.action.anonymousPosted', { channel: channel.name }),
                        warnings: reacted < options.length ? [tr.tp('messages.action.reactionsMissing', options.length, { added: tr.fmtNumber(reacted) })] : [],
                    };
                }
                const options = pollOptions(form, NATIVE_POLL_ANSWER_MAX);
                const durationHours = intField(form, 'hours', { min: NATIVE_POLL_MIN_HOURS, max: NATIVE_POLL_MAX_HOURS, label: tr.t('messages.poll.hours'), fallback: NATIVE_POLL_DEFAULT_HOURS });
                const multiSelect = checkbox(form, 'multiSelect');
                const { message, endsAt } = await ctx.services.createNativePoll(g, { channel, question, options, durationHours, multiSelect });
                return {
                    changes: [{ key: `poll.${message.id}`, old: null, new: { channelId: channel.id, question, options, durationHours, multiSelect, anonymous: false } }],
                    message: tr.t('messages.action.pollPosted', { channel: channel.name, time: tr.fmtDateTime(endsAt) }),
                };
            },
        },
        'poll-end': {
            admin: true,
            async run(ctx, form) {
                // The End button of the open-polls list sends the channel and message; the link field a link.
                // Either way endPoll re-checks everything (this server, a native poll, Mewvo's, still open).
                const tr = textFor(ctx);
                const channelId = text(form, 'channelId', 25);
                const messageId = text(form, 'messageId', 25);
                const picked = isSnowflake(channelId) && isSnowflake(messageId);
                const link = picked ? `https://discord.com/channels/${ctx.guildId}/${channelId}/${messageId}` : text(form, 'link', 200);
                const target = parseMessageLink(link);
                if (!target) throw new InputError(tr.t('messages.error.pollLink'), 400, 'link');
                if (target.guildId !== ctx.guildId) throw new InputError(tr.t('messages.error.pollOtherServer'), 400, 'link');
                const { channel, question } = await ctx.services.endPoll(ctx.guild, link);
                return {
                    changes: [{ key: `poll.${target.messageId}.ended`, old: null, new: { channelId: channel.id, question } }],
                    message: tr.t('messages.action.pollEnded', { channel: channel.name }),
                };
            },
        },
        countdown: {
            admin: true,
            async run(ctx, form) {
                const g = ctx.guild;
                const tr = textFor(ctx);
                const channel = postChannel(g, form, PERMS.post);
                const title = text(form, 'title', COUNTDOWN_TITLE_MAX) || tr.t('messages.countdown.defaultTitle');
                const minutes = intField(form, 'minutes', { min: 0, max: 1440, label: tr.t('messages.countdown.minutes'), fallback: 0 });
                const seconds = intField(form, 'seconds', { min: 0, max: 59, label: tr.t('messages.countdown.seconds'), fallback: 0 });
                const totalSeconds = minutes * 60 + seconds;
                if (totalSeconds <= 0) throw new InputError(tr.t('messages.error.countdownShort'), 400, 'minutes');
                if (totalSeconds > COUNTDOWN_MAX_SECONDS) throw new InputError(tr.t('messages.error.countdownLong'), 400, 'minutes');
                const { message, endTime } = await ctx.services.startCountdownMessage(g, { channel, totalSeconds, title });
                return {
                    changes: [{ key: `countdown.${message.id}`, old: null, new: { channelId: channel.id, title, seconds: totalSeconds, endsAt: new Date(endTime).toISOString() } }],
                    message: tr.t('messages.action.countdownStarted', { channel: channel.name, duration: clock(tr, totalSeconds) }),

                };
            },
        },
    },
};
