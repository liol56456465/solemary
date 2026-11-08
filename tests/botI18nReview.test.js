// Bot i18n, part "review": automod review cards (reviewFormat.js / reviewCards.js), second-opinion
// requests, the review queue, staff-guard and nuke alerts (staffGuardService.js) and the revert
// buttons (backupRevert.js). English output unchanged; every dynamic key exists; every card and
// alert fits Discord's embed limits in every language with maximum-length user text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTOMOD_RULES, REVIEW_ACTIONS, automodConfig } from '../src/config/automod.js';
import { LANG_CODES } from '../src/services/site/i18n.js';
import { botText } from '../src/utils/botText.js';
import {
    CLOSE_STATUS, buildCardPayload, builtInRuleLabel, cardTitle, closedTitle, compactLine, describeStep, ordinalIn,
    outcomeLabel, reviewActionLabel, statusVerb, stepVerb,
} from '../src/services/automod/reviewFormat.js';
import { entryFrom } from '../src/services/automod/reviewCards.js';
import { secondOpinionPayload } from '../src/services/automod/secondOpinion.js';
import { formatQueue } from '../src/services/automod/reviewQueue.js';
import { guardWhy, nukeAlertContent, staffRemovedContent } from '../src/services/automod/staffGuardService.js';
import { diffPayload, revertConfirmPayload } from '../src/handlers/backupRevert.js';
import { createEmbed } from '../src/utils/embeds.js';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const STEPS = [{ type: 'warn' }, { type: 'kick' }, { type: 'mute', durationMs: HOUR }, { type: 'mute', durationMs: 28 * DAY }, { type: 'ban', durationMs: 7 * DAY }, { type: 'ban', durationMs: null }];
const guild = { id: 'g1', client: {} };
const user = { id: '123456789012345678', username: 'alice' };

// ── English unchanged ──────────────────────────────────────────────────────

test('English: card texts are byte for byte the earlier English', () => {
    const entry = entryFrom({
        guild, rule: 'caps', evidence: 'wrote mostly in capital letters', targetUser: user, channelId: '222',
        messageUrl: 'https://discord.com/channels/g1/222/333', content: 'HELLO', step: { type: 'mute', durationMs: DAY },
        result: { record: { case_code: 'k3f9a' } }, offence: 2,
    }, 1000);
    entry.count = 3;
    entry.lastAt = 1000 + 2 * 60000;
    const embed = buildCardPayload(entry, { lang: 'en' }).embeds[0].toJSON();
    assert.equal(embed.title, 'Muted 1 day · Excessive caps');
    assert.equal(embed.description, '<@123456789012345678> wrote mostly in capital letters in <#222>.\n2nd Excessive caps offence in 30 days.\n**3 messages** in 2 minutes; the latest is shown below.');
    assert.deepEqual(embed.fields.map((f) => f.name), ['Message (deleted)', 'Case'], 'caps deletes the message: no link');
    const kept = buildCardPayload({ ...entry, latest: { ...entry.latest, deleted: false } }, { lang: 'en' }).embeds[0].toJSON();
    assert.deepEqual(kept.fields.map((f) => f.name), ['Message', 'Case', 'Message link']);
    assert.equal(kept.fields[2].value, '[Jump to message](https://discord.com/channels/g1/222/333)');
    assert.equal(closedTitle('Muted 1 day · Spam', 'kept', 'Admin'), 'Kept by Admin · Muted 1 day · Spam');
    assert.equal(cardTitle({ kind: 'monitor', rule: 'spam', suggested: { type: 'ban', durationMs: null } }), "Report only (don't delete): would ban permanently · Spam");
    assert.equal(compactLine({ ...entry, tier: 'compact', count: 2 }), '**Excessive caps** · <@123456789012345678> · muted 1 day · case `k3f9a` · <#222> · 2 messages');
    assert.equal(describeStep({ type: 'mute', durationMs: HOUR }), 'Mute 1 hour');
    assert.equal(stepVerb({ type: 'ban', durationMs: 7 * DAY }), 'ban 7 days');
    assert.equal(outcomeLabel({ type: 'ban', durationMs: null }), 'Permanently banned');
});

