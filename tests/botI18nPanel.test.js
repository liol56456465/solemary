// Bot i18n: the /enforcements panel (handlers/enforcementPanel.js, flowBuilder.js, precedentService.js)
// in 8 languages. English output unchanged, every language renders without a missing key, and the
// longest language still fits Discord's embed and component limits with maximum-length input.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { panelSummaryLines, recentCasesText, confirmationPayload, resultPayload } = await import('../src/handlers/enforcementPanel.js');
const {
    ACTION_LABELS, ACTION_TYPES, actionLabelIn, attachFlowEvidence, countedWarnsText, flowSummary, parseFlowInput, warnEffectText,
} = await import('../src/services/enforcement/flowBuilder.js');
const { formatPrecedent, memberLadderLine, ladderStageShortIn, ladderStageIn, precedentHint } = await import('../src/services/enforcement/precedentService.js');
const { ladderStage, ladderStageShort } = await import('../src/services/enforcement/format.js');
const { noContactLines } = await import('../src/services/enforcement/noContactService.js');
const { templateLabel } = await import('../src/services/enforcement/templateService.js');
const { LANG_CODES, botText } = await import('../src/utils/botText.js');

const OTHERS = LANG_CODES.filter((c) => c !== 'en');
const HOUR = 3600 * 1000;
const user = { id: '123456789012345678', username: 'kit', createdAt: new Date('2020-01-01T00:00:00Z') };

function embedSize(embed) {
    const d = embed.data;
    return (d.title || '').length + (d.description || '').length + (d.footer?.text || '').length
        + (d.fields || []).reduce((n, f) => n + f.name.length + f.value.length, 0);
}
function assertEmbedFits(embed, where) {
    const d = embed.data;
    assert.ok((d.title || '').length <= 256, `${where}: title ${d.title?.length}`);
    assert.ok((d.description || '').length <= 4096, `${where}: description ${d.description?.length}`);
    for (const f of d.fields || []) {
        assert.ok(f.name.length <= 256, `${where}: field name ${f.name.length}`);
        assert.ok(f.value.length <= 1024, `${where}: field ${f.value.length}`);
    }
    assert.ok(embedSize(embed) <= 6000, `${where}: total ${embedSize(embed)}`);
}

// ── English unchanged ──────────────────────────────────────────────────────

test('English: the confirm step reads exactly as before', () => {
    const flow = {
        type: 'ban', targetUsername: 'kit', targetId: '1', reason: 'Spam', durationMs: 7 * 24 * HOUR, unappealable: true,
        name: 'kit ban 1', nameIsDefault: true, evidence: [{ url: 'https://discord.com/channels/1/2/3', excerpt: 'hi  there' }, { url: 'https://x.test/a', sourceMessageUrl: 'https://x.test/a' }],
        templateName: 'Spam 7d', precedent: 'P', memberHint: 'M',
    };
    const { embeds, components } = confirmationPayload(flow, '9', 'n');
    assert.equal(embeds[0].data.title, 'Confirm: Ban');
    assert.equal(embeds[0].data.description, [
        '**Template:** Spam 7d',
        '**User:** kit (`1`)',
        '**Reason:** Spam',
        '**Duration:** 7 days',
        '**Can they appeal?:** No',
        '**Name:** kit ban 1 (default)',
        '**Evidence:** https://discord.com/channels/1/2/3 ("hi there")\nhttps://x.test/a (message not readable, link only)',
        'The user is DMed before the action runs.',
        '-# P',
        '-# M',
    ].join('\n'));
    assert.deepEqual(components[0].components.map((b) => b.data.label), ['Confirm', 'Edit details', 'Cancel']);
});

