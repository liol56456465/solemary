import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField } from 'discord.js';
import { getDangerousPermissions, getRoleAssignmentProblem, hasDangerousPermissions } from '../src/utils/roleSafety.js';

const GUILD_ID = '100000000000000000';
const bot = { roles: { highest: { position: 10 } } };

function role(overrides = {}) {
    return {
        id: '200000000000000000',
        name: 'Member',
        guild: { id: GUILD_ID },
        managed: false,
        position: 5,
        permissions: new PermissionsBitField(['ViewChannel', 'SendMessages']),
        ...overrides,
    };
}

test('plain roles are safe to hand out', () => {
    assert.equal(hasDangerousPermissions(role()), false);
    assert.equal(getRoleAssignmentProblem(role(), bot), null);
});

test('staff permissions beyond the old list are caught', () => {
    for (const permission of ['ModerateMembers', 'ManageMessages', 'MentionEveryone', 'ViewAuditLog', 'MoveMembers']) {
        const r = role({ permissions: new PermissionsBitField([permission]) });
        assert.deepEqual(getDangerousPermissions(r), [permission]);
        assert.match(getRoleAssignmentProblem(r, bot), /staff permissions/);
    }
    // Administrator implies every permission.
    assert.ok(getDangerousPermissions(role({ permissions: new PermissionsBitField(['Administrator']) })).length > 1);
});

test('@everyone, managed roles and roles at or above the bot are refused', () => {
    assert.match(getRoleAssignmentProblem(role({ id: GUILD_ID }), bot), /@everyone/);
    assert.match(getRoleAssignmentProblem(role({ managed: true }), bot), /managed/);
    assert.match(getRoleAssignmentProblem(role({ position: 10 }), bot), /highest role/);
    assert.match(getRoleAssignmentProblem(role(), null), /highest role/);
    assert.match(getRoleAssignmentProblem(null, bot), /no longer exists/);
});
