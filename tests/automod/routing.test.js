import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelPurposeFor, formatModLogLine, resolveChannelId } from '../../src/services/automod/channelRouting.js';
import * as reasons from '../../src/services/automod/reasons.js';
import { buildDigest } from '../../src/services/automod/automodDigest.js';
import { formatQueue } from '../../src/services/automod/reviewQueue.js';

test('post kinds are routed by purpose', () => {
    for (const kind of ['raid', 'staff', 'massguard', 'slowmode', 'automod-report', 'digest', 'automod', 'system']) {
        assert.equal(channelPurposeFor(kind), 'alerts', kind);
    }
    for (const kind of ['ban', 'kick', 'mute', 'warn', 'unban', 'unmute', 'removewarn', 'appeal', 'caseedit', 'casevoid', 'unknown']) {
        assert.equal(channelPurposeFor(kind), 'modlog', kind);
    }
});

test('review and alerts fall back to the mod log; all three when set', () => {
    const all = { reviewChannelId: 'R', alertsChannelId: 'A', modLogChannelId: 'M' };
    assert.equal(resolveChannelId('review', all), 'R');
    assert.equal(resolveChannelId('alerts', all), 'A');
    assert.equal(resolveChannelId('modlog', all), 'M');
    const onlyModLog = { reviewChannelId: null, alertsChannelId: null, modLogChannelId: 'M' };
    assert.equal(resolveChannelId('review', onlyModLog), 'M');
    assert.equal(resolveChannelId('alerts', onlyModLog), 'M');
    assert.equal(resolveChannelId('modlog', onlyModLog), 'M');
    assert.equal(resolveChannelId('alerts', { modLogChannelId: null }), null);
});

test('mod log line: one line per action', () => {
    const line = formatModLogLine('ban', [
        { name: 'User', value: 'alice (111)' },
        { name: 'Moderator', value: 'Meowist (automatic)' },
        { name: 'Case', value: '`k3f9a` — alice ban 1' },
        { name: 'Reason', value: 'Automod: NSFW content' },
        { name: 'Duration', value: '7 days (ends <t:1:F>)' },
        { name: 'DM', value: 'Not delivered' },
    ]);
    assert.equal(line, '🔨 **Ban** · alice (111) · by Meowist (automatic) · `k3f9a` alice ban 1 · “Automod: NSFW content” · 7 days (ends <t:1:F>) · DM: Not delivered');
    assert.ok(!line.includes('\n'));
    assert.ok(!formatModLogLine('warn', [{ name: 'Reason', value: 'a\nb' }]).includes('\n'));
});

test('reasons are plain English and hide the word', () => {
    assert.equal(reasons.blockedWordReason(), 'used a blocked word (hidden)');
    assert.equal(reasons.sexualReason('5'), 'sent a sexual remark (hidden) at <@5>');
    assert.equal(reasons.privacyReason('a phone number'), 'shared what looks like a phone number');
    assert.equal(reasons.adBotReason({ newAccount: true, channelCount: 4 }), 'looks like an ad bot: new account, same message in 4 channels');
    assert.equal(reasons.harassmentReason('9', 3, 10 * 60 * 1000), 'insulted <@9> 3 times in 10 minutes');
    assert.equal(reasons.scamReason('look-alike link dlscord.gift'), 'posted a fake link (dlscord.gift) made to look like Discord or Steam');
    assert.equal(reasons.charactersReason('letters outside the English alphabet (абв)'), 'used letters outside the English alphabet');
    assert.equal(reasons.englishReason('fr'), 'wrote in another language (looks like French)');
    assert.equal(reasons.impersonationReason('"Mod Bob" uses a staff title'), 'has a name that uses a staff title ("Mod Bob")');
    assert.equal(reasons.capitalize('insulted x'), 'Insulted x');
});

test('digest: actions with undo rate, hits per rule, busiest channels, memory footer', () => {
    const now = 10 * 24 * 3600 * 1000;
    const digest = buildDigest({
        stats: { total: 10, byGroup: [{ label: 'Spam', actions: 10, undone: 4, changed: 0 }] },
        hits: [
            { rule: 'caps', channelId: 'c1' }, { rule: 'caps', channelId: 'c1' }, { rule: 'spam', channelId: 'c2', monitor: true },
        ],
        openCount: 2,
        raids: 1,
        startedAt: now - 3 * 3600 * 1000,
        now,
    });
    assert.equal(digest.empty, false);
    assert.match(digest.fields[0].value, /\*\*Spam:\*\* 10 · 4 undone \(40%\) ⚠️/);
    assert.match(digest.fields[1].value, /^Excessive caps: 2\nSpam: 1 \(1 in monitor mode\)$/);
    assert.match(digest.fields[2].value, /^<#c1>: 2/);
    assert.match(digest.fields[3].value, /2 waiting/);
    assert.match(digest.footer, /since the bot started 3 h ago/);
    assert.equal(buildDigest({ stats: { total: 0, byGroup: [] }, startedAt: 0, now }).empty, true);
});

test('queue formatting', () => {
    assert.equal(formatQueue([]), 'Nothing is waiting for review.');
    const text = formatQueue([{ title: '🟠 Muted 1 hour — Harassment', url: 'https://x', at: 2000, count: 3 }]);
    assert.equal(text, '• [🟠 Muted 1 hour — Harassment](https://x) · <t:2:R> · 3 messages');
});
