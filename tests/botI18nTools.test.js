// /tools, /countdown, /poll, /shorten in 8 languages (catalog namespace tools): English output
// byte-for-byte as before, other languages translated with Discord markup and values intact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import { LANG_CODES, botText } from '../src/utils/botText.js';
import { getColorName } from '../src/commands/Tools/modules/tools_hexcolor.js';
import { memberFields } from '../src/commands/Tools/modules/tools_randomuser.js';
import { createControlButtons, countdownButtonHandler } from '../src/handlers/countdownButtons.js';
import poll from '../src/commands/Tools/poll.js';
import tools from '../src/commands/Tools/tools.js';

const en = botText('en');
const OTHERS = LANG_CODES.filter((c) => c !== 'en');

test('English tool texts are exactly the old template strings', () => {
    const now = new Date(Date.UTC(2026, 10, 8, 12, 0, 0));
    const unix = Math.floor(now.getTime() / 1000);
    assert.equal(en.t('tools.unixtime.body', { seconds: unix, ms: now.getTime(), utc: now.toUTCString(), iso: now.toISOString() }),
        `**Seconds since Unix Epoch:** \`${unix}\`\n**Milliseconds since Unix Epoch:** \`${now.getTime()}\`\n\n**Human-readable (UTC):** ${now.toUTCString()}\n**ISO String:** ${now.toISOString()}`);
    assert.equal(en.t('tools.time.body', { zone: 'UTC', time: 'T', unix, iso: now.toISOString() }), `**UTC:** T\n**Unix Timestamp:** \`${unix}\`\n**ISO String:** \`${now.toISOString()}\``);
    assert.equal(en.t('tools.hexcolor.body', { hex: '#FF0000', rgb: 'rgb(255, 0, 0)', hsl: 'hsl(0, 100%, 50%)', name: 'Red' }),
        '**Hex:** `#FF0000`\n**RGB:** `rgb(255, 0, 0)`\n**HSL:** `hsl(0, 100%, 50%)`\n**Name:** Red');
    assert.equal(en.t('tools.password.body', { password: 'abc', length: en.tp('tools.password.characters', 16), strength: 'Strong', contains: 'Lowercase, Numbers' }),
        '**Password:** ||`abc`||\n**Length:** 16 characters\n**Strength:** Strong\n**Contains:** Lowercase, Numbers');
    assert.equal(en.t('tools.calculate.resultBody', { expression: '2+2', result: '4' }), '**Expression:** `2+2`\n**Result:** `4`\n\n-# Use the buttons to keep calculating with this result.');
    assert.equal(en.t('tools.calculate.operandLabel', { operator: '+', result: '4' }), 'Number to + with 4');
    assert.equal(en.t('tools.calculate.modalTitle.subtract'), 'Enter a number to subtract');
    assert.equal(en.t('tools.baseconvert.fromTo', { fromName: 'Binary', fromBase: 'BIN', from: '0b1010', toName: 'Decimal', toBase: 'DEC', to: '10', decimal: '10' }),
        '**From Binary (BIN):** `0b1010`\n**To Decimal (DEC):** `10`\n**Decimal:** `10`');
    assert.equal(en.t('tools.baseconvert.badInput', { input: '5', alphabet: '01', examples: en.t('tools.baseconvert.example.BIN') }),
        'You provided: `5`\n\nValid characters: `01`\n\n**Valid:** 101, 1010, 11111 | **Invalid:** 5 (digit 5 not allowed)');
    assert.equal(en.t('tools.countdown.remaining', { time: '01:30', ends: '<t:1:R>' }), 'Time remaining: **01:30** (ends <t:1:R>)');
    assert.equal(en.t('tools.countdown.finishedTitle', { title: 'Launch' }), 'Launch (finished)');
    assert.equal(en.t('tools.poll.posted', { unix: 5, url: 'https://x' }), 'Poll posted. It closes <t:5:F> (<t:5:R>). To close it early, use /poll end with this link: https://x');
    assert.equal(en.t('tools.poll.reactionPosted', { ignored: en.t('tools.poll.ignored') }), 'Reaction poll posted. Hours and multiple only apply to Discord polls, so they were ignored.');
    assert.equal(en.t('tools.shorten.body', { url: 'https://is.gd/a' }), "Here's your shortened URL: https://is.gd/a");
});

test('hex colour names: English unchanged, translated otherwise; "close to" keeps the name', () => {
    assert.equal(getColorName('#FF0000', en), 'Red');
    assert.equal(getColorName('#FE0001', en), 'Close to Red');
    assert.equal(getColorName('#FF0000', botText('de')), 'Rot');
    assert.equal(getColorName('#FE0001', botText('de')), 'Ähnlich wie Rot');
});

