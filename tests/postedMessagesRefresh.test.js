import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshPostedMessages } from '../src/services/postedMessagesRefresh.js';

test('refresh posted messages: every panel kind counted; one failing part never stops the others', async () => {
    const guild = { id: '100000000000000001' };
    const done = await refreshPostedMessages({}, guild, {
        verification: async () => 1,
        tickets: async () => { throw new Error('Missing Access'); },
        appeals: async () => 2,
        reactionRoles: async () => 3,
    });
    assert.deepEqual(done, { verification: 1, tickets: 0, appeals: 2, reactionRoles: 3, total: 6 });
});
