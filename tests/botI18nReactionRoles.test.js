// /reactroles, the reaction-role panel and the member's select-menu reply in 8 languages
// (src/content/bot/<lang>/reactionroles.json): English unchanged, panels in the server's language,
// old panels in another language still recognised, Discord length limits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANG_CODES } from '../src/services/site/i18n.js';
import { botText } from '../src/utils/botText.js';
import { DISCORD_LOCALES_BY_LANG as DISCORD_LOCALES } from '../src/utils/commandLocalizations.js';
import {
    buildReactionRolePanelPayload, getPanelRoleProblem, isAvailableRolesField, panelFieldsWithRoles,
} from '../src/services/reactionRoleService.js';
import { rolesUpdatedText } from '../src/handlers/interactionHandlers/reactionRolesSelectMenu.js';
import reactroles from '../src/commands/Reaction_roles/reactroles.js';

const roles = [
    { id: '11', name: 'Red {x}', toString: () => '<@&11>' },
    { id: '12', name: 'Blue', toString: () => '<@&12>' },
];

test('English panel is byte-for-byte the old one (no language = English)', () => {
    const { embeds, components } = buildReactionRolePanelPayload('Pick', 'Choose below', roles);
    const embed = embeds[0].toJSON();
    assert.deepEqual(embed.fields, [{ name: 'Available Roles', value: '• <@&11>\n• <@&12>' }]);
    assert.equal(embed.footer.text, 'Select roles from the dropdown menu below');
    const menu = components[0].toJSON().components[0];
    assert.equal(menu.placeholder, 'Select your roles');
    assert.equal(menu.custom_id, 'reaction_roles');
    assert.deepEqual(menu.options.map((o) => o.description), ['Add/remove the Red {x} role', 'Add/remove the Blue role']);
});

test('a German panel: labels translated, the admin\'s title and description kept as typed', () => {
    const embed = buildReactionRolePanelPayload('Pick', 'Choose below', roles, { lang: 'de' }).embeds[0].toJSON();
    assert.equal(embed.title, 'Pick');
    assert.equal(embed.description, 'Choose below');
    assert.equal(embed.fields[0].name, 'Verfügbare Rollen');
    assert.equal(embed.footer.text, 'Wähle deine Rollen im Auswahlmenü unten');
});

test('a panel posted in any language keeps its role list found and replaced (no duplicate field)', () => {
    for (const lang of LANG_CODES) {
        const name = botText(lang).t('reactionroles.panel.availableRoles');
        assert.ok(isAvailableRolesField({ name }), lang);
        const fields = panelFieldsWithRoles([{ name: 'Other', value: 'x' }, { name, value: 'old' }], roles, botText('en'));
        assert.equal(fields.length, 2, lang);
        assert.deepEqual(fields[1], { name: 'Available Roles', value: '• <@&11>\n• <@&12>', inline: false });
    }
    assert.equal(isAvailableRolesField({ name: 'Rules' }), false);
});

test('the member reply: English exactly as before, plural "Skipped" in every language', () => {
    const en = botText('en');
    assert.equal(rolesUpdatedText(en, { addedRoles: ['A', 'B'], removedRoles: ['C'], skipped: 2 }),
        'Your roles are updated.\n\n**Added:** **A**, **B**\n**Removed:** **C**\n\n**Skipped:** 2 roles (I don\'t have permission)');
    assert.equal(rolesUpdatedText(en, { skipped: 1 }), 'Your roles are updated.\n\nNothing changed.\n**Skipped:** 1 role (I don\'t have permission)');
    assert.equal(rolesUpdatedText(botText('ru'), { skipped: 5 }), 'Ваши роли обновлены.\n\nНичего не изменилось.\n**Пропущено:** 5 ролей (у меня нет прав)');
    for (const lang of LANG_CODES) {
        for (const n of [1, 2, 5, 22]) assert.ok(!/\{[a-z]+\}/i.test(rolesUpdatedText(botText(lang), { addedRoles: ['{count}'], skipped: n }).replace('**{count}**', '')), `${lang} ${n}`);
    }
});

test('panel refusals: English unchanged by default, translated with { lang }', () => {
    const full = { roles: Array.from({ length: 25 }, (_, i) => String(i)) };
    assert.equal(getPanelRoleProblem(null, null, full), 'This panel already has the maximum of 25 roles.');
    assert.equal(getPanelRoleProblem(null, null, full, { lang: 'de' }), 'Dieses Panel hat schon die höchstens möglichen 25 Rollen.');
    assert.equal(getPanelRoleProblem(null, null, { roles: [] }), null);
});

test('/reactroles: descriptions unchanged in English, localized for every Discord locale', () => {
    const json = reactroles.data.toJSON();
    assert.equal(json.description, 'Manage reaction role assignments');
    assert.equal(json.description_localizations.de, botText('de').t('reactionroles.cmd.description'));
    assert.equal(json.description_localizations['es-419'], json.description_localizations['es-ES']);
    const locales = Object.values(DISCORD_LOCALES).flat().sort();
    const walk = (node, where) => {
        assert.deepEqual(Object.keys(node.description_localizations || {}).sort(), locales, where);
        for (const option of node.options || []) walk(option, `${where} ${option.name}`);
    };
    walk(json, '/reactroles');
    assert.deepEqual(json.options.map((o) => o.name), ['setup', 'dashboard'], 'names stay English');
});

test('Discord limits hold in every language: modal titles and labels 45, buttons 80, placeholders 150, options 100', () => {
    const limits = {
        'reactionroles.dashboard.editModalTitle': 45, 'reactionroles.dashboard.deleteModalTitle': 45,
        'reactionroles.dashboard.editTitleLabel': 45, 'reactionroles.dashboard.editDescriptionLabel': 45,
        'reactionroles.dashboard.deleteConfirm': 45,
        'reactionroles.dashboard.repostButton': 80, 'reactionroles.dashboard.editTextButton': 80, 'reactionroles.dashboard.deleteButton': 80,
        'reactionroles.dashboard.actionPlaceholder': 150, 'reactionroles.dashboard.addPlaceholder': 150,
        'reactionroles.dashboard.removePlaceholder': 150, 'reactionroles.panel.placeholder': 150,
        'reactionroles.dashboard.addRoleLabel': 100, 'reactionroles.dashboard.addRoleHint': 100,
        'reactionroles.dashboard.removeRoleLabel': 100, 'reactionroles.dashboard.removeRoleHint': 100,
        'reactionroles.dashboard.title': 256, 'reactionroles.panel.availableRoles': 256,
    };
    for (const lang of LANG_CODES) {
        for (const [key, max] of Object.entries(limits)) {
            const text = botText(lang).t(key);
            assert.ok(text.length <= max, `${lang}: ${key} is ${text.length} > ${max}`);
        }
    }
});
