// Accept / Deny: Administrators of the main server only, also when pressed in the support
// server (ban/kick appeal staff threads), where the main-server member is fetched fresh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { enforcementConfig } from '../src/config/enforcement.js';
import { canDecideAppeals } from '../src/handlers/appealsHandler.js';

const member = (id, admin) => ({ id, guild: { ownerId: 'someone' }, permissions: { has: (p) => admin && p === PermissionFlagsBits.Administrator } });

test('appeal decisions: main-server Administrators only, in either server', async () => {
    const main = '1700000000000000001';
    const support = '1700000000000000002';
    const saved = { mainGuildId: enforcementConfig.mainGuildId, supportGuildId: enforcementConfig.supportGuildId };
    Object.assign(enforcementConfig, { mainGuildId: main, supportGuildId: support });
    try {
        const admins = new Set(['1']);
        const mainGuild = { members: { fetch: async ({ user }) => member(user, admins.has(user)) } };
        const client = { guilds: { cache: new Map([[main, mainGuild]]) } };
        const at = (guildId, userId, localAdmin = false) => ({ guildId, user: { id: userId }, member: member(userId, localAdmin) });
        assert.equal(await canDecideAppeals(at(main, '1', true), client), true);
        assert.equal(await canDecideAppeals(at(main, '2', false), client), false);
        assert.equal(await canDecideAppeals(at(support, '1', false), client), true, 'admin in main, pressing in support');
        assert.equal(await canDecideAppeals(at(support, '2', true), client), false, 'admin of the support server only: no');
        assert.equal(await canDecideAppeals(at('1800000000000000009', '1', true), client), false, 'any other server: no');
    } finally {
        Object.assign(enforcementConfig, saved);
    }
});