test('English: the result step, warn effect, counted warns, flow errors and evidence notes are unchanged', async () => {
    const done = resultPayload({ type: 'mute', targetUsername: 'kit' }, { record: { case_code: 'abcde', name: 'kit mute 1', expires_at: new Date(0) }, dmDelivered: false, notes: ['n1'] }).embeds[0].data;
    assert.equal(done.title, 'Mute done: kit');
    assert.equal(done.description, '**Case code:** `abcde`\n**Name:** kit mute 1\n**Ends:** <t:0:F> (<t:0:R>)\n**The DM could not be delivered** (DMs closed or no shared server). The action still ran.\nn1');
    assert.equal(resultPayload({ type: 'unban', targetUsername: 'kit' }, { dmDelivered: true, notes: [] }).embeds[0].data.description, 'DM delivered.');
    assert.equal(warnEffectText({ level: 0, warns_since_level: 0 }), 'warning 1 of 3.');
    assert.match(warnEffectText({ level: 0, warns_since_level: 2 }), /^reaches the warning limit → automatic 7 days ban \(warning stage 1 of 3\)\.$/);
    assert.equal(countedWarnsText({ level: 0, warns_since_level: 2 }), '2 of 3');
    assert.equal(countedWarnsText({ level: 1, warns_since_level: 0 }), '0 (next warn bans)');
    assert.equal(parseFlowInput({ type: 'mute', reasonKey: 'spam' }, { durationInput: 'soon' }).error, '"soon" is not a valid duration. Use formats like 30m, 24h, 7d or 1mo.');
    assert.equal(parseFlowInput({ type: 'mute', reasonKey: 'spam' }, {}).error, 'A mute needs a duration, e.g. 30m, 24h, 7d or 1mo.');
    const notes = await attachFlowEvidence({ evidence: [{ url: 'a' }, { url: 'b' }] }, { case_code: 'x' }, { id: '1', username: 'm' },
        { add: async (code, item) => { if (item.url === 'b') throw Object.assign(new Error('nope'), { context: { expected: true } }); } });
    assert.deepEqual(notes, ['Evidence attached: 1 link.', 'Evidence b was not saved: nope']);
    assert.deepEqual(ACTION_TYPES.map((t) => actionLabelIn(t)), ACTION_TYPES.map((t) => ACTION_LABELS[t]));
    assert.equal(templateLabel({ action: 'ban', duration: null }), 'permanent ban');
    assert.deepEqual(noContactLines([{ otherId: '5', until: 1893456000000, id: 7 }]), ['with <@5> until <t:1893456000:f> (order #7)']);
    assert.equal(ladderStageShortIn(2), ladderStageShort(2));
    assert.equal(ladderStageIn(0), ladderStage(0));
});

test('English: the panel summary and last cases lines are unchanged', () => {
    const state = {
        member: { joinedAt: null, roles: { cache: { size: 2 } } }, banned: true, ladder: { level: 0, warns_since_level: 1 },
        activeBan: { case_code: 'bbbbb', expires_at: null }, activeMute: null, muted: true,
    };
    assert.deepEqual(panelSummaryLines(user, state), [
        '**User:** kit (<@123456789012345678>) · `123456789012345678`',
        '**Account created:** <t:1577836800:F> (<t:1577836800:R>)',
        '**In server:** yes, joined at an unknown time · 1 role',
        '**Counted warns:** 1 of 3 · **Warning stage:** 0 of 3 (no warning ban yet)',
        '**Active punishment:** ban `bbbbb` · permanent; has the muted role (no record)',
    ]);
    const rows = [{ case_code: 'aaaaa', type: 'warn', name: 'kit warn 2', created_at: new Date('2025-01-02T00:00:00Z'), status: 'active', is_test: true, is_imported: true }];
    assert.equal(recentCasesText(rows, 2), '`aaaaa` **warn** (test) · kit warn 2 · <t:1735776000:d> · active · imported\n-# 1 older: see /background');
});

// ── Every language ─────────────────────────────────────────────────────────

