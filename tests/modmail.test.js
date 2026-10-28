import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkText, modmailUserId, isModmailStaff } from '../src/services/modmailService.js';

test('modmail channels are recognised only by a well-formed topic', () => {
    assert.equal(modmailUserId({ topic: 'modmail:123456789012345678' }), '123456789012345678');
    assert.equal(modmailUserId({ topic: 'modmail:abc' }), null);
    assert.equal(modmailUserId({ topic: 'general chat' }), null);
    assert.equal(modmailUserId({ topic: null }), null);
    assert.equal(modmailUserId(null), null);
});

test('long relays are split under the 2000 character limit', () => {
    assert.deepEqual(chunkText('hi'), ['hi']);
    const long = `${'a'.repeat(1500)}\n${'b'.repeat(1500)}`;
    const chunks = chunkText(long);
    assert.deepEqual(chunks, ['a'.repeat(1500), 'b'.repeat(1500)]);
    const noBreaks = 'x'.repeat(4500);
    assert.ok(chunkText(noBreaks).every((c) => c.length <= 2000));
    assert.equal(chunkText(noBreaks).join(''), noBreaks);
});

test('modmail staff: admin, manage channels or ticket staff role', () => {
    const member = (perms, roles = []) => ({
        id: 'm', guild: { ownerId: 'owner' },
        permissions: { has: (p) => perms.includes(p) },
        roles: { cache: { has: (r) => roles.includes(r) } },
    });
    assert.equal(isModmailStaff(member([]), {}), false);
    assert.equal(isModmailStaff(member([], ['staff']), { ticketStaffRoleId: 'staff' }), true);
    assert.equal(isModmailStaff(member([8n]), {}), true); // Administrator
    assert.equal(isModmailStaff(null, {}), false);
});
