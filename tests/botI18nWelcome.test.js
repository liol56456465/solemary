// Bot i18n, Welcome area (namespace `welcome`): /welcome, /goodbye, /greet, /autorole, the greet
// dashboard and the welcome/goodbye posts. Parity per language, Discord length limits, English
// output unchanged, the server's language for the posts, admin text never translated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANG_CODES, placeholdersOf } from '../src/services/site/i18n.js';
import { BOT_CATALOG, botText } from '../src/utils/botText.js';
import { DISCORD_LOCALES_BY_LANG as DISCORD_LOCALES } from '../src/utils/commandLocalizations.js';
import { defaultWelcomeText } from '../src/events/guildMemberAdd.js';
import { defaultGoodbyeText } from '../src/events/guildMemberRemove.js';

const KEYS = BOT_CATALOG.catalogKeys('en').filter((k) => k.startsWith('welcome.'));
const user = { id: '111', tag: 'ana#0', username: 'ana', toString: () => '<@111>' };
const guild = { id: '222', name: 'Cats {user}', memberCount: 42 };

test('welcome: every key in all 8 languages with the same placeholders, and no extra keys', () => {
    assert.ok(KEYS.length > 100, `${KEYS.length} keys`);
    for (const lang of LANG_CODES) {
        const keys = BOT_CATALOG.catalogKeys(lang).filter((k) => k.startsWith('welcome.'));
        assert.deepEqual([...keys].sort(), [...KEYS].sort(), lang);
        for (const key of KEYS) {
            assert.deepEqual(placeholdersOf(BOT_CATALOG.catalogText(lang, key)), placeholdersOf(BOT_CATALOG.catalogText('en', key)), `${lang}: ${key}`);
        }
    }
});

test('welcome: Discord limits (modal title/label 45, select option 100, button 80)', () => {
    const limits = {
        'welcome.dashboard.messageLabel': 45, 'welcome.dashboard.imageUrlLabel': 45, 'welcome.dashboard.imageUploadLabel': 45,
        'welcome.dashboard.welcomeMessageTitle': 45, 'welcome.dashboard.goodbyeMessageTitle': 45,
        'welcome.dashboard.welcomeImageTitle': 45, 'welcome.dashboard.goodbyeImageTitle': 45,
        'welcome.dashboard.menu.placeholder': 150, 'welcome.dashboard.channelPlaceholder': 150,
    };
    for (const key of KEYS.filter((k) => k.startsWith('welcome.dashboard.menu.') && k !== 'welcome.dashboard.menu.placeholder')) limits[key] = 100;
    for (const key of KEYS.filter((k) => k.startsWith('welcome.dashboard.button.'))) limits[key] = 80;
    for (const lang of LANG_CODES) {
        for (const [key, max] of Object.entries(limits)) {
            const text = BOT_CATALOG.translate(lang, key, { user: '{user}', server: '{server}' });
            assert.ok(text.length <= max, `${lang}: ${key} is ${text.length} > ${max}`);
        }
    }
});

test('welcome: slash descriptions are localized for every Discord locale; English is the old text', async () => {
    const LOCALES = Object.values(DISCORD_LOCALES).flat().sort();
    const expected = {
        welcome: 'Configure the welcome system', goodbye: 'Configure the goodbye message system',
        greet: 'Manage welcome & goodbye settings', autorole: 'Manage roles that are automatically assigned to new members',
    };
    for (const name of Object.keys(expected)) {
        const json = (await import(`../src/commands/Welcome/${name}.js`)).default.data.toJSON();
        assert.equal(json.description, expected[name]);
        const nodes = [json];
        for (let i = 0; i < nodes.length; i += 1) nodes.push(...(nodes[i].options || []));
        for (const node of nodes) {
            assert.deepEqual(Object.keys(node.description_localizations || {}).sort(), LOCALES, `/${name} ${node.name}`);
            for (const text of Object.values(node.description_localizations)) assert.ok(text.length <= 100, `/${name} ${node.name}: ${text}`);
        }
    }
    const welcome = (await import('../src/commands/Welcome/welcome.js')).default.data.toJSON();
    const message = welcome.options[0].options.find((o) => o.name === 'message');
    assert.equal(message.description, 'Welcome message. Variables: {user}, {username}, {server}, {memberCount}');
    assert.equal(message.description_localizations.de, 'Begrüßungsnachricht. Variablen: {user}, {username}, {server}, {memberCount}');
});

test('welcome: English output is the old text', () => {
    const en = botText('en');
    assert.equal(en.t('welcome.manageServer', { command: '/welcome' }), 'You need the **Manage Server** permission to use `/welcome`.');
    assert.equal(en.t('welcome.welcome.alreadySet', { channelId: '9' }), 'Welcome is already configured for <#9>. Use **/greet dashboard** to customize channel, message, ping, or image.');
    assert.equal(en.t('welcome.dashboard.description', { server: 'S' }), 'Welcome and goodbye messages for **S**.\nThe buttons turn each one on or off. Pick a setting in the menu to change it.');
    assert.equal(en.t('welcome.dashboard.messageLabel', { user: '{user}', server: '{server}' }), 'Message (variables: {user}, {server}, etc)');
    assert.equal(en.t('welcome.autorole.needsFixing', { list: 'A\nB' }), '\n\n**Needs fixing:**\nA\nB');
    assert.equal(en.t('welcome.dashboard.welcomeCopyKept', { channelId: '5' }), "\nA copy is kept in <#5>. Don't delete that message, the welcome message loads the image from it.");
});

test('welcome posts: the default text in the server language; English as before; admin text untouched', () => {
    const data = { user, guild };
    assert.equal(defaultWelcomeText({}, data), "Welcome to Cats {user}, <@111>. You're member number 42.");
    assert.equal(defaultGoodbyeText({}, data), "<@111> left the server. We're at 42 members now.");
    assert.equal(defaultWelcomeText({}, data, botText('de')), 'Willkommen auf Cats {user}, <@111>. Du bist Mitglied Nummer 42.');
    assert.equal(defaultGoodbyeText({}, data, botText('ru')), '<@111> покинул(а) сервер. Участников теперь: 42.');
    // The admin's own message is never run through the catalog, in any language.
    assert.equal(defaultWelcomeText({ welcomeMessage: 'Hi {user} in {server}' }, data, botText('fr')), 'Hi <@111> in Cats {user}');
    assert.equal(defaultGoodbyeText({ leaveMessage: 'Bye {username}' }, data, botText('pl')), 'Bye ana');
});
