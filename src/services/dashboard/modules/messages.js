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
// The template's language can be chosen (?lang=) when it has translations (Mewvo's own
// templates); edited text is posted exactly as typed, never translated.
//
// Announcement choices (Send, Schedule, Edit): embed or plain text, colour, image, up to
// LINK_BUTTON_MAX link buttons (https only), and an explicit ping: one role and/or a ticked
// "ping everyone". allowedMentions lets through exactly that (botMessageService.announcementMentions);
// mentions typed in the text never ping. "Post message" shows a preview first (the confirm
// page, routes.js `confirm`): nothing is posted until the admin presses Post now.
//
// Home-only templates (config/mewvoTemplates.js) are listed and accepted only in Mewvo's own
// servers (isHomeScope → isMewvoServer); elsewhere ?template=<id> and a posted `template` id
// are refused. "New moderators" adds member pickers (Send only): {mods} becomes their
// mentions and only they are pinged. "Changelog" fills {changes} from the website changelog
// (the admin ticks which entries); "Mewvo now in N servers" fills {count} from the guild cache.

import { PermissionFlagsBits } from 'discord.js';
import { html, path, queryString, raw, timeTag } from '../html.js';
import { fillTemplate, isHomeTemplate, messageTemplate, templateLanguages, templatesByGroup } from '../../../config/messageTemplates.js';
import { CHANGELOG, changelogKey } from '../../../config/site/changelog.js';
import { LANGUAGES, LANG_CODES, translator } from '../../site/i18n.js';
import { memberField, parseUserRef, pickedFromQuery } from '../memberSearch.js';
import {
    InputError, PERMS, boolField, buttonForm, channelField, channelName, channelPicker, channelWarnings, checkbox, missingChannelPerms, checkboxInput, choiceField, intField, numberInput,
    isSnowflake, pill, postForm, roleField, rolePicker, selectInput, switchInput, text, textArea, textInput,
} from '../forms.js';
import { registryValue, section, table } from './common.js';
import { isHomeScope } from './serverScope.js';
import { currentText, textFor } from '../language.js';
import { planLimit } from '../../billing/premiumEffects.js';
import { DEFAULT_TIMEZONE, canonicalTimeZone } from '../../../utils/timezone.js';
import {
    INTERVAL_MAX_HOURS, FAILURE_LIMIT, cleanSchedule, formatInZone, nextRunAfter, zonedParts,
} from '../../scheduledMessageService.js';
import {
    COUNTDOWN_MAX_SECONDS, COUNTDOWN_TITLE_MAX, EMBED_COLOURS, EMBED_DESCRIPTION_MAX, EMBED_FOOTER_MAX, EMBED_TITLE_MAX, EMBED_TOTAL_MAX,
    IMAGE_URL_MAX, LINK_BUTTON_LABEL_MAX, LINK_BUTTON_MAX, LINK_BUTTON_URL_MAX, MESSAGE_CONTENT_MAX, NATIVE_POLL_ANSWER_MAX, NATIVE_POLL_DEFAULT_HOURS, NATIVE_POLL_MAX_HOURS, NATIVE_POLL_MIN_HOURS, NATIVE_POLL_QUESTION_MAX,
    PING_USERS_MAX, POLL_MAX_OPTIONS, POLL_OPTION_MAX, POLL_QUESTION_MAX, buildMessageEmbed, colourFromKey, isEmbedImageUrl, isLinkButtonUrl, linkButtonRows, noMentions, parseHexColour, parseMessageLink, pingLine,
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

const FORMATS = ['embed', 'text'];
const MODS_TOKEN = '{mods}';

/**
 * The member pickers of the "New moderators" template (Send only): mod1..modN, prefilled
 * from ?mod1=… (the "Find a member" page sends the picked ID back that way).
 */
function modFields(tr, g, query = {}, back = path('/messages')) {
    return html`<fieldset class="wide"><legend>${tr.tx('messages.fields.mods')}</legend><p class="hint">${tr.tx('messages.fields.modsHelp', { token: MODS_TOKEN })}</p><div class="grid">${Array.from({ length: PING_USERS_MAX }, (_, i) => {
        const name = `mod${i + 1}`;
        return memberField({ name, label: tr.t('messages.fields.mod', { n: i + 1 }), value: pickedFromQuery(query, name), pick: name, back, anchor: 'send-a-message', guild: g });
    })}</div></fieldset>`;
}

/** The "Send a message" fields, prefilled from a stored payload (or empty). `mods` adds the member pickers (New moderators). */
function messageFields(tr, g, { channelId = null, payload = null, mods = null } = {}) {
    const e = payload?.embed || {};
    const hex = Number.isInteger(e.colour) ? `#${e.colour.toString(16).padStart(6, '0').toUpperCase()}` : '';
    const known = hex ? EMBED_COLOURS.find(([, , h]) => h.toUpperCase() === hex) : EMBED_COLOURS[0];
    // A plain message needs no Embed Links; with a box filled in, the post itself checks it.
    const colourName = (key, label) => (tr.has(`messages.colour.${key}`) ? tr.t(`messages.colour.${key}`) : label);
    const buttons = Array.isArray(payload?.buttons) ? payload.buttons : [];
    return html`${channelPicker(g, 'channelId', channelId, { label: tr.t('messages.fields.channel'), perms: PERMS.text, optional: false })}
${selectInput('format', 'embed', [['embed', tr.t('messages.fields.formatEmbed')], ['text', tr.t('messages.fields.formatText')]], { label: tr.t('messages.fields.format'), help: tr.t('messages.fields.formatHelp') })}
${rolePicker(g, 'pingRole', payload?.ping?.roleIds?.[0] || '', { label: tr.t('messages.fields.pingRole'), help: tr.t('messages.fields.pingRoleHelp'), noneLabel: tr.t('messages.fields.pingNone') })}
${checkboxInput('pingEveryone', payload?.ping?.everyone === true, { label: tr.t('messages.fields.pingEveryone'), help: tr.t('messages.fields.pingEveryoneHelp') })}
${mods ? modFields(tr, g, mods.query, mods.back) : ''}
${textArea('content', payload?.content || '', { label: tr.t('messages.fields.content'), max: MESSAGE_CONTENT_MAX, rows: 4, help: tr.t('messages.fields.contentHelp') })}
${textInput('title', e.title || '', { label: tr.t('messages.fields.title'), max: EMBED_TITLE_MAX, help: tr.t('messages.fields.titleHelp') })}
${textArea('description', e.description || '', { label: tr.t('messages.fields.description'), max: EMBED_DESCRIPTION_MAX, rows: 6, help: tr.t('messages.fields.descriptionHelp', { max: tr.fmtNumber(EMBED_TOTAL_MAX) }) })}
${selectInput('colour', known ? known[0] : 'primary', EMBED_COLOURS.map(([key, label, h]) => [key, `${colourName(key, label)} (${h})`]), { label: tr.t('messages.fields.colour') })}
${textInput('hex', known ? '' : hex, { label: tr.t('messages.fields.hex'), max: 7, placeholder: '#9B59B6', help: tr.t('messages.fields.hexHelp') })}
${textInput('imageUrl', e.imageUrl || '', { label: tr.t('messages.fields.imageUrl'), max: IMAGE_URL_MAX, type: 'url', placeholder: 'https://…', help: tr.t('messages.fields.imageUrlHelp') })}
${textInput('footer', e.footer || '', { label: tr.t('messages.fields.footer'), max: EMBED_FOOTER_MAX, help: tr.t('messages.fields.footerHelp') })}
<fieldset class="wide"><legend>${tr.tx('messages.fields.buttons')}</legend><p class="hint">${tr.tx('messages.fields.buttonsHelp', { max: tr.fmtNumber(LINK_BUTTON_MAX) })}</p><div class="grid">${Array.from({ length: LINK_BUTTON_MAX }, (_, i) => html`${textInput(`button${i + 1}Label`, buttons[i]?.label || '', { label: tr.t('messages.fields.buttonLabel', { n: i + 1 }), max: LINK_BUTTON_LABEL_MAX })}
${textInput(`button${i + 1}Url`, buttons[i]?.url || '', { label: tr.t('messages.fields.buttonUrl', { n: i + 1 }), max: LINK_BUTTON_URL_MAX, type: 'url', placeholder: 'https://…' })}`)}</div></fieldset>`;
}

/** Up to LINK_BUTTON_MAX link buttons: label and https link both filled, or both empty. */
function buttonsFromForm(form) {
    const tr = mt();
    const out = [];
    for (let i = 1; i <= LINK_BUTTON_MAX; i += 1) {
        const rawLabel = typeof form?.[`button${i}Label`] === 'string' ? form[`button${i}Label`].trim() : '';
        if (rawLabel.length > LINK_BUTTON_LABEL_MAX) throw new InputError(tr.t('messages.error.buttonLabel', { n: i, max: tr.fmtNumber(LINK_BUTTON_LABEL_MAX) }), 400, `button${i}Label`);
        const url = typeof form?.[`button${i}Url`] === 'string' ? form[`button${i}Url`].trim() : '';
        if (!rawLabel && !url) continue;
        if (!rawLabel || !url) throw new InputError(tr.t('messages.error.buttonHalf', { n: i }), 400, rawLabel ? `button${i}Url` : `button${i}Label`);
        if (!isLinkButtonUrl(url)) throw new InputError(tr.t('messages.error.buttonUrl', { n: i }), 400, `button${i}Url`);
        out.push({ label: rawLabel, url });
    }
    return out;
}

/** The picked moderators (mod1..modN) of the New moderators template: user IDs, no repeats. */
function modsFromForm(form) {
    const ids = [];
    for (let i = 1; i <= PING_USERS_MAX; i += 1) {
        const raw = typeof form?.[`mod${i}`] === 'string' ? form[`mod${i}`].trim() : '';
        if (!raw) continue;
        const id = parseUserRef(raw);
        if (!id) throw new InputError(mt().t('messages.error.modId', { n: i }), 400, `mod${i}`);
        if (!ids.includes(id)) ids.push(id);
    }
    return ids;
}

/**
 * The template a posted form came from (hidden `template`), checked for this server: a
 * home-only id outside Mewvo's own servers is refused (403); an unknown id counts as none.
 */
function postedTemplate(form, home) {
    const id = typeof form?.template === 'string' ? form.template.trim().slice(0, 60) : '';
    if (!id) return null;
    if (isHomeTemplate(id) && !home) throw new InputError(mt().t('messages.error.homeOnly'), 403, 'template');
    return messageTemplate(id, { home });
}

/**
 * The posted message: { channel, content, embed (with colour) | null, ping, buttons, format,
 * audit }. Refuses an empty message, a footer-only embed, a non-https image or button link, a
 * home-only template outside Mewvo's servers, members to ping without the New moderators
 * template (`allowMembers`: Send only), and a channel the bot cannot post in.
 *
 * Plain text (format=text) puts the box parts into the message text: **title**, text, image
 * link, footer as small text. The ping is one picked role and/or a ticked "ping everyone"
 * (plus the picked moderators): exactly what allowedMentions lets through.
 */
function messageFromForm(g, form, { home = true, allowMembers = false } = {}) {
    const tr = mt();
    const template = postedTemplate(form, home);
    const format = text(form, 'format', 10) || 'embed';
    if (!FORMATS.includes(format)) throw new InputError(tr.t('messages.error.format'), 400, 'format');
    let content = longText(form, 'content', MESSAGE_CONTENT_MAX, tr.t('messages.fields.content'));
    const embed = {
        title: text(form, 'title', EMBED_TITLE_MAX),
        description: longText(form, 'description', EMBED_DESCRIPTION_MAX, tr.t('messages.fields.embedDescription')),
        imageUrl: text(form, 'imageUrl', IMAGE_URL_MAX),
        footer: text(form, 'footer', EMBED_FOOTER_MAX),
    };
    if (embed.imageUrl && !isEmbedImageUrl(embed.imageUrl)) {
        throw new InputError(tr.t('messages.error.imageUrl'), 400, 'imageUrl');
    }
    // Members are pinged only with the New moderators template (and only on Send).
    const userIds = modsFromForm(form);
    if (userIds.length && !(allowMembers && template?.members)) throw new InputError(tr.t('messages.error.usersNotAllowed'), 400, 'mod1');
    const fillMods = (value) => (value.includes(MODS_TOKEN) ? value.replaceAll(MODS_TOKEN, userIds.map((id) => `<@${id}>`).join(', ')) : value);
    if ([content, embed.title, embed.description, embed.footer].some((v) => v.includes(MODS_TOKEN)) && !userIds.length) {
        throw new InputError(tr.t('messages.error.modsMissing', { token: MODS_TOKEN }), 400, allowMembers ? 'mod1' : 'description');
    }
    content = fillMods(content);
    embed.title = fillMods(embed.title);
    embed.description = fillMods(embed.description);
    embed.footer = fillMods(embed.footer);

    let hasEmbed = Boolean(embed.title || embed.description || embed.imageUrl || embed.footer);
    if (hasEmbed && format === 'embed' && !embed.title && !embed.description && !embed.imageUrl) {
        throw new InputError(tr.t('messages.error.footerOnly'), 400, 'title');
    }
    if (format === 'text' && hasEmbed) {
        content = [content, embed.title ? `**${embed.title}**` : '', embed.description, embed.imageUrl, embed.footer ? `-# ${embed.footer}` : ''].filter(Boolean).join('\n\n');
        hasEmbed = false;
    }
    // Embed Links only when a box is sent: plain text needs View Channel + Send Messages.
    const channel = postChannel(g, form, hasEmbed ? PERMS.post : PERMS.text);
    if (!content && !hasEmbed) throw new InputError(tr.t('messages.error.empty'), 400, 'content');
    if (hasEmbed && embed.title.length + embed.description.length + embed.footer.length > EMBED_TOTAL_MAX) {
        throw new InputError(tr.t('messages.error.boxTooLong', { max: tr.fmtNumber(EMBED_TOTAL_MAX) }), 400, 'description');
    }
    const roleId = roleField(g, form, 'pingRole', { optional: true, label: tr.t('messages.fields.pingRole') });
    const ping = { everyone: checkbox(form, 'pingEveryone'), roleIds: roleId ? [roleId] : [], userIds };
    const line = pingLine(ping);
    const total = (line ? line.length + 1 : 0) + content.length;
    if (total > MESSAGE_CONTENT_MAX) {
        throw new InputError(tr.t('messages.error.textTooLong', { max: tr.fmtNumber(MESSAGE_CONTENT_MAX), length: tr.fmtNumber(total) }), 400, 'content');
    }
    const buttons = buttonsFromForm(form);
    const colour = colourField(form);
    const cleanPingOut = line ? ping : null;
    return {
        channel, content, embed: hasEmbed ? { ...embed, colour } : null, ping: cleanPingOut, buttons, format, template,
        audit: {
            channelId: channel.id, content: content || null, embed: hasEmbed ? { ...embed, colour: `#${colour.toString(16).padStart(6, '0')}` } : null,
            ...(cleanPingOut ? { ping: cleanPingOut } : {}), ...(buttons.length ? { buttons } : {}), ...(template ? { template: template.id } : {}),
        },
    };
}

/** The payload stored for a scheduled message (botMessageService/scheduledMessageService read it). */
const payloadOf = ({ content, embed, ping, buttons }) => ({ content, embed, ...(ping ? { ping } : {}), ...(buttons?.length ? { buttons } : {}) });

/** Who gets a notification, in words: "@everyone, @Role, @Ann" or "Nobody". */
function pingWords(tr, g, ping) {
    if (!ping) return tr.t('messages.ping.nobody');
    const parts = [
        ping.everyone ? '@everyone' : '',
        ...(ping.roleIds || []).map((id) => `@${g?.roles?.cache?.get(id)?.name || id}`),
        ...(ping.userIds || []).map((id) => {
            const m = g?.members?.cache?.get(id);
            return `@${m?.displayName || m?.user?.username || id}`;
        }),
    ].filter(Boolean);
    return parts.length ? parts.join(', ') : tr.t('messages.ping.nobody');
}

/**
 * Notes for the preview when a picked ping will not notify anyone: Discord only pings a role
 * that is mentionable, and @everyone, when the bot has Mention Everyone in the channel.
 */
function pingNotes(tr, g, channel, ping) {
    if (!ping) return [];
    const me = g?.members?.me;
    const perms = channel?.permissionsFor?.(me) ?? (me?.permissionsIn ? me.permissionsIn(channel) : null);
    const canMentionAll = Boolean(perms?.has?.(PermissionFlagsBits.MentionEveryone));
    const notes = [];
    if (ping.everyone && !canMentionAll) notes.push(tr.t('messages.confirm.everyoneNoPerm', { channel: channel.name }));
    for (const id of ping.roleIds || []) {
        const role = g?.roles?.cache?.get(id);
        if (role && !role.mentionable && !canMentionAll) notes.push(tr.t('messages.confirm.roleNotMentionable', { role: role.name, channel: channel.name }));
    }
    return notes;
}

// ── Templates ─────────────────────────────────────────────────────────────

/** How many of the newest website changelog entries the Changelog template offers. */
export const CHANGELOG_CHOICES = 20;

/** The newest changelog entries: [{ key: 'date:item', date, item }], newest first, at most `max`. */
export function changelogChoices(max = CHANGELOG_CHOICES, entries = CHANGELOG) {
    const out = [];
    for (const entry of entries) {
        for (const item of entry.items) {
            if (out.length >= max) return out;
            out.push({ key: `${entry.date}:${item}`, date: entry.date, item });
        }
    }
    return out;
}

/** The entries ticked in ?entry= (one or several; unknown ones ignored). None ticked → the newest day's entries. */
export function pickedChangelog(query, choices = changelogChoices()) {
    const raw = query?.entry;
    const wanted = new Set((Array.isArray(raw) ? raw : [raw]).filter((v) => typeof v === 'string'));
    const picked = choices.filter((c) => wanted.has(c.key));
    return picked.length ? picked : choices.filter((c) => c.date === choices[0]?.date);
}

/** The {changes} text in `lang`: per day the date in bold, then one "- " line per entry (the website's text). */
export function changelogText(picked, lang = 'en') {
    const t = translator(lang);
    const days = [];
    for (const c of picked) {
        let day = days.find((d) => d.date === c.date);
        if (!day) days.push(day = { date: c.date, items: [] });
        day.items.push(t.t(changelogKey(c.date, c.item)));
    }
    return days.map((d) => `**${t.fmtDate(new Date(`${d.date}T00:00:00Z`))}**\n${d.items.map((i) => `- ${i}`).join('\n')}`).join('\n\n');
}

/** A language code from ?lang= (one of the 8), else `fallback`. */
function queryLang(query, fallback = 'en') {
    const value = typeof query?.lang === 'string' ? query.lang.trim() : '';
    return LANG_CODES.includes(value) ? value : (LANG_CODES.includes(fallback) ? fallback : 'en');
}

/**
 * The template asked for in ?template=, filled for this server: { template, payload, lang,
 * wanted, changelog } or null. An unknown id gives { unknown: true }; a home-only id outside
 * Mewvo's own servers { homeOnly: true } (nothing is filled either way).
 * options: home (isHomeScope), lang (default language: the server's bot language), serverCount.
 */
export function chosenTemplate(query, serverName, { home = false, lang = 'en', serverCount = null } = {}) {
    const id = typeof query?.template === 'string' ? query.template.trim().slice(0, 60) : '';
    if (!id) return null;
    if (isHomeTemplate(id) && !home) return { homeOnly: true };
    const template = messageTemplate(id, { home });
    if (!template) return { unknown: true };
    const wanted = queryLang(query, lang);
    const used = templateLanguages(template).includes(wanted) ? wanted : 'en';
    const choices = template.changelog ? changelogChoices() : null;
    const picked = choices ? pickedChangelog(query, choices) : null;
    const count = template.serverCount && Number.isInteger(serverCount) ? translator(used).fmtNumber(serverCount) : null;
    const filled = fillTemplate(template, { server: serverName, lang: used, count, changes: picked ? changelogText(picked, used) : null });
    return {
        template, lang: filled.lang, wanted, changelog: choices ? { choices, picked } : null,
        payload: { content: '', embed: { title: filled.title, description: filled.text.slice(0, EMBED_DESCRIPTION_MAX), colour: colourFromKey(filled.colour) } },
    };
}

const languageName = (code) => LANGUAGES.find((l) => l.code === code)?.name || code;

/** The Changelog template's entry list: a GET form of tick boxes (no script), back to the same template. */
function changelogPicker(tr, chosen) {
    const t = translator(chosen.lang);
    const picked = new Set(chosen.changelog.picked.map((c) => c.key));
    const shorten = (s) => (s.length > 140 ? `${s.slice(0, 139)}…` : s);
    return html`<form method="get" action="${path('/messages')}#s-send-a-message" class="settings-form"><input type="hidden" name="template" value="${chosen.template.id}"><input type="hidden" name="lang" value="${chosen.wanted}">
<fieldset class="wide"><legend>${tr.tx('messages.template.changelogTitle')}</legend><p class="hint">${tr.tx('messages.template.changelogHint')}</p>
${chosen.changelog.choices.map((c) => html`<label class="check"><input type="checkbox" name="entry" value="${c.key}"${picked.has(c.key) ? raw(' checked') : ''}> <b>${c.date}</b> ${shorten(t.t(changelogKey(c.date, c.item)))}</label>`)}</fieldset>
<div class="form-actions"><button type="submit" class="secondary">${tr.tx('messages.template.changelogUse')}</button></div></form>`;
}

/** The grouped template list and its language (a GET form, no script) and, when one is chosen, what to do next. */
function templatePicker(tr, chosen, { home = false, lang = 'en' } = {}) {
    const current = chosen?.template?.id || '';
    const wanted = chosen?.wanted || lang;
    const langNote = chosen?.template
        ? (chosen.lang === chosen.wanted
            ? tr.tx('messages.template.filledLang', { language: languageName(chosen.lang) })
            : tr.tx('messages.template.noTranslation', { language: languageName(chosen.wanted) }))
        : '';
    const note = chosen?.homeOnly
        ? html`<p class="warn">${tr.tx('messages.template.homeOnly')}</p>`
        : chosen?.unknown
            ? html`<p class="warn">${tr.tx('messages.template.unknown')}</p>`
            : chosen ? html`<p class="ok">${tr.tx('messages.template.filled', { name: chosen.template.name })} ${langNote}</p>` : '';
    return html`${note}<form method="get" action="${path('/messages')}#s-send-a-message" class="settings-form"><div class="grid">
<label>${tr.tx('messages.template.label')}<select name="template">${templatesByGroup({ home }).map((g) => html`<optgroup label="${g.label}">${g.templates.map((t) => html`<option value="${t.id}"${t.id === current ? raw(' selected') : ''}>${t.name}</option>`)}</optgroup>`)}</select><span class="hint">${tr.tx('messages.template.hint')}</span></label>
${selectInput('lang', wanted, LANGUAGES.map((l) => [l.code, l.name]), { label: tr.t('messages.template.language'), help: tr.t('messages.template.languageHint') })}</div>
<div class="form-actions"><button type="submit" class="secondary">${tr.tx('messages.template.use')}</button></div></form>
${chosen?.changelog ? changelogPicker(tr, chosen) : ''}`;
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
    const line = payload?.ping ? pingLine(payload.ping) : '';
    const buttons = Array.isArray(payload?.buttons) ? payload.buttons : [];
    return html`<div class="msg-preview"><p class="muted">${tr.t('messages.preview.title')}</p>${line ? html`<p class="muted">${tr.tx('messages.preview.ping', { who: line })}</p>` : ''}${payload?.content ? html`<p class="msg-text">${payload.content}</p>` : ''}${e && (e.title || e.description || e.imageUrl || e.footer)
        ? html`<div class="msg-embed">${e.title ? html`<p><b>${e.title}</b></p>` : ''}${e.description ? html`<p class="msg-text">${e.description}</p>` : ''}${e.imageUrl ? html`<p class="muted">${tr.tx('messages.preview.image', { url: e.imageUrl })}</p>` : ''}${e.footer ? html`<p class="muted">${e.footer}</p>` : ''}</div>` : ''}
${buttons.length ? html`<p class="muted">${tr.tx('messages.preview.buttons', { list: buttons.map((b) => `[${b.label}] ${b.url}`).join(', ') })}</p>` : ''}
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
    // The link buttons come along; the ping does not (a DM test never pings anyone).
    const components = linkButtonRows(payload?.buttons || []);
    try {
        await user.send({ ...(text ? { content: text } : {}), ...(embed ? { embeds: [embed] } : {}), ...(components.length ? { components } : {}), allowedMentions: noMentions() });
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
    help: 'Post a message as Mewvo: an announcement right now or later, a message that repeats, a poll, or a countdown. Text you type here never pings anyone; only a role, or everyone, that you pick gets a notification. Everything here needs the Administrator permission in this server.',

    async load(ctx) {
        const [config, scheduled] = await Promise.all([
            ctx.services.getGuildConfig(ctx.client, ctx.guildId),
            ctx.services.listScheduledMessages(ctx.guildId),
        ]);
        // Mewvo's open Discord polls for "End a poll" (pollList.js); null = could not be loaded.
        const openPolls = typeof ctx.services.openPollsFor === 'function'
            ? await ctx.services.openPollsFor(ctx.guild, ctx.guildId).catch(() => null)
            : { polls: [], partial: false };
        // The template language defaults to the server's bot language (Bot language page). Only a
        // default for the language picker: if it cannot be read, English is preselected (nothing is saved).
        let botLanguage = null;
        try {
            botLanguage = await registryValue(ctx, 'botLanguage');
        } catch {
            botLanguage = null;
        }
        return { scheduled, timezone: canonicalTimeZone(config?.birthdayTimezone) || DEFAULT_TIMEZONE, openPolls, botLanguage: LANG_CODES.includes(botLanguage) ? botLanguage : 'en' };
    },

    render(ctx, data = {}) {
        const g = ctx.guild;
        const tr = textFor(ctx);
        const scheduled = data.scheduled || [];
        const canPost = ctx.canEdit && ctx.canAct;
        const adminNote = ctx.canAct ? '' : ` ${tr.t('messages.adminNote')}`;
        const home = isHomeScope(ctx);
        const lang = data.botLanguage || 'en';
        const serverCount = ctx.client?.guilds?.cache?.size;
        const chosen = chosenTemplate(ctx.query, g?.name, { home, lang, serverCount: Number.isInteger(serverCount) ? serverCount : null });
        const prefill = chosen?.payload ? { payload: chosen.payload } : {};
        // The template id goes along (hidden) so the server can refuse a home-only one elsewhere
        // and allow member pings only for New moderators.
        const hidden = chosen?.template ? { template: chosen.template.id } : {};
        const modsBack = chosen?.template?.members
            ? path(`/messages${queryString({ template: chosen.template.id, lang: chosen.wanted, ...Object.fromEntries(Array.from({ length: PING_USERS_MAX }, (_, i) => [`mod${i + 1}`, pickedFromQuery(ctx.query, `mod${i + 1}`)])) })}`)
            : null;
        const send = postForm(ctx, 'messages', 'send', html`<div class="grid">${messageFields(tr, g, { ...prefill, mods: modsBack ? { query: ctx.query, back: modsBack } : null })}</div>`,
            { submit: tr.t('messages.send.submit'), canEdit: canPost, hidden });
        const schedule = postForm(ctx, 'messages', 'schedule', html`<div class="grid">${messageFields(tr, g, prefill)}</div>${scheduleFields(tr, null, data.timezone || DEFAULT_TIMEZONE)}`,
            { submit: tr.t('messages.schedule.submit'), canEdit: canPost, hidden });
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
        return html`${section(tr.t('messages.template.title'), templatePicker(tr, chosen, { home, lang }), tr.t('messages.template.help'), { key: 'start-from-a-template' })}
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
            // Two steps (routes.js): confirm() checks the form and shows the preview (channel,
            // who gets pinged, format, buttons, the message); run() gets the stored form back
            // with the one-time token and checks everything again before posting.
            async confirm(ctx, form) {
                const tr = textFor(ctx);
                const g = ctx.guild;
                const msg = messageFromForm(g, form, { home: isHomeScope(ctx), allowMembers: true });
                return {
                    heading: tr.t('messages.confirm.heading', { channel: msg.channel.name }),
                    rows: [
                        { label: tr.t('messages.confirm.channel'), value: `#${msg.channel.name}` },
                        { label: tr.t('messages.confirm.ping'), value: pingWords(tr, g, msg.ping) },
                        { label: tr.t('messages.confirm.format'), value: tr.t(msg.embed ? 'messages.fields.formatEmbed' : 'messages.fields.formatText') },
                        { label: tr.t('messages.confirm.buttons'), value: msg.buttons.length ? msg.buttons.map((b) => `${b.label} (${b.url})`).join(', ') : tr.t('messages.confirm.noButtons') },
                        { label: tr.t('messages.confirm.message'), value: messagePreview(payloadOf(msg)) },
                    ],
                    notes: pingNotes(tr, g, msg.channel, msg.ping),
                    submit: tr.t('messages.confirm.submit'),
                };
            },
            async run(ctx, form) {
                const g = ctx.guild;
                const { channel, content, embed, ping, buttons, audit } = messageFromForm(g, form, { home: isHomeScope(ctx), allowMembers: true });
                const { message } = await ctx.services.postBotMessage(g, { channel, content, embed, ping, buttons });
                return {
                    changes: [{ key: `message.${message.id}`, old: null, new: audit }],
                    message: textFor(ctx).t('messages.action.posted', { channel: channel.name }),
                };
            },
        },
        schedule: {
            admin: true,
            async run(ctx, form) {
                const msg = messageFromForm(ctx.guild, form, { home: isHomeScope(ctx) });
                const { channel } = msg;
                const { schedule, timezone } = scheduleFromForm(form);
                const row = await ctx.services.createScheduledMessage({
                    guildId: ctx.guildId, channelId: channel.id, payload: payloadOf(msg), schedule, timezone, createdBy: ctx.actor.userId,
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
                const msg = messageFromForm(ctx.guild, form, { home: isHomeScope(ctx) });
                const { channel } = msg;
                const { schedule, timezone } = scheduleFromForm(form);
                const { before, after } = await ctx.services.updateScheduledMessage(ctx.guildId, id, { channelId: channel.id, payload: payloadOf(msg), schedule, timezone });
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