test('English: second opinion, queue, staff guard and revert texts unchanged', () => {
    const second = secondOpinionPayload('111', ['abc1234', 'def5678'], 'https://x/y').embeds[0].toJSON();
    assert.equal(second.title, 'Second opinion?');
    assert.equal(second.description, 'Kept by <@111>. A second admin can confirm or undo.\nCases: `abc1234` `def5678`\n[Open the card](https://x/y)');
    assert.equal(second.footer.text, `Random spot check (${Math.round(automodConfig.secondOpinionRate * 100)}% of kept cards)`);
    assert.equal(formatQueue([]), 'Nothing is waiting for review.');
    assert.equal(guardWhy('banKick', { count: 5 }).en, `5 bans/kicks within ${automodConfig.guardWindowMs / 60000} minutes`);
    assert.equal(guardWhy('deletes', { count: 4 }).en, `4 channel/role deletions within ${automodConfig.guardWindowMs / 60000} minutes`);
    assert.equal(guardWhy('webhooks', { count: 3 }).en, `3 webhooks created within ${automodConfig.guardWindowMs / 60000} minutes`);
    assert.equal(guardWhy('permission', { permissions: 'Administrator', role: '@everyone' }).en, 'gave Administrator to @everyone');
    assert.equal(guardWhy('staffWarnings', { count: 3 }).en, '3 active staff warnings');
    const removed = staffRemovedContent({ member: { id: '9', user: { username: 'mod' } }, why: guardWhy('banKick', { count: 5 }), removedNames: 'Mod', nuke: false });
    assert.equal(removed.title, 'Staff roles removed');
    assert.equal(removed.summary, `**Staff member:** mod (\`9\`)\n**Why:** 5 bans/kicks within 10 minutes\n**Removed roles:** Mod\nRestore with \`/staff restore\`.`);
    assert.deepEqual(removed.fields.map((f) => f.name), ['Staff member', 'Why', 'Removed roles', 'Restore']);
    assert.equal(nukeAlertContent('botAdded', { botId: '1', executor: 'x', kicked: true }).fields[2].value, 'Kicked. The owner can add it again if it is wanted.');
    const snapshot = { id: 7, created_at: '2026-11-01T10:20:00Z', summary: '3 roles' };
    const diff = diffPayload(snapshot, { everyone: null, deletedRoles: [], deletedChannels: [], changedRoles: [], overwriteChanges: [], addedRoles: [], addedChannels: [] }).embeds[0].toJSON();
    assert.equal(diff.title, 'Snapshot #7 vs the server now');
    assert.equal(diff.footer.text, 'Snapshot taken 2026-11-01 10:20 UTC · 3 roles');
});

// ── Dynamic keys ───────────────────────────────────────────────────────────

test('every review action, built-in rule and close status has a text in every language (English = config)', () => {
    for (const lang of LANG_CODES) {
        for (const [key, action] of Object.entries(REVIEW_ACTIONS)) {
            const label = reviewActionLabel(key, { lang });
            assert.ok(label && label.length <= 100, `${lang} ${key}`);
            if (lang === 'en') assert.equal(label, action.label);
        }
        for (const [key, rule] of Object.entries(AUTOMOD_RULES)) {
            const label = builtInRuleLabel(key, { lang });
            assert.ok(label, `${lang} rule ${key}`);
            if (lang === 'en') assert.equal(label, rule.label);
        }
        for (const [status, [verb]] of Object.entries(CLOSE_STATUS)) {
            const text = statusVerb(status, { lang });
            assert.ok(text, `${lang} ${status}`);
            if (lang === 'en') assert.equal(text, verb);
        }
        assert.ok(ordinalIn(3, lang).startsWith('3'), lang);
    }
    assert.equal(builtInRuleLabel('custom:1'), null, 'custom rules keep their own name');
});

