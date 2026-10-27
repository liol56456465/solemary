import { test } from 'node:test';
import assert from 'node:assert/strict';

const { panelSummaryLines, recentCasesText } = await import('../src/handlers/enforcementPanel.js');
const { caseStatusLabel } = await import('../src/services/enforcement/caseService.js');

const user = { id: '123456789012345678', username: 'kit', createdAt: new Date('2020-01-01T00:00:00Z') };
const ladder = { level: 1, warns_since_level: 0 };

test('panel summary: member with roles, ladder and an active mute', () => {
    const member = { joinedAt: new Date('2024-05-01T00:00:00Z'), roles: { cache: { size: 4 } } };
    const state = {
        member, banned: false, ladder, activeBan: null, muted: true,
        activeMute: { case_code: 'abcde', expires_at: new Date(Date.now() + 3600000) },
    };
    const text = panelSummaryLines(user, state, new Map([['xyzab', 'pending']])).join('\n');
    assert.match(text, /Account created:.*<t:1577836800:F>/);
    assert.match(text, /In server:\*\* yes, joined <t:1714521600:F>/);
    assert.match(text, /3 roles/);
    assert.match(text, /Ladder level:\*\* 1/);
    assert.match(text, /next warn bans/);
    assert.match(text, /Active punishment:\*\* mute `abcde`/);
    assert.match(text, /Pending appeal:\*\* `xyzab`/);
});

test('panel summary: banned non-member without a record', () => {
    const state = { member: null, banned: true, ladder: { level: 0, warns_since_level: 2 }, activeBan: null, activeMute: null, muted: false };
    const text = panelSummaryLines(user, state).join('\n');
    assert.match(text, /In server:\*\* no/);
    assert.match(text, /2 of 3/);
    assert.match(text, /banned \(no record/);
});

test('last cases: type, name, date, status, and a pointer to older ones', () => {
    const rows = [
        { case_code: 'aaaaa', type: 'warn', name: 'kit warn 2', created_at: new Date('2025-01-02T00:00:00Z'), status: 'active' },
        { case_code: 'bbbbb', type: 'ban', name: 'kit ban 1', created_at: new Date('2025-01-01T00:00:00Z'), status: 'revoked', voided_at: new Date() },
    ];
    const text = recentCasesText(rows, 5);
    assert.match(text, /`aaaaa` \*\*warn\*\* · kit warn 2 · <t:1735776000:d> · active/);
    assert.match(text, /`bbbbb` \*\*ban\*\* · kit ban 1 · .* · voided/);
    assert.match(text, /3 older/);
    assert.equal(recentCasesText([], 0), 'None');
    assert.equal(caseStatusLabel(rows[1]), 'voided');
});