test('every language: the action labels, statuses and case types are translated (no English fallback by accident)', () => {
    for (const lang of OTHERS) {
        for (const type of ACTION_TYPES) assert.ok(actionLabelIn(type, { lang }), `${lang} ${type}`);
        assert.notEqual(actionLabelIn('removewarn', { lang }), 'Remove warn', lang);
        const statuses = [
            { voided_at: new Date() }, { status: 'revoked', revoke_reason: 'Appeal accepted' }, { status: 'revoked', revoke_reason: 'Automod decision' },
            { status: 'revoked' }, { status: 'appeal_pending' }, { status: 'active', expires_at: new Date(0) }, { status: 'active' },
        ];
        for (const row of statuses) {
            const text = recentCasesText([{ case_code: 'aaaaa', type: 'ban', name: 'n', created_at: new Date(0), ...row }], 1, new Map(), { lang });
            assert.ok(!/removed \(a mistake\)|lifted by appeal|reversed by|lifted early|appeal pending|· active$|· expired$/.test(text), `${lang}: ${text}`);
        }
        for (const t of [{ action: 'mute', duration: '1h' }, { action: 'ban', duration: '7d' }, { action: 'ban', duration: null }, { action: 'kick' }, { action: 'warn' }]) {
            assert.ok(templateLabel(t, { lang }), `${lang} template ${t.action}`);
        }
    }
});

test('every language: precedent and member lines render with all their parts', async () => {
    const rows = [
        { type: 'warn', duration_ms: null, count: 15, overturned: 1 }, { type: 'mute', duration_ms: HOUR, count: 5, overturned: 0 },
        { type: 'kick', duration_ms: null, count: 2, overturned: 0 }, { type: 'ban', duration_ms: null, count: 1, overturned: 0 },
    ];
    for (const lang of LANG_CODES) {
        const line = formatPrecedent('Spam', rows, { lang });
        assert.ok(line.includes('Spam') && line.includes('15') && line.includes('180'), `${lang}: ${line}`);
        assert.ok(formatPrecedent('Spam', [], { lang }).includes('Spam'), lang);
        assert.ok(formatPrecedent('Spam', [{ type: 'ban', duration_ms: null, count: 200, overturned: 0 }], { lang }).includes('200'), lang);
        assert.ok(memberLadderLine({ level: 0, warns_since_level: 1 }, { lang }).includes('1'), lang);
        assert.ok(memberLadderLine({ level: 3, warns_since_level: 0 }, { lang }), lang);
        assert.ok(await precedentHint('1', 'custom', 'x', { lang }), lang);
        assert.ok(await precedentHint('1', 'spam', 'Spam', { lang, load: async () => { throw new Error('down'); } }), lang);
        for (const level of [0, 1, 2, 3]) assert.ok(ladderStageShortIn(level, { lang }).includes(String(level)), `${lang} stage ${level}`);
        for (const ladder of [{ level: 0, warns_since_level: 0 }, { level: 0, warns_since_level: 2 }, { level: 1, warns_since_level: 0 }, { level: 2, warns_since_level: 0 }]) {
            assert.ok(warnEffectText(ladder, { lang }), `${lang} effect`);
        }
    }
    assert.notEqual(formatPrecedent('Spam', rows, { lang: 'de' }), formatPrecedent('Spam', rows));
});

test('every language: component texts stay within Discord limits (modal 45, descriptions 100, buttons 80)', () => {
    const limits = {
        'staff.panel.modal.customReason': 45, 'staff.panel.modal.duration': 45, 'staff.panel.modal.name': 45, 'staff.panel.modal.evidence': 45,
        'staff.panel.modal.unappealable': 45, 'staff.panel.modal.reasonOptional': 45,
        'staff.panel.modal.durationBan': 100, 'staff.panel.modal.durationMute': 100, 'staff.panel.modal.unappealableHint': 100,
        'staff.panel.reason.severe': 100, 'staff.panel.reason.customHint': 100, 'staff.panel.reason.custom': 100,
        'staff.panel.reason.placeholder': 150, 'staff.panel.removeWarn.placeholder': 150, 'staff.panel.templatePlaceholder': 150,
        'staff.panel.button.cancel': 80, 'staff.panel.button.confirm': 80, 'staff.panel.button.editDetails': 80, 'staff.panel.button.tryAgain': 80,
    };
    for (const lang of LANG_CODES) {
        const tr = botText(lang);
        for (const [key, max] of Object.entries(limits)) assert.ok(tr.t(key).length <= max, `${lang} ${key}: ${tr.t(key).length} > ${max}`);
        assert.ok(tr.t('staff.panel.modal.evidenceHint', { max: 5 }).length <= 100, `${lang} evidenceHint`);
        for (const type of ACTION_TYPES) assert.ok(actionLabelIn(type, { lang }).length <= 80, `${lang} button ${type}`);
    }
});

