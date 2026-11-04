// Message templates (config/messageTemplates.js), the plain-voice default texts and the
// rules library consequences: Discord limits, the style guide (no marketing phrases, no
// emoji strings, no em dashes, "!" only once and only in a celebratory text), and that a
// consequence still fits the /enforcements confirm hint and the rules post.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MESSAGE_TEMPLATES, MESSAGE_TEMPLATE_GROUPS, fillTemplate, messageTemplate, templatesByGroup } from '../src/config/messageTemplates.js';
import { RULES_LIBRARY } from '../src/config/rulesLibrary.js';
import { BotConfig } from '../src/config/bot.js';
import { DEFAULT_TICKET_BUTTON_LABEL, DEFAULT_TICKET_PANEL_MESSAGE } from '../src/services/ticketPanelService.js';
import { mainAppealPanel, supportAppealPanel } from '../src/services/enforcement/appealPanelService.js';
import { EMBED_COLOURS, EMBED_DESCRIPTION_MAX, EMBED_TITLE_MAX, EMBED_TOTAL_MAX } from '../src/services/botMessageService.js';
import { RULES_LIMITS } from '../src/services/settings/settingsRegistry.js';
import { chosenTemplate } from '../src/services/dashboard/modules/messages.js';

// The style guide's banned phrases (case-insensitive) and emoji strings.
const BANNED = [
    /hey there/i, /thrilled/i, /\bexcited\b/i, /feel free/i, /don'?t hesitate/i, /do not hesitate/i, /seamless/i,
    /dive in/i, /\belevate/i, /\bembark/i, /\blet'?s\b/i, /journey/i, /vibrant/i, /please note/i, /—/,
    /🚀/u, /✨/u, /\p{Extended_Pictographic}\s*\p{Extended_Pictographic}/u,
];

/** Problems with one text: banned phrases, more than one emoji, "!" (one allowed when celebratory). */
function voiceProblems(text, { celebrate = false } = {}) {
    const problems = BANNED.filter((re) => re.test(text)).map((re) => `banned: ${re}`);
    const emoji = text.match(/\p{Extended_Pictographic}/gu) || [];
    if (emoji.length > 1) problems.push(`${emoji.length} emoji`);
    // "!" as punctuation only (not Discord's ||spoiler|| or a markdown image).
    const bangs = (text.match(/[A-Za-z0-9.)\]]!(?=\s|$)/g) || []).length;
    if (bangs > (celebrate ? 1 : 0)) problems.push(`${bangs} exclamation mark(s)`);
    return problems;
}

test('voiceProblems catches what the style guide bans', () => {
    assert.ok(voiceProblems('Hey there! We are thrilled to have you 🚀✨').length >= 4);
    assert.ok(voiceProblems("Let's dive in — feel free to ask.").length >= 3);
    assert.deepEqual(voiceProblems('Happy birthday!', { celebrate: true }), []);
    assert.equal(voiceProblems('Happy birthday!').length, 1);
    assert.equal(voiceProblems('Big news! Great! ', { celebrate: true }).length, 1);
    assert.deepEqual(voiceProblems('Press the button below to open a ticket.'), []);
});

test('templates: at least 40, unique ids, known groups and colours, every group fits a Discord select', () => {
    assert.ok(MESSAGE_TEMPLATES.length >= 40, `${MESSAGE_TEMPLATES.length} templates`);
    assert.equal(new Set(MESSAGE_TEMPLATES.map((t) => t.id)).size, MESSAGE_TEMPLATES.length, 'unique ids');
    const groups = new Set(MESSAGE_TEMPLATE_GROUPS.map((g) => g.key));
    const colours = new Set(EMBED_COLOURS.map(([key]) => key));
    for (const t of MESSAGE_TEMPLATES) {
        assert.match(t.id, /^[a-z0-9-]{1,40}$/, t.id);
        assert.ok(groups.has(t.group), `${t.id}: group ${t.group}`);
        assert.ok(colours.has(t.colour), `${t.id}: colour ${t.colour}`);
        assert.ok(t.name.length > 0 && t.name.length <= 100, `${t.id}: picker label length`);
    }
    for (const g of templatesByGroup()) assert.ok(g.templates.length <= 25, `${g.key}: ${g.templates.length} (a select holds 25)`);
    assert.ok(MESSAGE_TEMPLATE_GROUPS.length <= 25);
    assert.equal(templatesByGroup().reduce((n, g) => n + g.templates.length, 0), MESSAGE_TEMPLATES.length, 'every template is in a group');
});

test('templates: within Discord embed limits even with a 100-character server name', () => {
    const longName = 'S'.repeat(100);
    for (const t of MESSAGE_TEMPLATES) {
        const { title, text } = fillTemplate(t, { server: longName });
        assert.ok(title.length > 0 && title.length <= EMBED_TITLE_MAX, `${t.id}: title ${title.length}`);
        assert.ok(text.length > 0 && text.length <= EMBED_DESCRIPTION_MAX, `${t.id}: text ${text.length}`);
        assert.ok(title.length + text.length <= EMBED_TOTAL_MAX, `${t.id}: total`);
        assert.ok(text.length <= 1600, `${t.id}: realistic length (${text.length})`);
        assert.ok(!text.includes('{server}') && !title.includes('{server}'), `${t.id}: {server} filled`);
        assert.ok(!/\{(?!server\})[a-z.]+\}/i.test(t.text + t.title), `${t.id}: only {server} as a placeholder`);
        assert.ok(!/@(everyone|here)/.test(text), `${t.id}: no mass mention text`);
    }
});

