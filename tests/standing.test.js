import { test } from 'node:test';
import assert from 'node:assert/strict';

const { nextWarningText, standingFields } = await import('../src/services/enforcement/standingService.js');

test('next warning: counts up at level 0, bans at the limit, escalates at level 1+', () => {
    assert.equal(nextWarningText({ level: 0, warns_since_level: 0 }),
        'It would be warning 1 of 3. 2 more after it would mean an automatic ban (7 days).');
    assert.equal(nextWarningText({ level: 0, warns_since_level: 1 }),
        'It would be warning 2 of 3. The one after it would mean an automatic ban (7 days).');
    assert.equal(nextWarningText({ level: 0, warns_since_level: 2 }),
        'It would reach the warning limit: an automatic ban (7 days, warning stage 1 of 3).');
    assert.equal(nextWarningText({ level: 1, warns_since_level: 0 }),
        'It would reach the warning limit: an automatic ban (1 month, warning stage 2 of 3).');
    assert.equal(nextWarningText({ level: 2, warns_since_level: 0 }),
        'It would reach the warning limit: an automatic ban (permanent, warning stage 3 of 3).');
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
    assert.match(byName['Counted warnings'], /\*\*2\*\* counted \(limit at this stage: 3\)/);
    assert.match(byName['Counted warnings'], /`aaaaa` · Spam · <t:1767225600:d>/);
    assert.match(byName['Counted warnings'], /do not expire/);
    assert.match(byName['Warning ladder'], /\*\*Warning stage 0 of 3 \(no warning ban yet\)\*\*/);
    assert.match(byName['Warning ladder'], /reach the warning limit/);
    assert.match(byName['Active punishments'], /Mute `ccccc` · ends <t:1893456000:d>/);
    assert.match(byName.Appeals, /`ccccc` mute · ⏳ pending/);

    const clean = standingFields({ ladder: { level: 0, warns_since_level: 0 }, warns: [], activeBan: null, activeMute: null, appeals: [] });
    assert.match(clean[0].value, /None counted/);
    assert.equal(clean[2].value, 'None.');
    assert.equal(clean[3].value, 'None filed.');
});

test('warning stage in plain words: "warning stage N of 3 (…)", the same bans as the ladder config', async () => {
    const { LADDER_STAGE_BANS, ladderStage, ladderStageLabel, ladderStageShort } = await import('../src/services/enforcement/format.js');
    const { enforcementConfig } = await import('../src/config/enforcement.js');
    assert.deepEqual({ ...LADDER_STAGE_BANS }, { ...enforcementConfig.ladderBans }, 'format.js and the config agree');
    assert.equal(ladderStage(0), 'warning stage 0 of 3 (no warning ban yet)');
    assert.equal(ladderStage(1), 'warning stage 1 of 3 (7-day ban)');
    assert.equal(ladderStage(2), 'warning stage 2 of 3 (30-day ban)');
    assert.equal(ladderStage(3), 'warning stage 3 of 3 (permanent ban)');
    assert.equal(ladderStageLabel(1), 'Warning stage 1 of 3 (7-day ban)');
    assert.equal(ladderStageShort(2), '2 of 3 (30-day ban)');
    assert.equal(ladderStage(null), 'warning stage 0 of 3 (no warning ban yet)', 'missing level reads as 0');
    assert.equal(ladderStage(9), 'warning stage 3 of 3 (permanent ban)', 'capped at 3');
});
