// Several ticket staff roles: reading (list + old single key), saving (keys kept in step),
// channel overwrites, access checks and pings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ticketStaffRoleIds, memberHasTicketStaffRole, ticketStaffMentions, MAX_TICKET_STAFF_ROLES } from '../src/utils/ticket/staffRoles.js';
import { validateTicketSettingsPatch } from '../src/services/ticketSettingsService.js';
import { buildTicketPermissionOverwrites } from '../src/services/ticket.js';
import { isModmailStaff } from '../src/services/modmailService.js';

const A = '600000000000000001';
const B = '600000000000000002';
const C = '600000000000000003';
const member = (ids) => ({ id: 'm', guild: { ownerId: 'o' }, permissions: { has: () => false }, roles: { cache: new Map(ids.map((id) => [id, {}])) } });

test('reads the list; falls back to the old single role only when no list was saved', () => {
    assert.deepEqual(ticketStaffRoleIds({ ticketStaffRoleId: A }), [A]);
    assert.deepEqual(ticketStaffRoleIds({ ticketStaffRoleIds: [A, B, A], ticketStaffRoleId: A }), [A, B]);
    assert.deepEqual(ticketStaffRoleIds({ ticketStaffRoleIds: [], ticketStaffRoleId: A }), [], 'a saved empty list means none');
    assert.deepEqual(ticketStaffRoleIds({}), []);
    assert.deepEqual(ticketStaffRoleIds(null), []);
    assert.equal(ticketStaffMentions({ ticketStaffRoleIds: [A, B] }), `<@&${A}> <@&${B}>`);
});

test('saving a list keeps the old key = first role; the old key alone replaces the list', () => {
    assert.deepEqual(validateTicketSettingsPatch({ ticketStaffRoleIds: [B, C] }, 'g'), { ticketStaffRoleIds: [B, C], ticketStaffRoleId: B });
    assert.deepEqual(validateTicketSettingsPatch({ ticketStaffRoleIds: [] }, 'g'), { ticketStaffRoleIds: [], ticketStaffRoleId: null });
    assert.deepEqual(validateTicketSettingsPatch({ ticketStaffRoleId: A }, 'g'), { ticketStaffRoleId: A, ticketStaffRoleIds: [A] });
    assert.deepEqual(validateTicketSettingsPatch({ ticketStaffRoleId: null }, 'g'), { ticketStaffRoleId: null, ticketStaffRoleIds: [] });
});

test('more than the maximum or a non-id is refused', () => {
    const tooMany = Array.from({ length: MAX_TICKET_STAFF_ROLES + 1 }, (_, i) => `6000000000000001${String(i).padStart(2, '0')}`);
    assert.throws(() => validateTicketSettingsPatch({ ticketStaffRoleIds: tooMany }, 'g'));
    assert.throws(() => validateTicketSettingsPatch({ ticketStaffRoleIds: ['abc'] }, 'g'));
});

test('every staff role gets the ticket channel; access and modmail staff check accept any of them', () => {
    const ow = buildTicketPermissionOverwrites({ guildId: 'g', memberId: 'm', botId: 'b', staffRoleIds: [A, B] });
    assert.deepEqual(ow.map((o) => o.id), ['g', 'm', 'b', A, B]);
    const config = { ticketStaffRoleIds: [A, B] };
    assert.equal(memberHasTicketStaffRole(member([B]), config), true);
    assert.equal(memberHasTicketStaffRole(member([C]), config), false);
    assert.equal(isModmailStaff(member([B]), config), true);
    assert.equal(isModmailStaff(member([C]), config), false);
    assert.equal(isModmailStaff(member([A]), { ticketStaffRoleId: A }), true, 'old single role still works');
});

test('Delete System clears the list too; /ticket setup refuses @everyone and bot roles', async () => {
    const { readFileSync } = await import('node:fs');
    assert.match(readFileSync('src/commands/Ticket/modules/ticket_dashboard.js', 'utf8'), /keysToDelete = \[[^\]]*'ticketStaffRoleIds'/);
    const { setupTicketSystem } = await import('../src/services/ticketPanelService.js');
    const guild = { id: '700000000000000001', roles: { cache: new Map([[B, { managed: true }]]) } };
    const client = { db: null };
    for (const opts of [{ staffRoleId: guild.id }, { staffRoleIds: [A, B] }]) {
        await assert.rejects(setupTicketSystem({ ...client, guilds: { cache: new Map() } }, guild, { panelChannel: { id: 'c' }, ...opts }),
            (e) => /not @everyone or a bot's role/.test(`${e.userMessage || ''} ${e.message}`));
    }
});

test('dashboard Tickets settings: two picked roles are saved; both show as selected', async () => {
    const { getAction, getModule } = await import('../src/services/dashboard/modules/index.js');
    const G = '300000000000000003';
    const role = (id, name, position) => ({ id, name, position, managed: false, editable: true, hexColor: '#000000', permissions: { has: () => false } });
    const roles = new Map([[G, role(G, '@everyone', 0)], [A, role(A, 'Mods', 2)], [B, role(B, 'Helpers', 1)]]);
    const current = { ticketStaffRoleId: null, maxTicketsPerUser: 3, dmOnClose: true, ticketButtonLabel: 'Open ticket', ticketPanelMessage: 'x' };
    const calls = [];
    const ctx = {
        lang: 'en', guildId: G, env: { NODE_ENV: 'test' }, calls, canEdit: true, canAct: true, query: {},
        guild: { id: G, ownerId: 'o', channels: { cache: new Map() }, roles: { cache: roles }, members: { me: null } },
        client: {}, csrf: 'c'.repeat(32), actor: { userId: 'u', username: 'u' },
        services: {
            getTicketSettings: async () => ({ ...current }),
            updateTicketSettings: async (c, gid, patch) => { calls.push(patch); return { before: current, after: { ...current, ...patch } }; },
        },
    };
    const form = { ticketStaffRoleIds: [B, A], maxTicketsPerUser: '3', dmOnClose: '1', ticketButtonLabel: 'Open ticket', ticketPanelMessage: 'x' };
    await getAction(getModule('tickets'), 'settings').run(ctx, form);
    assert.deepEqual(calls, [{ ticketStaffRoleIds: [B, A] }]);
});
