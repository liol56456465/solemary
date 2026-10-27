import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuditLogEvent, ChannelType } from 'discord.js';
import {
    EVENT_TYPES, channelAncestry, getIgnoreList, isEventEnabled, isIgnoredLog,
} from '../src/services/loggingService.js';
import { describeAuditEntry } from '../src/services/auditLogLogging.js';
import { channelLines, channelUpdateLines, threadUpdateLines } from '../src/utils/logging/channelLogLines.js';
import { DASHBOARD_CATEGORIES, EVENT_TYPES_BY_CATEGORY } from '../src/utils/logging/loggingUi.js';
import { normalizeGuildConfig } from '../src/utils/schemas.js';

test('logging: ignore lists cover users, channels with their parents, and roles', () => {
    const ignore = { users: ['u1'], channels: ['cat'], roles: ['r1'] };
    assert.equal(isIgnoredLog(ignore, { userId: 'u1' }), true);
    assert.equal(isIgnoredLog(ignore, { channelIds: ['thread', 'chan', 'cat'] }), true);
    assert.equal(isIgnoredLog(ignore, { roleIds: ['r2', 'r1'] }), true);
    assert.equal(isIgnoredLog(ignore, { userId: 'u2', channelIds: ['chan'], roleIds: ['r2'] }), false);
    assert.equal(isIgnoredLog({ users: [], channels: [] }, { roleIds: ['r1'] }), false, 'old configs have no roles list');
});

test('logging: channel ancestry walks thread → channel → category', () => {
    const cache = new Map([
        ['t', { id: 't', parentId: 'c' }],
        ['c', { id: 'c', parentId: 'k' }],
        ['k', { id: 'k', parentId: null }],
    ]);
    const guild = { channels: { cache } };
    assert.deepEqual(channelAncestry(guild, 't'), ['t', 'c', 'k']);
    assert.deepEqual(channelAncestry(guild, 'gone'), ['gone']);
    assert.deepEqual(channelAncestry(guild, null), []);
});

test('logging: the roles ignore list survives config normalization', () => {
    const config = normalizeGuildConfig({ logging: { enabled: true, ignore: { users: ['u'], channels: ['c'], roles: ['r'] } } });
    assert.deepEqual(config.logging.ignore, { users: ['u'], channels: ['c'], roles: ['r'] });
    const old = normalizeGuildConfig({ logging: { enabled: true, ignore: { users: [], channels: ['c'] } } });
    assert.deepEqual(getIgnoreList(old), { users: [], channels: ['c'], roles: [] });
});

test('logging: new event types are in dashboard categories and on by default', () => {
    for (const type of [EVENT_TYPES.CHANNEL_CREATE, EVENT_TYPES.THREAD_UPDATE, EVENT_TYPES.EMOJI_CREATE, EVENT_TYPES.AUTOMOD_RULE_UPDATE, EVENT_TYPES.INVITE_DELETE]) {
        const category = type.split('.')[0];
        assert.ok(DASHBOARD_CATEGORIES.includes(category), type);
        assert.ok(EVENT_TYPES_BY_CATEGORY[category].includes(type), type);
        assert.equal(isEventEnabled({ logging: { enabled: true, enabledEvents: {} } }, type), true);
    }
    assert.equal(isEventEnabled({ logging: { enabled: true, enabledEvents: { 'server.*': false } } }, EVENT_TYPES.WEBHOOK_CREATE), false);
    // Category toggle buttons: 5 per row, at most 4 rows next to the action row.
    assert.ok(Math.ceil(DASHBOARD_CATEGORIES.length / 5) <= 4);
});

test('logging: audit log entries become log entries', () => {
    const emoji = describeAuditEntry({
        action: AuditLogEvent.EmojiCreate, executorId: '42', targetId: '7', target: { id: '7', name: 'catjam' },
        changes: [{ key: 'name', new: 'catjam' }],
    });
    assert.equal(emoji.eventType, EVENT_TYPES.EMOJI_CREATE);
    assert.equal(emoji.title, 'Emoji created');
    assert.equal(emoji.userId, '42');
    assert.match(emoji.lines.join('\n'), /\*\*Name:\*\* catjam \(`7`\)/);
    assert.match(emoji.lines.join('\n'), /\*\*By:\*\* <@42>/);

    const invite = describeAuditEntry({
        action: AuditLogEvent.InviteCreate, executorId: '42', target: null,
        changes: [{ key: 'code', new: 'abc' }, { key: 'channel_id', new: '99' }, { key: 'max_uses', new: 0 }, { key: 'max_age', new: 86400 }],
    });
    assert.equal(invite.channelId, '99');
    assert.match(invite.lines.join('\n'), /discord\.gg\/abc/);
    assert.match(invite.lines.join('\n'), /Max uses:\*\* no limit · \*\*Expires after:\*\* 24 h/);

    const rule = describeAuditEntry({
        action: AuditLogEvent.AutoModerationRuleUpdate, executorId: '42', targetId: '5', target: { id: '5', name: 'No links' },
        changes: [{ key: 'enabled', old: true, new: false }, { key: 'exempt_roles', old: [], new: ['1'] }],
    });
    assert.equal(rule.eventType, EVENT_TYPES.AUTOMOD_RULE_UPDATE);
    assert.match(rule.lines.join('\n'), /Enabled:\*\* true → false/);
    assert.match(rule.lines.join('\n'), /Exempt roles:\*\* none → 1 item\(s\)/);

    const webhookDelete = describeAuditEntry({
        action: AuditLogEvent.WebhookDelete, executorId: '42', targetId: '8', target: null,
        changes: [{ key: 'name', old: 'Spidey' }, { key: 'channel_id', old: '12' }],
    });
    assert.match(webhookDelete.lines.join('\n'), /Spidey/);
    assert.equal(webhookDelete.channelId, '12');

    assert.equal(describeAuditEntry({ action: AuditLogEvent.MemberBanAdd }), null);
});

test('logging: channel and thread lines show what changed', () => {
    assert.deepEqual(channelLines({ id: '1', name: 'general', type: ChannelType.GuildText, parentId: '9', topic: null }), [
        '**Name:** general (`1`)', '**Type:** Text channel', '**Category:** <#9>',
    ]);
    const before = { name: 'a', topic: '', parentId: null, nsfw: false, rateLimitPerUser: 0, permissionOverwrites: { cache: new Map() } };
    assert.deepEqual(channelUpdateLines(before, { ...before }), []);
    const after = {
        ...before, name: 'b', rateLimitPerUser: 10,
        permissionOverwrites: { cache: new Map([['r', { id: 'r', allow: { bitfield: 1n }, deny: { bitfield: 0n } }]]) },
    };
    assert.deepEqual(channelUpdateLines(before, after), ['**Name:** a → b', '**Slowmode:** 0s → 10s', '**Permissions:** overwrites changed']);
    assert.deepEqual(threadUpdateLines({ name: 't', archived: false, locked: false }, { name: 't', archived: true, locked: true }),
        ['**Archived:** yes', '**Locked:** yes']);
});
