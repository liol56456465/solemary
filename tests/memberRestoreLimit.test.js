// /backup restore only adds verified members to Mewvo's own servers (purpose limit).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedRestoreGuildIds, restoreMembers, restoreRefusal } from '../src/services/memberBackupService.js';

const config = { mainGuildId: '100000000000000001', supportGuildId: '100000000000000002' };

test('restore: main and support servers are allowed, any other server is refused', () => {
    assert.equal(restoreRefusal('100000000000000001', config, {}), null);
    assert.equal(restoreRefusal('100000000000000002', config, {}), null);
    const refusal = restoreRefusal('100000000000000009', config, {});
    assert.match(refusal, /only be restored into Mewvo's own servers/);
    assert.match(refusal, /MEMBER_RESTORE_GUILD_IDS/);
    assert.ok(restoreRefusal('', config, {}), 'an empty id is refused');
    assert.ok(restoreRefusal(undefined, { mainGuildId: null, supportGuildId: null }, {}), 'nothing configured: everything refused');
});

test('restore: MEMBER_RESTORE_GUILD_IDS adds servers; junk entries are ignored', () => {
    const env = { MEMBER_RESTORE_GUILD_IDS: ' 100000000000000003 , nope,,100000000000000004' };
    assert.deepEqual([...allowedRestoreGuildIds(config, env)].sort(), [
        '100000000000000001', '100000000000000002', '100000000000000003', '100000000000000004',
    ]);
    assert.equal(restoreRefusal('100000000000000004', config, env), null);
    assert.ok(restoreRefusal('nope', config, env));
});

test('restore: restoreMembers refuses a foreign server before reading any token', async () => {
    await assert.rejects(
        restoreMembers({}, { id: '199999999999999999', name: 'Elsewhere' }, async () => {}),
        /only be restored into Mewvo's own servers/
    );
});
