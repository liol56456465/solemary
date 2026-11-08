// Utility commands in 8 languages (catalog namespace utility): English output is unchanged,
// other languages are translated with Discord markup, links and values kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANG_CODES } from '../src/services/site/i18n.js';
import { botText } from '../src/utils/botText.js';
import { listText } from '../src/commands/Utility/remind.js';
import { buildWeatherEmbed, SOURCES_LINE } from '../src/commands/Utility/weather.js';
import { confirmButtons, durationLabel } from '../src/commands/Utility/cooldown.js';
import { wipeItemLabel, wipeWarningText } from '../src/commands/Utility/wipedata.js';
import { COOLDOWN_DURATIONS, EXPIRED_MESSAGE } from '../src/services/members/selfCooldownService.js';
import { WIPE_ITEMS } from '../src/services/wipedataService.js';

const OTHERS = LANG_CODES.filter((c) => c !== 'en');
const en = botText('en');
const NOW = { temperature: 4.6, humidity: 81.2, windSpeedMs: 5, windFrom: 225, precipitationMm: 0.3, symbol: { emoji: '', text: 'Light rain' } };

test('English is byte-for-byte the old text', () => {
    assert.equal(listText([]), 'You have no reminders. Set one with `/remind me`.');
    assert.equal(en.t('utility.remind.set', { relative: '<t:1:R>', time: '<t:1:f>' }), "Okay, I'll remind you <t:1:R> (<t:1:f>). It comes as a DM, or here if your DMs are closed.");
    assert.equal(SOURCES_LINE, 'Sources: weather data from [MET Norway](https://api.met.no/) '
        + '([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), values rounded and converted); '
        + 'location from [© OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL).');
    const weather = buildWeatherEmbed({ name: 'Oslo', country: 'Norway' }, NOW, 59.9, 10.7).toJSON();
    assert.equal(weather.title, 'Weather in Oslo, Norway');
    assert.deepEqual(weather.fields.map((f) => [f.name, f.value]), [['Temperature', '5°C'], ['Humidity', '81%'], ['Wind', '18 km/h from SW'], ['Precipitation (next hour)', '0.3 mm']]);
    const noWind = buildWeatherEmbed({ name: 'X' }, { ...NOW, windSpeedMs: null }, 0, 0).toJSON();
    assert.equal(noWind.fields[2].value, 'N/A km/h');
    assert.equal(en.t('utility.cooldown.expired'), EXPIRED_MESSAGE);
    for (const [key, { label }] of Object.entries(COOLDOWN_DURATIONS)) assert.equal(durationLabel(key), label, key);
    assert.deepEqual(confirmButtons('1', 'n').toJSON().components.map((c) => c.label), ['Start cooldown', 'Cancel']);
    for (const item of WIPE_ITEMS.filter((i) => !i.legacy)) assert.equal(wipeItemLabel(item.id), item.label, item.id);
    assert.equal(wipeWarningText(), 'This permanently deletes your data in this server:\n'
        + WIPE_ITEMS.filter((item) => !item.legacy).map((item) => `- ${item.label}`).join('\n')
        + '\n\nYour to-do list, reminders and stored login token are the same in every server, so they are deleted everywhere. '
        + 'Without the login token the bot can no longer add you to the support server; Verify with Discord stores a new one. '
        + 'Moderation, appeal, report and verification records are kept.\n\n**This cannot be undone.**');
    assert.equal(en.t('utility.todo.created', { name: 'Groceries', id: 'abc' }), 'Created shared list "Groceries" with ID: `abc`\nUse `/todo share add list_id:abc user:@username` to add members.');
    assert.equal(en.t('utility.report.ownerPing', { ownerId: '42' }), '<@42> New report');
});

test('other languages: translated, with markup, links and values kept', () => {
    for (const lang of OTHERS) {
        const tr = botText(lang);
        assert.notEqual(listText([], tr), listText([]), lang);
        assert.ok(listText([], tr).includes('`/remind me`'), `${lang} command kept`);
        const weather = buildWeatherEmbed({ name: 'Oslo', country: 'Norway' }, NOW, 59.9, 10.7, tr).toJSON();
        assert.ok(weather.title.includes('Oslo, Norway'), lang);
        assert.notEqual(weather.fields[0].name, 'Temperature', lang);
        assert.ok(weather.fields[2].value.includes('18') && weather.fields[2].value.includes('SW'), `${lang} wind`);
        for (const link of ['https://api.met.no/', 'https://creativecommons.org/licenses/by/4.0/', 'https://www.openstreetmap.org/copyright']) {
            assert.ok(weather.description.includes(`(${link})`), `${lang} ${link}`);
        }
        assert.ok(tr.t('utility.cooldown.started', { duration: durationLabel('1d', tr), date: '<t:9:F>', relative: '<t:9:R>' }).includes('<t:9:F>'), lang);
        assert.notEqual(durationLabel('6h', tr), '6 hours', lang);
        assert.ok(wipeWarningText(tr).includes('**') && wipeWarningText(tr).split('\n- ').length === 7, `${lang} wipe list`);
        assert.ok(tr.t('utility.todo.created', { name: 'N', id: 'abc' }).includes('`/todo share add list_id:abc user:@username`'), lang);
        assert.ok(tr.t('utility.report.ownerPing', { ownerId: '42' }).startsWith('<@42> '), lang);
        for (const label of confirmButtons('1', 'n', tr).toJSON().components.map((c) => c.label)) assert.ok(label.length <= 80, lang);
        for (const key of ['modalAddTitle', 'modalCompleteTitle', 'modalRemoveTitle', 'taskLabel', 'taskNumberLabel']) {
            assert.ok(tr.t(`utility.todo.${key}`).length <= 45, `${lang} ${key}`);
        }
    }
});
