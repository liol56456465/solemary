// /help and /commands in 8 languages (catalog core.help.*, core.commands.*): English output is the
// old text byte for byte, other languages render without English left over or a placeholder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANG_CODES, botText } from '../src/utils/botText.js';
import { createInitialHelpMenu } from '../src/commands/Core/help.js';
import { buildCategoryComponents, buildCategoryEmbed, buildOverviewComponents, buildOverviewEmbed } from '../src/commands/Core/modules/commands_dashboard.js';

const client = { commands: new Map(), user: { username: 'Mewvo', displayAvatarURL: () => 'https://x/a.png' } };
const guild = { name: 'Cats {not a param}' };
const category = {
    key: 'fun', displayName: 'Fun', categoryDisabled: false, disabledCount: 1, enabledCount: 1, totalCount: 2,
    enabledCommands: ['roll'], commands: [{ name: 'roll' }, { name: 'fun flip', isSubcommand: true }, { name: 'help', protected: true }],
};
const snapshot = { categories: [category], enabledTotal: 1, totalCommands: 2 };
const placeholderLeft = (text) => /\{[a-zA-Z]+\}/.test(String(text).replace(/\{not a param\}/g, ''));

test('/help start page: English (one first step everywhere: /setup -> dashboard)', async () => {
    const admin = (await createInitialHelpMenu(client, null, true)).embeds[0].data;
    assert.equal(admin.title, 'Mewvo help');
    assert.equal(admin.description, 'support us by boosting', 'no server given: home wording, as before');
    assert.equal(admin.fields[0].value, [
        '1. **/setup** shows what is set up here, with the link to the dashboard.',
        '2. On the dashboard, open **Setup step by step** and do the essentials first.',
        '3. Pick a category in the menu below to see its commands.',
    ].join('\n'));
    assert.ok(!admin.fields[0].value.includes('/configwizard'));
    assert.equal(admin.fields[1].value, [
        '• Commands marked 🔒 need the **Administrator** permission; the rest are for everyone.',
        '• **/setup** shows what is set up in this server, with a link to the dashboard.',
        '• **/setappeal** posts the appeal panels; **/appeals** lists, shows and decides appeals.',
    ].join('\n'));
    assert.equal(admin.fields[2].value, '• Most features have a dashboard command for their settings\n• Settings are saved per server');
    const member = await createInitialHelpMenu(client, null, false, botText('en'));
    assert.equal(member.embeds[0].data.fields[0].value, 'Pick a category in the menu below to see its commands.', 'no modmail: not mentioned');
    const withModmail = await createInitialHelpMenu(client, null, false, botText('en'), { modmail: true });
    assert.equal(withModmail.embeds[0].data.fields[0].value, 'Pick a category in the menu below to see its commands.\nNeed staff? DM the bot: your message goes to the team privately (modmail).');
    assert.equal(member.embeds[0].data.fields[1].value, '• This list shows the commands you can use.');
    assert.equal(member.components[0].components[0].data.label, 'Support Server');
});

test('/help start page in every language: translated, no placeholder left, within Discord limits', async () => {
    const en = (await createInitialHelpMenu(client, null, true)).embeds[0].data;
    for (const lang of LANG_CODES.filter((l) => l !== 'en')) {
        const { embeds, components } = await createInitialHelpMenu(client, null, true, botText(lang));
        const data = embeds[0].data;
        assert.notEqual(data.fields[0].name, en.fields[0].name, lang);
        assert.ok(data.title.includes('Mewvo'), lang);
        for (const field of data.fields) {
            assert.ok(field.value.length <= 1024 && !placeholderLeft(field.value), `${lang}: ${field.value}`);
        }
        assert.ok(data.fields[0].value.includes('**/setup**') && !data.fields[0].value.includes('/configwizard'), `${lang}: /setup first`);
        const menu = components[1].components[0].toJSON();
        for (const option of menu.options) assert.ok(option.label.length <= 100 && option.description.length <= 100, lang);
    }
});

test('/commands dashboard: English unchanged', () => {
    const overview = buildOverviewEmbed(snapshot, guild).data;
    assert.equal(overview.title, 'Command access');
    assert.equal(overview.description, 'Commands for **Cats {not a param}**. Subcommands (like `birthday list`) are counted on their own.');
    assert.equal(overview.fields[0].value, '**1/2** commands on\n0 categories fully on · 1 partly on · 0 off');
    assert.equal(overview.fields[1].value, '**Fun**: Partly on (1/2)');
    assert.equal(overview.footer.text, '/commands and /configwizard always stay on');
    const embed = buildCategoryEmbed(category, guild).data;
    assert.equal(embed.fields[0].value, '1 of 2 off');
    assert.equal(embed.fields[1].value, '1/2 on');
    assert.equal(embed.fields[2].value, '`roll`: On\n`fun flip`: Off\n`help`: On (always)');
    assert.equal(embed.footer.text, 'Commands marked "always" can\'t be turned off');
    const labels = buildCategoryComponents('1', category).at(-1).components.map((b) => b.data.label);
    assert.deepEqual(labels, ['Back', 'Turn category off', 'Enable all', 'Disable all', 'Clear overrides']);
    assert.equal(buildOverviewComponents('1', snapshot)[0].components[0].toJSON().options[0].description, 'Partly on · 1/2');
});

test('/commands dashboard in every language: translated, placeholders filled', () => {
    for (const lang of LANG_CODES.filter((l) => l !== 'en')) {
        const tr = botText(lang);
        const overview = buildOverviewEmbed(snapshot, guild, tr).data;
        const embed = buildCategoryEmbed(category, guild, tr).data;
        assert.notEqual(overview.title, 'Command access', lang);
        assert.ok(overview.description.includes('**Cats {not a param}**'), lang);
        for (const text of [overview.description, ...overview.fields.map((f) => f.value), ...embed.fields.map((f) => f.value)]) {
            assert.ok(!placeholderLeft(text), `${lang}: ${text}`);
        }
        // The help text names the buttons by their (translated) labels.
        const labels = buildCategoryComponents('1', category, tr).at(-1).components.map((b) => b.data.label);
        const howTo = embed.fields.at(-1).value;
        assert.ok(howTo.includes(`**${labels[3]}**`) && howTo.includes(`**${labels[4]}**`), `${lang}: ${howTo}`);
    }
});