test('longest language: panel summary, confirm and result embeds fit with maximum-length input', () => {
    const longName = 'w'.repeat(32);
    const big = { id: '123456789012345678', username: longName, createdAt: new Date(0) };
    const state = {
        member: { joinedAt: new Date(0), roles: { cache: { size: 250 } } }, banned: true, muted: true, ladder: { level: 2, warns_since_level: 0 },
        activeBan: { case_code: 'abcdefg', expires_at: new Date(Date.now() + 1e9) }, activeMute: { case_code: 'hjkmnpq', expires_at: new Date(Date.now() + 1e9) },
    };
    const appeals = new Map(Array.from({ length: 120 }, (_, i) => [`c${String(i).padStart(5, 'x')}`, 'pending']));
    const orders = Array.from({ length: 80 }, (_, i) => ({ otherId: '123456789012345678', until: Date.now() + 1e9, id: 1000 + i }));
    const rows = Array.from({ length: 3 }, (_, i) => ({ case_code: `abcde${i}`, type: 'mute', name: 'n'.repeat(100), created_at: new Date(0), status: 'active', appeal_status: 'denied', is_test: true, is_imported: true }));
    const longest = {};
    for (const lang of LANG_CODES) {
        const tr = botText(lang);
        // buildPanel's own composition (it needs Discord + the database): the same truncation.
        const description = panelSummaryLines(big, state, appeals, orders, { lang }).join('\n');
        const recent = recentCasesText(rows, 900, appeals, { lang });
        longest[lang] = description.length;
        const embed = {
            data: {
                title: tr.t('staff.panel.title', { name: big.username.slice(0, 200) }),
                description: description.length > 4096 ? `${description.slice(0, 4095)}…` : description,
                fields: [{ name: tr.t('staff.panel.recent.titleCount', { shown: 3, total: 900 }), value: recent.length > 1024 ? `${recent.slice(0, 1023)}…` : recent }],
            },
        };
        assert.ok(recent.length <= 1024, `${lang}: last cases ${recent.length} (3 cases always fit in 1024)`);
        assertEmbedFits(embed, `${lang} panel`);

        const flow = {
            type: 'ban', targetUsername: longName, targetId: big.id, reason: 'r'.repeat(500), durationMs: 37 * 24 * HOUR + 5 * HOUR,
            unappealable: false, name: 'n'.repeat(100), nameIsDefault: true, templateName: 't'.repeat(60),
            evidence: Array.from({ length: 5 }, (_, i) => ({ url: `https://discord.com/channels/123456789012345678/123456789012345678/12345678901234567${i}`, excerpt: 'e'.repeat(300) })),
            precedent: formatPrecedent('x'.repeat(100), [{ type: 'warn', duration_ms: null, count: 150, overturned: 20 }, { type: 'mute', duration_ms: 3 * 24 * HOUR + HOUR, count: 50, overturned: 3 }], { lang }),
            memberHint: memberLadderLine({ level: 0, warns_since_level: 2 }, { lang }),
        };
        const confirm = confirmationPayload(flow, '1', 'n', { lang }).embeds[0];
        assertEmbedFits(confirm, `${lang} confirm`);
        const result = resultPayload({ type: 'removewarn', targetUsername: 'x'.repeat(200) }, {
            record: { case_code: 'abcdefg', name: 'n'.repeat(100), expires_at: new Date() }, dmDelivered: false, notes: Array.from({ length: 6 }, () => 'z'.repeat(800)),
        }, { lang }).embeds[0];
        assertEmbedFits(result, `${lang} result`);
        assert.ok(result.data.description.endsWith('…'), `${lang}: long notes are truncated`);
        const summary = flowSummary(flow, { lang });
        assert.equal(summary.rows.length, 5, lang);
    }
    // German and Russian really are the long ones here (the check above used them).
    const max = Math.max(...Object.values(longest));
    assert.ok(longest.de > longest.en && longest.ru > longest.en, JSON.stringify(longest));
    assert.ok(max > 4096, 'the test input overflows, so truncation is exercised');
});