// ── Embed limits in every language ─────────────────────────────────────────

function embedSize(embed) {
    const e = embed.toJSON ? embed.toJSON() : embed;
    return (e.title?.length || 0) + (e.description?.length || 0) + (e.footer?.text?.length || 0)
        + (e.fields || []).reduce((n, f) => n + f.name.length + f.value.length, 0);
}

function assertEmbedFits(embed, where) {
    const e = embed.toJSON ? embed.toJSON() : embed;
    assert.ok((e.title?.length || 0) <= 256, `${where}: title ${e.title?.length}`);
    assert.ok((e.description?.length || 0) <= 4096, `${where}: description ${e.description?.length}`);
    assert.ok((e.fields || []).length <= 25, `${where}: fields`);
    for (const f of e.fields || []) {
        assert.ok(f.name.length <= 256, `${where}: field name ${f.name.length}`);
        assert.ok(f.value.length <= 1024, `${where}: field ${f.name} ${f.value.length}`);
    }
    assert.ok(embedSize(e) <= 6000, `${where}: total ${embedSize(e)}`);
}

function cardVariants() {
    const long = 'Ä'.repeat(4000);
    const base = {
        guild, rule: 'harassment', evidence: `insulted <@1> 3 times in 10 minutes ${'x'.repeat(300)}`, targetUser: { id: user.id, username: 'u'.repeat(32) },
        channelId: '222', messageUrl: `https://discord.com/channels/${'1'.repeat(19)}/${'2'.repeat(19)}/${'3'.repeat(19)}`, content: long,
        result: { record: { case_code: 'k3f9abc' }, banRecord: { case_code: 'b4n11zz' } }, offence: 23, probation: { until: Date.UTC(2026, 11, 1) },
    };
    const out = [];
    for (const step of STEPS) {
        out.push({ ...base, step });
        out.push({ ...base, step, result: { error: { message: 'e'.repeat(1500) } } });
        out.push({ ...base, step, raid: true });
        out.push({ ...base, step: null, monitor: true, suggested: step });
        out.push({ ...base, step, rule: 'custom:9', ruleLabel: 'R'.repeat(100) });
    }
    out.push({ ...base, step: null, rule: 'report', report: { reporter: 'r'.repeat(2000), messageId: '9', removed: true } });
    out.push({ ...base, step: null, rule: 'report', report: { reporter: 'r', messageId: '9', removed: false } });
    out.push({ ...base, step: null, note: { emoji: 'x', title: 'N'.repeat(200) } });
    return out;
}

test('every review card variant fits Discord limits in every language (max-length text, long bursts, disputes)', () => {
    for (const lang of LANG_CODES) {
        for (const p of cardVariants()) {
            const entry = entryFrom(p, 1000);
            entry.count = 999;
            entry.lastAt = 1000 + 59 * 60000;
            entry.actions = Array.from({ length: 40 }, (_, i) => ({ step: STEPS[i % STEPS.length], caseCode: `c${String(i).padStart(6, 'x')}` }));
            entry.contest = { caseCode: 'k3f9abc', reason: '*'.repeat(3000) };
            for (const tier of ['full', 'compact']) {
                entry.tier = tier;
                const payload = buildCardPayload(entry, { lang });
                const where = `${lang} ${entry.kind} ${p.rule} ${tier}`;
                if (payload.content) assert.ok(payload.content.length <= 2000, `${where}: content ${payload.content.length}`);
                for (const embed of payload.embeds) assertEmbedFits(embed, where);
                for (const row of payload.components) {
                    for (const c of row.toJSON().components) {
                        if (c.label) assert.ok(c.label.length <= 80, `${where}: button ${c.label}`);
                        if (c.placeholder) assert.ok(c.placeholder.length <= 150, `${where}: placeholder`);
                        for (const o of c.options || []) {
                            assert.ok(o.label.length <= 100, `${where}: option ${o.label}`);
                            if (o.description) assert.ok(o.description.length <= 100, `${where}: option description`);
                        }
                    }
                }
            }
        }
    }
});

