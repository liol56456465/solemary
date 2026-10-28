import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
    buildSearchWhere, decodeSearchFilters, encodeSearchFilters, normalizeSearchFilters, parseSearchDate,
} = await import('../src/services/enforcement/caseSearchService.js');
const { describeSearchFilters, filtersFromMessage, searchResultLine } = await import('../src/handlers/caseSearchView.js');

const MEMBER = '123456789012345678';

test('search dates: YYYY-MM-DD only, real calendar days', () => {
    assert.equal(parseSearchDate('2026-10-27').toISOString(), '2026-10-27T00:00:00.000Z');
    assert.throws(() => parseSearchDate('2026-02-30'), /not a valid/);
    assert.throws(() => parseSearchDate('27/10/2026'), /YYYY-MM-DD/);
});

test('search filters: validation and the from/to order', () => {
    assert.deepEqual(normalizeSearchFilters({}), {});
    assert.deepEqual(normalizeSearchFilters({ type: 'warn', status: 'voided', reasonKey: ' Spam ', text: '  hi  ' }),
        { type: 'warn', status: 'voided', reasonKey: 'spam', text: 'hi' });
    assert.throws(() => normalizeSearchFilters({ type: 'nuke' }), /type must be/);
    assert.throws(() => normalizeSearchFilters({ status: 'open' }), /status must be/);
    assert.throws(() => normalizeSearchFilters({ reasonKey: "x'; drop" }), /reason key/);
    assert.throws(() => normalizeSearchFilters({ from: '2026-10-02', to: '2026-10-01' }), /after the to date/);
});

test('search filters survive the round trip through the message footer', () => {
    const filters = normalizeSearchFilters({ memberId: MEMBER, type: 'mute', from: '2026-01-01', text: 'naïve · ref x' });
    const token = encodeSearchFilters(filters);
    assert.match(token, /^[A-Za-z0-9_-]+$/);
    assert.deepEqual(decodeSearchFilters(token), filters);
    assert.equal(decodeSearchFilters('not json!'), null);
    assert.equal(decodeSearchFilters(Buffer.from('{"t":"nuke"}').toString('base64url')), null, 're-validated');
    const message = { embeds: [{ footer: { text: `Page 2 of 3 · newest first · ref ${token}` } }] };
    assert.deepEqual(filtersFromMessage(message), filters);
    assert.equal(filtersFromMessage({ embeds: [] }), null);
});

test('search WHERE: parameterized, inclusive end date, status rules', () => {
    const now = new Date('2026-10-27T12:00:00Z');
    const { where, params } = buildSearchWhere('g1', {
        memberId: MEMBER, moderatorId: '223456789012345678', type: 'ban', reasonKey: 'spam',
        from: '2026-10-01', to: '2026-10-27', text: '50%_off', status: 'active',
    }, now);
    assert.match(where, /^guild_id = \$1 AND target_user_id = \$2 AND moderator_id = \$3 AND type = \$4 AND reason_key = \$5/);
    assert.match(where, /created_at >= \$6 AND created_at < \$7/);
    assert.match(where, /\(name ILIKE \$8 OR reason ILIKE \$8\)/);
    assert.match(where, /expires_at > \$9/);
    assert.deepEqual(params, ['g1', MEMBER, '223456789012345678', 'ban', 'spam',
        '2026-10-01T00:00:00Z', '2026-10-28T00:00:00.000Z', '%50\\%\\_off%', now.toISOString()]);

    assert.match(buildSearchWhere('g1', { status: 'voided' }).where, /voided_at IS NOT NULL/);
    assert.deepEqual(buildSearchWhere('g1', { status: 'revoked' }).params, ['g1']);
    assert.match(buildSearchWhere('g1', { status: 'ended' }, now).where, /status = 'expired' OR/);
});

test('search view text: filters summary and a result row', () => {
    assert.equal(describeSearchFilters({}), 'none (all cases)');
    assert.match(describeSearchFilters({ reasonKey: 'spam', from: '2026-01-01' }), /reason \*\*Spam\*\* · date \*\*2026-01-01 → …\*\*/);
    const line = searchResultLine({
        case_code: 'abcde', name: 'kit warn 1', type: 'warn', target_username: 'kit', moderator_username: 'mod',
        created_at: new Date('2025-01-02T00:00:00Z'), status: 'revoked', voided_at: new Date(),
    });
    assert.equal(line, '`abcde` **kit warn 1** · warn · kit · by mod · <t:1735776000:d> · voided');
});
