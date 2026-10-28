// messages.js — Messages: post as the bot from the web. A message and/or embed (replaces
// /embedbuilder), a reaction poll (/poll) and a countdown (/countdown). Everything goes
// through services/botMessageService.js, the same functions /poll and /countdown use:
// allowedMentions { parse: [] } (typed text never pings) and the bot's permissions in
// the channel are checked before anything is posted. Administrator only.

import { html } from '../html.js';
import {
    InputError, PERMS, channelField, channelPicker, channelWarnings, checkbox, intField, numberInput, postForm, selectInput,
    switchInput, text, textArea, textInput,
} from '../forms.js';
import { section } from './common.js';
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

function clock(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return [h ? `${h} h` : '', m ? `${m} min` : '', s ? `${s} s` : ''].filter(Boolean).join(' ');
}

export default {
    key: 'messages',
    label: 'Messages',
    help: 'Post as the bot: a message or embed, a poll, or a countdown. Replaces /embedbuilder, /poll and /countdown. Typed text never pings anyone. Everything here needs Administrator in the main server.',

    async load() {
        return {};
    },

    render(ctx) {
        const g = ctx.guild;
        const canPost = ctx.canEdit && ctx.canAct;
        const adminNote = ctx.canAct ? '' : ' Posting needs Administrator in the main server.';
        const send = postForm(ctx, 'messages', 'send', html`<div class="grid">
${channelPicker(g, 'channelId', null, { label: 'Channel', perms: PERMS.post, optional: false })}
${textArea('content', '', { label: 'Message text', max: MESSAGE_CONTENT_MAX, rows: 4, help: `Optional when the embed is filled in. ${NO_PINGS}` })}
${textInput('title', '', { label: 'Embed title', max: EMBED_TITLE_MAX })}
${textArea('description', '', { label: 'Embed description', max: EMBED_DESCRIPTION_MAX, rows: 6, help: `Discord markdown works. Title, description and footer together: at most ${EMBED_TOTAL_MAX} characters.` })}
${selectInput('colour', 'primary', EMBED_COLOURS.map(([key, label, hex]) => [key, `${label} (${hex})`]), { label: 'Embed colour' })}
${textInput('hex', '', { label: 'Or a hex colour', max: 7, placeholder: '#9B59B6', help: 'When filled in, it replaces the colour above.' })}
${textInput('imageUrl', '', { label: 'Image URL', max: IMAGE_URL_MAX, type: 'url', placeholder: 'https://…', help: 'Optional. A full https:// link to an image.' })}
${textInput('footer', '', { label: 'Embed footer', max: EMBED_FOOTER_MAX, help: 'Optional small text under the embed.' })}</div>`,
        { submit: 'Post message', canEdit: canPost });
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
${section('Start a poll', poll, `Same as /poll.${adminNote}`)}
${section('Start a countdown', countdown, `Same as /countdown: up to 24 hours, with Pause and Cancel buttons for Administrators. A bot restart stops running countdowns.${adminNote}`)}`;
    },

    actions: {
        send: {
            admin: true,
            async run(ctx, form) {
                const g = ctx.guild;
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
                const { message } = await ctx.services.postBotMessage(g, {
                    channel, content, embed: hasEmbed ? { ...embed, colour } : null,
                });
                return {
                    changes: [{
                        key: `message.${message.id}`, old: null,
                        new: { channelId: channel.id, content: content || null, embed: hasEmbed ? { ...embed, colour: `#${colour.toString(16).padStart(6, '0')}` } : null },
                    }],
                    message: `Posted in #${channel.name}.`,
                };
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
