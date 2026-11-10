import test from 'node:test';
import assert from 'node:assert/strict';
import { onboardingPrompts, resolvePanelInput } from '../src/services/dashboard/modules/reactionRoles.js';

const tr = { t: (key) => key };

test('reaction role presets fill only empty title/description; onboarding roles replace picked roles', () => {
    const filled = resolvePanelInput({ title: '', description: '', roleIds: ['1'], preset: 'language' }, tr);
    assert.equal(filled.title, 'reactionRoles.presets.language.title');
    assert.equal(filled.description, 'reactionRoles.presets.language.description');
    assert.deepEqual(filled.roleIds, ['1']);
    const own = resolvePanelInput({ title: 'Mine', description: 'Text', roleIds: ['1'], preset: 'hobbies', promptRoleIds: ['7', '8'] }, tr);
    assert.equal(own.title, 'Mine');
    assert.deepEqual(own.roleIds, ['7', '8']);
    assert.equal(resolvePanelInput({ title: '', description: '', roleIds: [], preset: 'nope' }, tr).title, '');
});

test('onboarding questions: roles collected per question, failures and empty questions dropped', async () => {
    const roles = (...ids) => new Map(ids.map((id) => [id, {}]));
    const prompts = new Map([
        ['p1', { id: 'p1', title: 'Languages', options: new Map([['o1', { roles: roles('10', '11') }], ['o2', { roles: roles('11', '12') }]]) }],
        ['p2', { id: 'p2', title: 'Channels only', options: new Map([['o3', { roles: roles() }]]) }],
    ]);
    assert.deepEqual(await onboardingPrompts({ fetchOnboarding: async () => ({ prompts }) }), [{ id: 'p1', title: 'Languages', roleIds: ['10', '11', '12'] }]);
    assert.deepEqual(await onboardingPrompts({ fetchOnboarding: async () => { throw new Error('Missing Access'); } }), []);
    assert.deepEqual(await onboardingPrompts({}), []);
});
