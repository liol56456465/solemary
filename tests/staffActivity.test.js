import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weekStart } from '../src/services/staffActivityService.js';

test('weeks start on Monday (UTC)', () => {
    assert.equal(weekStart(new Date('2026-10-26T00:00:00Z')), '2026-10-26'); // Monday
    assert.equal(weekStart(new Date('2026-10-28T12:00:00Z')), '2026-10-26'); // Wednesday
    assert.equal(weekStart(new Date('2026-11-01T23:59:59Z')), '2026-10-26'); // Sunday
    assert.equal(weekStart(new Date('2026-11-02T00:00:00Z')), '2026-11-02'); // next Monday
});

// Ticket ratings (v14): "· ★4.6 (5)" on /staff stats and the weekly report lines.
test('stats and activity lines show the ticket rating badge; a ratings-only staff member is named by mention', async () => {
    const { formatActivityLine, formatStatsLine } = await import('../src/services/staffActivityService.js');
    const stats = { moderatorId: '423456789012345678', username: 'mod', actions: { ban: 1, kick: 0, mute: 0, warn: 2 }, total: 3, voided: 0, appealsAccepted: 0, appealsDenied: 0, ratingAvg: 4.56, ratingCount: 5 };
    assert.ok(formatStatsLine(stats).endsWith(' · ★4.6 (5)'));
    assert.ok(!formatStatsLine({ ...stats, ratingAvg: null, ratingCount: 0 }).includes('★'), 'no ratings, no badge');
    assert.ok(formatStatsLine({ ...stats, username: null }).startsWith('<@423456789012345678>: '));
    const week = { username: 'mod', inactive: false, messages: 3, actions: 0, appeals: 0, reviews: 0, tickets: 2, ratingAvg: 2, ratingCount: 1 };
    assert.ok(formatActivityLine(week).endsWith('2 tickets · ★2.0 (1)'));
});
