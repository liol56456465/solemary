// /embedbuilder in 8 languages (namespace tools.embed): English is the old text byte for byte,
// other languages translate the builder's own screens, and the user's embed content is never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANG_CODES } from '../src/services/site/i18n.js';
import { botText } from '../src/utils/botText.js';
import embedbuilder, { buildDashboardEmbed, buildMainMenu, buildPreviewEmbed } from '../src/commands/Tools/embedbuilder.js';

const emptyState = () => ({ title: null, description: null, color: '#336699', author: null, footer: null, thumbnail: null, image: null, timestamp: false, fields: [] });
const fullState = () => ({
    ...emptyState(), title: 'Rules {server}', description: 'Hello', author: { name: 'Staff' }, footer: { text: 'Bye' }, thumbnail: 'https://x/t.png',
    timestamp: true, fields: [{ name: 'One', value: 'A', inline: false }, { name: 'Two', value: 'B', inline: true }],
});

test('embedbuilder English: dashboard, empty preview and menu are the old text', () => {
    const en = botText('en');
    assert.equal(buildPreviewEmbed(emptyState(), en).data.description, '*(Empty. Use the menu below to add something.)*');
    const dash = buildDashboardEmbed(emptyState(), en).data;
    assert.equal(dash.title, 'Embed builder');
    assert.equal(dash.description, [
        '**Title** › `Not set`', '**Description** › `Not set`', '**Colour** › `#336699`', '**Author** › `Not set`', '**Footer** › `Not set`',
        '**Thumbnail** › Not set', '**Image** › Not set', '**Timestamp** › Off', '**Fields** › 0 / 25',
    ].join('\n'));
    const full = buildDashboardEmbed(fullState(), en).data.description.split('\n');
    assert.equal(full[1], '**Description** › 5 character(s)');
    assert.equal(full[5], '**Thumbnail** › Set');
    assert.equal(full[7], '**Timestamp** › On');
    const options = buildMainMenu(fullState(), en).toJSON().options;
    assert.equal(buildMainMenu(fullState(), en).toJSON().placeholder, 'What do you want to change?');
    assert.deepEqual(options.map((o) => o.label), [
        'Start from a template', 'Edit content', 'Colour', 'Author', 'Footer', 'Images', 'Add field (2/25)', 'Edit field', 'Remove field', 'Reorder fields',
        'Turn timestamp off', 'Post embed', 'Show JSON', 'Start over',
    ]);
    assert.equal(options[0].description, 'Ready-made announcements, like how to appeal');
    assert.equal(options[7].description, "Change a field's name, value or layout");
    assert.equal(en.t('tools.embed.post.noPermission', { channel: '<#1>' }), 'I need **Send Messages** and **Embed Links** permissions in <#1> to post there.');
    assert.equal(en.tp('tools.embed.template.count', 1), '1 template');
    assert.equal(en.tp('tools.embed.template.count', 3), '3 templates');
    assert.equal(embedbuilder.data.toJSON().description, 'Build an embed with a live preview and post it');
});

test('embedbuilder other languages: translated screens, user content unchanged, Discord limits kept', () => {
    for (const lang of LANG_CODES.filter((c) => c !== 'en')) {
        const tr = botText(lang);
        const dash = buildDashboardEmbed(fullState(), tr).data;
        assert.notEqual(dash.title, 'Embed builder', lang);
        assert.ok(!dash.description.includes('Not set') && !dash.description.includes('**Title**'), `${lang}: ${dash.description}`);
        assert.ok(dash.description.includes('`Rules {server}`'), `${lang}: user title kept as typed`);
        const preview = buildPreviewEmbed(fullState(), tr).data;
        assert.equal(preview.title, 'Rules {server}');
        assert.notEqual(buildPreviewEmbed(emptyState(), tr).data.description, '*(Empty. Use the menu below to add something.)*', lang);
        const menu = buildMainMenu(fullState(), tr).toJSON();
        assert.ok(menu.placeholder.length <= 150, lang);
        for (const option of menu.options) {
            assert.ok(option.label.length <= 100 && option.description.length <= 100, `${lang}: ${option.label}`);
        }
        assert.notEqual(menu.options[1].label, 'Edit content', lang);
        for (const key of ['content.modalTitle', 'color.modalTitle', 'author.modalTitle', 'footer.modalTitle', 'images.thumbnailTitle', 'images.imageTitle', 'field.addTitle',
            'content.titleLabel', 'content.descriptionLabel', 'color.hexLabel', 'author.nameLabel', 'author.iconLabel', 'author.urlLabel', 'footer.textLabel', 'footer.iconLabel',
            'images.urlLabel', 'field.nameLabel', 'field.valueLabel', 'field.inlineLabel', 'field.editNameLabel', 'field.editValueLabel']) {
            assert.ok(tr.t(`tools.embed.${key}`).length <= 45, `${lang}: ${key} over 45 (modal title / label)`);
        }
        assert.ok(tr.t('tools.embed.field.editModalTitle', { n: 25 }).length <= 45, lang);
        // The "Custom hex" preset is named in the colour hint: the same words in each language.
        assert.ok(tr.t('tools.embed.color.intro').includes(`**${tr.t('tools.embed.color.preset.custom')}**`), `${lang}: custom hex name`);
    }
});
