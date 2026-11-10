import test from 'node:test';
import assert from 'node:assert/strict';
import { DM_RENDERERS } from '../src/services/botDm/dmRenderers.js';
import { botText } from '../src/utils/botText.js';

const rec = { case_code: 'abc234', type: 'warn', reason: 'Spam', name: 'spam', guild_id: '100000000000000001', created_at: new Date().toISOString() };
const labelOf = (payload) => payload.components?.[0]?.components?.[0]?.data?.label ?? payload.components?.[0]?.toJSON?.().components?.[0]?.label;

test('Contest button: rendered with the DM in its language (a language re-edit relabels it); none without contestCode', async () => {
    const render = DM_RENDERERS['enf.warn'].render;
    const en = await render({ rec, warnNumber: 1, guildId: rec.guild_id, contestCode: 'abc234' }, 'en');
    const de = await render({ rec, warnNumber: 1, guildId: rec.guild_id, contestCode: 'abc234' }, 'de');
    assert.equal(labelOf(en), botText('en').t('member.contest.button'));
    assert.equal(labelOf(de), botText('de').t('member.contest.button'));
    assert.notEqual(labelOf(en), labelOf(de));
    const plain = await render({ rec, warnNumber: 1, guildId: rec.guild_id }, 'de');
    assert.equal(plain.components, undefined);
});
