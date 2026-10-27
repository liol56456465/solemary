import { test } from 'node:test';
import assert from 'node:assert/strict';

const { nextWarningText, standingFields } = await import('../src/services/enforcement/standingService.js');

test('next warning: counts up at level 0, bans at the limit, escalates at level 1+', () => {
    assert.equal(nextWarningText({ level: 0, warns_since_level: 0 }),
        'It would be warning 1 of 3. 2 more after it would mean an automatic ban (7 days).');
    assert.equal(nextWarningText({ level: 0, warns_since_level: 1 }),
        'It would be warning 2 of 3. The one after it would mean an automatic ban (7 days).');
    assert.equal(nextWarningText({ level: 0, warns_since_level: 2 }),
        'It would reach the warning limit: an automatic ban (7 days, ladder level 1).');
    assert.equal(nextWarningText({ level: 1, warns_since_level: 0 }),
        'It would reach the warning limit: an automatic ban (1 month, ladder level 2).');
    assert.equal(nextWarningText({ level: 2, warns_since_level: 0 }),
        'It would reach the warning limit: an automatic ban (permanent, ladder level 3).');
});

test('standing fields: warnings, ladder, punishments, appeals', () => {
    const fields = standingFields({
        ladder: { level: 0, warns_since_level: 2 },
        warns: [
            { case_code: 'aaaaa', reason: 'Spam', created_at: new Date('2026-01-01T00:00:00Z') },
            { case_code: 'bbbbb', reason: 'Swearing', created_at: new Date('2026-01-02T00:00:00Z') },
        ],
        activeBan: null,
        activeMute: { case_code: 'ccccc', expires_at: new Date('2030-01-01T00:00:00Z') },
        appeals: [{ case_code: 'ccccc', type: 'mute', status: 'pending', created_at: new Date('2026-01-03T00:00:00Z') }],
    });
    const byName = Object.fromEntries(fields.map((field) => [field.name, field.value]));
    assert.match(byName['Counted warnings'], /\*\*2\*\* counted \(limit at this level: 3\)/);
    assert.match(byName['Counted warnings'], /`aaaaa` · Spam · <t:1767225600:d>/);
    assert.match(byName['Counted warnings'], /do not expire/);
    assert.match(byName['Warning ladder'], /Level \*\*0\*\* of 3/);
    assert.match(byName['Warning ladder'], /reach the warning limit/);
    assert.match(byName['Active punishments'], /Mute `ccccc` — ends <t:1893456000:d>/);
    assert.match(byName.Appeals, /`ccccc` mute · ⏳ pending/);

    const clean = standingFields({ ladder: { level: 0, warns_since_level: 0 }, warns: [], activeBan: null, activeMute: null, appeals: [] });
    assert.match(clean[0].value, /None counted/);
    assert.equal(clean[2].value, 'None.');
    assert.equal(clean[3].value, 'None filed.');
});