test('random member fields: English unchanged; other languages translated, role mentions kept', () => {
    const roles = ['<@&1>', '<@&2>', '<@&3>', '<@&4>', '<@&5>', '<@&6>'];
    assert.deepEqual(memberFields(en, { username: 'kit', bot: false }, roles), [
        { name: 'Username', value: 'kit', inline: true },
        { name: 'Bot', value: 'No', inline: true },
        { name: 'Roles (6)', value: '<@&1><@&2><@&3><@&4><@&5>+1 more', inline: false },
    ]);
    assert.equal(memberFields(en, { username: 'kit', bot: true }, [])[2].value, 'No roles');
    const ru = memberFields(botText('ru'), { username: 'kit', bot: true }, roles);
    assert.equal(ru[0].name, 'Имя пользователя');
    assert.equal(ru[1].value, 'Да');
    assert.ok(ru[2].value.startsWith('<@&1><@&2>'));
});

test('countdown buttons: English labels unchanged, translated per language', () => {
    const labels = (lang, paused) => createControlButtons('c1', paused, { lang }).components.map((b) => b.data.label);
    assert.deepEqual(labels(undefined, false), ['Pause', 'Cancel']);
    assert.deepEqual(labels('en', true), ['Resume', 'Cancel']);
    for (const lang of OTHERS) assert.notDeepEqual(labels(lang, false), ['Pause', 'Cancel'], lang);
});

test('countdown button on an ended countdown: the clicker\'s language (ephemeral)', async () => {
    const replies = [];
    const interaction = (locale) => ({ locale, guildId: '1', user: { id: '2' }, customId: 'countdown_pause:none', async reply(p) { replies.push(p); } });
    await countdownButtonHandler(interaction('en-US'), {}, ['none']);
    await countdownButtonHandler(interaction('fr'), {}, ['none']);
    assert.equal(replies[0].content, 'This countdown has expired or was cancelled.');
    assert.equal(replies[1].content, 'Ce compte à rebours est terminé ou a été annulé.');
});

test('password length plural forms', () => {
    assert.equal(botText('ru').tp('tools.password.characters', 21), '21 символ');
    assert.equal(botText('ru').tp('tools.password.characters', 22), '22 символа');
    assert.equal(botText('pl').tp('tools.password.characters', 25), '25 znaków');
    assert.equal(en.tp('tools.password.characters', 16), '16 characters');
});

function pollInteraction(locale) {
    const replies = [];
    const channel = {
        id: '500000000000000001', name: 'general', type: ChannelType.GuildText, isThread: () => false,
        permissionsFor: () => ({ has: () => true }),
        async send() { return { id: '710000000000000001', url: 'https://discord.com/channels/1/2/3', async react() {} }; },
    };
    const interaction = {
        id: '1', locale, deferred: true, replied: false, createdTimestamp: Date.now(), user: { id: '2' }, guildId: '100000000000000001',
        guild: { id: '100000000000000001', members: { me: { id: 'bot' } } }, channel,
        options: {
            getSubcommand: () => 'create',
            getString: (name) => ({ question: 'Pizza?', option1: 'Yes', option2: 'No' })[name] ?? null,
            getInteger: () => null,
            getBoolean: () => null,
        },
        isRepliable: () => true,
        async editReply(payload) { replies.push(payload); return {}; },
    };
    return { interaction, replies };
}

test('/poll create: the confirmation is in the user\'s language; the poll text stays as typed', async () => {
    const de = pollInteraction('de');
    await poll.execute(de.interaction);
    assert.match(de.replies.at(-1).content, /^Umfrage gepostet\. Sie endet <t:\d+:F> \(<t:\d+:R>\)\..*\/poll end.*https:\/\/discord\.com\/channels\/1\/2\/3$/);
    const enReply = pollInteraction('en-GB');
    await poll.execute(enReply.interaction);
    assert.match(enReply.replies.at(-1).content, /^Poll posted\. It closes <t:\d+:F>/);
});

test('/tools: the merged subcommands carry description localizations; English text unchanged', () => {
    const json = tools.data.toJSON();
    assert.equal(json.description, 'Small utilities: calculator, converters, passwords and more');
    assert.equal(json.description_localizations.de, 'Kleine Helfer: Rechner, Umrechner, Passwörter und mehr');
    const calculate = json.options.find((o) => o.name === 'calculate');
    assert.equal(calculate.description, 'Evaluate a math expression');
    assert.equal(calculate.description_localizations['en-US'], 'Evaluate a math expression');
    assert.equal(calculate.options[0].description_localizations['pt-BR'], 'A expressão a calcular (ex.: 2+2*3, sin(45 deg), 16^0.5)');
});