test('the longest language still fits: second opinion, staff-guard alert and nuke alerts in every language', () => {
    const roleNames = Array.from({ length: 250 }, (_, i) => `Role name ${i} ${'r'.repeat(80)}`).join(', ');
    for (const lang of LANG_CODES) {
        const tr = botText(lang);
        assertEmbedFits(secondOpinionPayload('1'.repeat(19), Array.from({ length: 40 }, (_, i) => `abc${i}xyz`), 'https://discord.com/channels/1/2/3', { lang }).embeds[0], `${lang} second opinion`);
        for (const nuke of [true, false]) {
            const content = staffRemovedContent({
                member: { id: '1'.repeat(19), user: { username: 'm'.repeat(32) } },
                why: guardWhy('permission', { permissions: 'Administrator, ManageGuild, ManageRoles, ManageChannels, ManageWebhooks, BanMembers, KickMembers, MentionEveryone', role: 'R'.repeat(100) }),
                removedNames: roleNames, keptNames: roleNames, nuke,
            }, { lang });
            // Posted through createEmbed (postAlert / postModLog), which clamps fields to Discord's limits.
            assertEmbedFits(createEmbed({ title: content.title, fields: content.fields, timestamp: true }), `${lang} staff roles removed`);
            const dm = `${tr.t('automod.guard.dm.header', { server: 'S'.repeat(100) })}\n${content.summary}`;
            assert.ok(dm.length > 0);
        }
        for (const [kind, data] of [
            ['botAdded', { botId: '1'.repeat(19), executor: `<@${'2'.repeat(19)}> (\`${'2'.repeat(19)}\`)`, kicked: false }],
            ['webhooks', { executor: 'x', deleted: 50 }],
            ['permission', { roleText: `${'R'.repeat(100)} (\`1\`)`, names: 'Administrator, ManageGuild, ManageRoles, ManageChannels, ManageWebhooks, BanMembers, KickMembers, MentionEveryone', executor: 'x', ok: false }],
        ]) {
            const alert = nukeAlertContent(kind, data, { lang });
            const embed = createEmbed({ title: alert.title, fields: alert.fields, timestamp: true });
            assertEmbedFits(embed, `${lang} nuke ${kind}`);
            // Nothing in a nuke alert is clamped away in any language: the fixed text is short.
            assert.equal(embed.toJSON().fields.length, alert.fields.length, `${lang} nuke ${kind}: every field kept`);
        }
        const why = guardWhy('banKick', { count: 7 }).text(tr);
        assert.ok(why.includes('7'), `${lang}: ${why}`);
    }
});

test('revert confirm and diff payloads translate, keep the snapshot id and stay inside the limits', () => {
    const snapshot = { id: 42, created_at: '2026-11-01T10:20:00Z', summary: 's'.repeat(300) };
    const diff = { everyone: null, deletedRoles: [], deletedChannels: [], changedRoles: [], overwriteChanges: [], addedRoles: [], addedChannels: [] };
    for (const lang of LANG_CODES) {
        const tr = botText(lang);
        const d = diffPayload(snapshot, diff, { withButtons: true, lang }).embeds[0].toJSON();
        assert.ok(d.title.includes('42'), lang);
        assert.ok(d.description.includes('/backup snapshots'), `${lang}: command name kept`);
        assertEmbedFits(d, `${lang} diff`);
        const c = revertConfirmPayload({ id: '1', name: 'G'.repeat(100) }, snapshot, diff, null, { lang }).embeds[0].toJSON();
        assert.equal(c.title, tr.t('automod.revert.nothingTitle'));
        assertEmbedFits(c, `${lang} confirm`);
    }
});
