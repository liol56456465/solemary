import test from 'node:test';
import assert from 'node:assert/strict';
import { dropOldLanguageRoles } from '../src/services/languageRoleService.js';

const map = { en: '11', de: '22', fr: '33' };
const member = (ids, removed = []) => ({
    id: 'u', guild: { id: 'g' },
    roles: { cache: new Map(ids.map((id) => [id, {}])), remove: async (list) => { removed.push(...list); } },
});

test('one language role at a time: a new one (Onboarding) removes the old; several at once or none: untouched', async () => {
    const removed = [];
    assert.deepEqual(await dropOldLanguageRoles(member(['11', '99']), member(['11', '22', '99'], removed), { rolesFor: () => map }), ['11']);
    assert.deepEqual(removed, ['11']);
    assert.deepEqual(await dropOldLanguageRoles(member(['99']), member(['22', '33'], []), { rolesFor: () => map }), []);
    assert.deepEqual(await dropOldLanguageRoles(member(['11']), member(['11', '99'], []), { rolesFor: () => map }), []);
    assert.deepEqual(await dropOldLanguageRoles({ partial: true }, member(['11', '22'], []), { rolesFor: () => map }), []);
    assert.deepEqual(await dropOldLanguageRoles(member(['11']), member(['11', '22'], []), { rolesFor: () => { throw new Error('db down'); } }), []);
});