test('templates: plain voice (no banned phrases or emoji strings; "!" only once in a celebratory one)', () => {
    for (const t of MESSAGE_TEMPLATES) {
        assert.deepEqual(voiceProblems(`${t.name}\n${t.title}\n${t.text}`, { celebrate: t.celebrate === true }), [], t.id);
    }
});

test('templates: the support server set covers the real appeal flow', () => {
    for (const id of ['appeal-overview', 'appeal-ban', 'appeal-kick', 'appeal-mute', 'appeal-warn', 'ticket-howto', 'modmail-howto', 'staff-reports', 'support-hours', 'appeal-status', 'appeals-paused']) {
        assert.ok(messageTemplate(id)?.group === 'support', id);
    }
    const overview = messageTemplate('appeal-overview').text;
    for (const part of [/case code/i, /Appeal button/, /One appeal per case/i, /after 7 days/, /within 30 days/, /by DM/, /honest/i, /My appeals/]) {
        assert.match(overview, part);
    }
    assert.match(messageTemplate('staff-reports').text, /one open report at a time and send up to three a day/);
});

test('fillTemplate and chosenTemplate: server name filled, unknown ids and empty queries handled', () => {
    const t = messageTemplate('support-welcome');
    assert.equal(fillTemplate(t, { server: 'Cats' }).title, 'Welcome to Cats');
    assert.equal(fillTemplate(t, {}).title, 'Welcome to the server');
    assert.equal(chosenTemplate({}, 'Cats'), null);
    assert.equal(chosenTemplate({ template: ['a', 'b'] }, 'Cats'), null, 'repeated keys (arrays) are ignored');
    assert.deepEqual(chosenTemplate({ template: 'nope' }, 'Cats'), { unknown: true });
    const chosen = chosenTemplate({ template: 'scam-dm' }, 'Cats');
    assert.equal(chosen.template.id, 'scam-dm');
    assert.equal(chosen.payload.content, '');
    assert.match(chosen.payload.embed.description, /pretending to be from Cats/);
    assert.equal(chosen.payload.embed.colour, Number.parseInt(EMBED_COLOURS.find(([k]) => k === 'red')[2].slice(1), 16));
});

test('default texts a server posts are in the same plain voice', () => {
    const defaults = {
        ticketPanel: DEFAULT_TICKET_PANEL_MESSAGE,
        ticketButton: DEFAULT_TICKET_BUTTON_LABEL,
        verification: BotConfig.verification.defaultMessage,
        welcome: BotConfig.welcome.defaultWelcomeMessage,
        goodbye: BotConfig.welcome.defaultGoodbyeMessage,
        mainAppealPanel: mainAppealPanel().embeds[0].data.description,
        supportAppealPanel: supportAppealPanel().embeds[0].data.description,
    };
    for (const [name, value] of Object.entries(defaults)) {
        assert.equal(typeof value, 'string', name);
        assert.deepEqual(voiceProblems(value), [], name);
    }
    assert.ok(!/click the button below/i.test(DEFAULT_TICKET_PANEL_MESSAGE + BotConfig.verification.defaultMessage));
    // The ticket dashboard (/ticket dashboard) shows the default as a modal placeholder: at most 100.
    assert.ok(DEFAULT_TICKET_PANEL_MESSAGE.length <= 100);
});

test('rules library: graduated consequences, one line, fit the confirm hint and the rules post', () => {
    for (const entry of RULES_LIBRARY) {
        const { key, title, text, consequence } = entry;
        assert.ok(consequence.length > 0 && consequence.length <= RULES_LIMITS.consequenceMax, `${key}: consequence ${consequence.length}`);
        assert.ok(!/[\r\n]/.test(consequence), `${key}: one line`);
        assert.ok(!/\.$/.test(consequence), `${key}: no full stop at the end (the hint adds one)`);
        assert.deepEqual(voiceProblems(`${title}\n${text}\n${consequence}`), [], key);
        // /enforcements confirm hint (serverRules.ruleHintFor) with the longest rule number and title.
        const hint = `Rule 30: ${'x'.repeat(RULES_LIMITS.titleMax)}. Listed consequence: ${consequence}.`;
        assert.ok(hint.length <= 300, `${key}: hint ${hint.length}`);
        // Fields layout of the rules post: "<n>. <title> · <consequence>" is an embed field name (≤ 256).
        assert.ok(`30. ${title} · ${consequence}`.length <= 256, `${key}: field name`);
    }
    const byKey = Object.fromEntries(RULES_LIBRARY.map((r) => [r.key, r.consequence]));
    // Realistic: not everything is a warning or a permanent ban.
    assert.match(byKey.respect, /1-hour mute.*1-day ban/);
    assert.match(byKey.hate, /^7-day ban/);
    assert.match(byKey.harassment, /^1-day mute/);
    assert.match(byKey.staff, /kick$/);
    assert.equal(byKey.doxxing, 'Permanent ban');
    assert.ok(RULES_LIBRARY.filter((r) => r.consequence === 'Permanent ban').length <= 3, 'only the worst rules are a straight permanent ban');
    for (const key of ['begging', 'minimod', 'language', 'debates', 'voice', 'evasion', 'spoilers', 'names']) assert.ok(byKey[key], `${key} in the library`);
});
