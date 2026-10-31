// Enforcement templates (services/enforcement/templateService.js): what is accepted, labels,
// which templates the panel offers for a member, and the flow fields a template sets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TemplateError, cleanTemplate, cleanTemplates, templateLabel, templatePatch, usableTemplates } from '../src/services/enforcement/templateService.js';
import { getSettingEntry } from '../src/services/settings/settingsRegistry.js';

test('templates: name, action, prebuilt reason; mute needs a duration; ban without one is permanent', () => {
    assert.deepEqual(cleanTemplate({ name: ' Spam  mute ', action: 'mute', reasonKey: 'spam', duration: '1H' }), { name: 'Spam mute', action: 'mute', reasonKey: 'spam', duration: '1h' });
    assert.deepEqual(cleanTemplate({ name: 'Raid', action: 'ban', reasonKey: 'spam', duration: '' }).duration, null);
    assert.equal(cleanTemplate({ name: 'Raid', action: 'ban', reasonKey: 'spam', duration: 'permanent' }).duration, null);
    assert.equal(cleanTemplate({ name: 'W', action: 'warn', reasonKey: 'spam', duration: '5d' }).duration, null, 'ignored for warn');
    assert.throws(() => cleanTemplate({ name: 'x', action: 'mute', reasonKey: 'spam' }), /needs a duration/);
    assert.throws(() => cleanTemplate({ name: 'x', action: 'mute', reasonKey: 'spam', duration: 'soon' }), /not a duration/);
    assert.throws(() => cleanTemplate({ name: 'x', action: 'unban', reasonKey: 'spam' }), TemplateError);
    assert.throws(() => cleanTemplate({ name: 'x', action: 'warn', reasonKey: 'made-up' }), /prebuilt/);
    assert.throws(() => cleanTemplate({ name: '', action: 'warn', reasonKey: 'spam' }), /name/);
    assert.throws(() => cleanTemplates([{ name: 'A', action: 'warn', reasonKey: 'spam' }, { name: 'a', action: 'kick', reasonKey: 'spam' }]), /already a template/);
    assert.throws(() => cleanTemplates(Array.from({ length: 11 }, (_, i) => ({ name: `t${i}`, action: 'warn', reasonKey: 'spam' }))), /At most 10/);
});

test('templates: labels, only for actions the panel offers, flow fields', () => {
    assert.equal(templateLabel({ action: 'mute', duration: '1h' }), '1h mute');
    assert.equal(templateLabel({ action: 'ban', duration: null }), 'permanent ban');
    assert.equal(templateLabel({ action: 'kick' }), 'kick');
    const list = [{ name: 'M', action: 'mute', reasonKey: 'spam', duration: '1h' }, { name: 'B', action: 'ban', reasonKey: 'spam', duration: null }];
    assert.deepEqual(usableTemplates(list, ['ban', 'kick', 'warn']).map((t) => t.index), [1], 'already muted: no mute template');
    const patch = templatePatch(list[0]);
    assert.equal(patch.durationMs, 3600000);
    assert.equal(patch.reasonSource, 'prebuilt');
    assert.equal(patch.templateName, 'M');
    assert.deepEqual(patch.evidenceEntries, []);
    assert.equal(templatePatch(list[1]).durationMs, null);
});

test('the setting accepts cleaned lists and refuses junk', () => {
    const schema = getSettingEntry('enforcementTemplates').schema;
    assert.ok(schema.safeParse([{ name: 'M', action: 'mute', reasonKey: 'spam', duration: '1h' }]).success);
    assert.ok(!schema.safeParse([{ name: 'M', action: 'nuke', reasonKey: 'spam', duration: null }]).success);
    assert.ok(!schema.safeParse([{ name: 'M', action: 'warn', reasonKey: 'spam', duration: null, extra: 1 }]).success);
});
