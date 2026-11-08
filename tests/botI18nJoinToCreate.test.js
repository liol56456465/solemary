// Join to Create in 8 languages (src/content/bot/<lang>/jointocreate.json): English is the text the
// code had before, the settings form and service refusals translate, and Discord's length limits hold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANG_CODES } from '../src/services/site/i18n.js';
import { botText } from '../src/utils/botText.js';
import { buildSettingsModal, parseSettingValue } from '../src/commands/JoinToCreate/modules/settingsModal.js';
import { JtcError, joinToCreateErrorText, validateBitrate, validateChannelNameTemplate } from '../src/services/joinToCreateService.js';
import { TitanBotError } from '../src/utils/errorHandler.js';
import jointocreate from '../src/commands/JoinToCreate/jointocreate.js';

const TRIGGER = '123456789012345678';
const NOW = Date.UTC(2026, 10, 8);

test('English is unchanged: command descriptions, settings form, refusals', () => {
    const json = jointocreate.data.toJSON();
    assert.equal(json.description, 'Manage join to create voice channels');
    assert.equal(json.description_localizations.de, botText('de').t('jointocreate.cmd.description'));
    assert.equal(json.description_localizations['es-419'], botText('es').t('jointocreate.cmd.description'));

    const modal = buildSettingsModal('name', TRIGGER, {}, { now: NOW }).toJSON();
    assert.equal(modal.title, 'Channel name template');
    assert.equal(modal.components[0].label, 'New name template');
    assert.equal(modal.components[0].description, 'Up to 100 characters. {username}, {display_name}, {user_tag} and {guild_name} are filled in.');
    assert.equal(buildSettingsModal('bitrate', TRIGGER, {}, { now: NOW }).toJSON().components[0].description, 'A whole number from 8 to 384. 64 is normal, 96 good, 128 high.');

    assert.equal(parseSettingValue('name', 'x'.repeat(101)).error, 'The name template must be 1 to 100 characters on one line.');
    assert.equal(parseSettingValue('bitrate', '7').error, 'The bitrate must be a whole number from 8 to 384 kbps.');
    assert.equal(parseSettingValue('bitrate', '96').text, 'Bitrate changed to 96 kbps.');
    assert.equal(parseSettingValue('limit', '0').text, 'User limit changed to no limit.');
    assert.equal(parseSettingValue('limit', '5').text, 'User limit changed to 5 members.');

    assert.throws(() => validateBitrate(4), (e) => e instanceof TitanBotError && e.userMessage === 'Bitrate must be between 8 and 384 kbps.');
    assert.throws(() => validateChannelNameTemplate('{nope}'), (e) => e.userMessage === 'Unknown placeholder: {nope}. Allowed placeholders are {username}, {user_tag}, {displayName}, {display_name}, {guildName}, {guild_name}, {channelName}, {channel_name}');
});

test('service refusals carry their catalog key: the command answers in the user\'s language', () => {
    const error = new JtcError('x', 'validation', 'jointocreate.service.alreadySetUp', {}, { channel: '<#1>' });
    assert.equal(error.userMessage, 'This server already has a Join to Create channel set up: <#1>\n\nChange or remove it first before creating a new one.');
    assert.ok(joinToCreateErrorText(error, botText('de')).startsWith('Dieser Server hat schon'));
    assert.ok(joinToCreateErrorText(error, botText('de')).includes('<#1>'));
    assert.equal(joinToCreateErrorText(new TitanBotError('x', 'validation', 'Plain'), botText('de')), 'Plain', 'other errors keep their text');
});

test('every language: the form, plurals and placeholders render; Discord limits hold', () => {
    for (const lang of LANG_CODES) {
        const tr = botText(lang);
        for (const kind of ['name', 'limit', 'bitrate']) {
            const modal = buildSettingsModal(kind, TRIGGER, {}, { now: NOW, lang }).toJSON();
            assert.ok(modal.title.length <= 45, `${lang} ${kind} title`);
            assert.ok(modal.components[0].label.length <= 45, `${lang} ${kind} label`);
            assert.ok(modal.components[0].description.length <= 100, `${lang} ${kind} description`);
        }
        assert.ok(parseSettingValue('name', '{username}', { lang }).text.includes('`{username}`'), lang);
        for (const n of [1, 2, 5, 22]) {
            const text = parseSettingValue('limit', String(n), { lang }).text;
            assert.ok(text.includes(String(n)) && !/\{[a-z]+\}/i.test(text), `${lang} ${n}: ${text}`);
            assert.ok(!tr.tp('jointocreate.limit.users', n).includes('{'), lang);
        }
        for (const key of ['jointocreate.modal.limitLabel', 'jointocreate.modal.bitrateLabel', 'jointocreate.panel.nameTemplate']) {
            assert.ok(tr.t(key).length <= 45, `${lang} ${key}`);
        }
        for (const key of ['buttonName', 'buttonLimit', 'buttonBitrate', 'buttonRemove']) assert.ok(tr.t(`jointocreate.panel.${key}`).length <= 80);
    }
});
