// /appeal status (commands/Enforcement/appeal.js) and the shared My appeals text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import appeal from '../src/commands/Enforcement/appeal.js';
import { myAppealsText } from '../src/handlers/appealsHandler.js';
import { EVERYONE_COMMANDS } from '../src/config/commands/commandAccess.js';

const row = (o) => ({ case_code: 'k7xq2', type: 'ban', name: 'cat ban 1', status: 'pending', created_at: new Date(0), decided_at: null, claimed_at: null, ...o });

test('my appeals text: waiting, taken by staff, decided; none yet', () => {
    assert.match(myAppealsText([row()]), /Waiting for a decision · filed <t:0:d>/);
    assert.match(myAppealsText([row({ claimed_at: new Date(1) })]), /Someone on the staff team is looking at it/);
    assert.match(myAppealsText([row({ status: 'accepted', decided_at: new Date(86400000) })]), /Accepted · filed <t:0:d> · decided <t:86400:d>/);
    assert.match(myAppealsText([]), /You have not filed any appeals/);
    assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(myAppealsText([row()])), 'no emoji');
});

test('/appeal status: everyone, private, own appeals only; DB error is friendly', async () => {
    assert.ok(EVERYONE_COMMANDS.has('appeal status'));
    const replies = [];
    const interaction = { id: `i${Math.random()}`, createdTimestamp: Date.now(), user: { id: '200000000000000002' }, reply: async (p) => replies.push(p) };
    let asked = null;
    await appeal.execute(interaction, {}, {}, { list: async (id) => { asked = id; return [row()]; } });
    assert.equal(asked, '200000000000000002');
    assert.equal(replies[0].flags, 64);
    assert.match(replies[0].embeds[0].data.description, /k7xq2/);
    const broken = { ...interaction, id: `i${Math.random()}` };
    const r2 = [];
    broken.reply = async (p) => r2.push(p);
    await appeal.execute(broken, {}, {}, { list: async () => { throw new Error('db down'); } });
    assert.match(r2[0].embeds[0].data.description, /not responding/);
});
