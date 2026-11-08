// Bot i18n, part "automod command": /automod replies, join gate lines and DM, raid alerts and
// reports, nuke-alert buttons. English is byte-for-byte the old text; every language fits Discord's
// embed limits with the longest member text the code lets through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANG_CODES } from '../src/services/site/i18n.js';
import { BOT_CATALOG, botText } from '../src/utils/botText.js';
import { AUTOMOD_RULES } from '../src/config/automod.js';
import { normalizeSettings } from '../src/services/automod/automodSettings.js';
import { describeStep } from '../src/services/automod/reviewCards.js';
import { hasRuleOverride, isRelaxableRule, ruleMode } from '../src/services/automod/policy.js';
import automodCommand, {
    RULE_LABEL_KEYS, customRulesText, inviteAllowlistText, statusDescription,
} from '../src/commands/Enforcement/automod.js';
import {
    JOIN_GATE_CHECKS, closedGateText, describeJoinGate, evaluateJoinGate, gateLinePayload, hitReason, joinGateActionText, joinGateCheckText, kickNotice,
} from '../src/services/automod/joinGate.js';
import { buildIncidentReport, formatReleaseResult, releaseRow, summarizeCases } from '../src/services/automod/raidIncidentService.js';
import { describePanic } from '../src/services/automod/incidentActions.js';
import { lockdownAnnouncement, lockdownOwnerText } from '../src/services/automod/raidService.js';
import { nukeAlertRow, showDiffRow } from '../src/services/automod/alertPost.js';

const OTHERS = LANG_CODES.filter((c) => c !== 'en');
const GUILD = '300000000000000099';

// ── Dynamic keys ───────────────────────────────────────────────────────────

test('every automod rule and join gate check has its catalog keys; English equals the code\'s labels', () => {
    for (const [key, rule] of Object.entries(AUTOMOD_RULES)) {
        assert.ok(RULE_LABEL_KEYS[key], `rule ${key} has no label key`);
        assert.equal(BOT_CATALOG.catalogText('en', RULE_LABEL_KEYS[key]), rule.label, key);
    }
    for (const [check, { label, comeBack }] of Object.entries(JOIN_GATE_CHECKS)) {
        assert.deepEqual(joinGateCheckText(check, { lang: 'en' }), { label, comeBack });
        assert.equal(BOT_CATALOG.catalogText('en', `automod.joinGate.check.${check}`), label);
        assert.equal(BOT_CATALOG.catalogText('en', `automod.joinGate.comeBack.${check}`), comeBack);
        for (const lang of OTHERS) assert.ok(joinGateCheckText(check, { lang }).label, `${lang} ${check}`);
    }
    for (const action of ['off', 'flag', 'kick']) {
        assert.equal(joinGateActionText(action), action);
        for (const lang of OTHERS) assert.ok(joinGateActionText(action, { lang }));
    }
    for (const type of ['ban', 'kick', 'mute', 'warn', 'unban', 'unmute']) assert.ok(BOT_CATALOG.catalogText('en', `automod.raid.caseType.${type}`));
});

test('/automod: the catalog English equals the builder English for command, options and choices', () => {
    const json = automodCommand.data.toJSON();
    assert.equal(BOT_CATALOG.catalogText('en', 'automod.cmd.slash.description'), json.description);
    const stats = json.options.find((o) => o.name === 'stats');
    assert.equal(BOT_CATALOG.catalogText('en', 'automod.cmd.slash.stats'), stats.description);
    const gate = json.options.find((o) => o.name === 'joingate');
    const days = gate.options.find((o) => o.name === 'days');
    assert.equal(botText('en').t('automod.cmd.slash.gateDays', { days: 7 }).replace('7', ''), days.description.replace(/\d+/, ''));
    assert.ok(days.description_localizations.de.length <= 100);
    const rule = json.options.find((o) => o.name === 'rule').options.find((o) => o.name === 'rule');
    for (const choice of rule.choices) assert.equal(Object.keys(choice.name_localizations).length, 8, choice.value);
});

// ── English unchanged ──────────────────────────────────────────────────────

// The status text as the code wrote it before translation (copied), for byte-for-byte comparison.
const OLD_MODE_LABELS = { on: 'on', monitor: "report only (don't delete)", off: 'off' };
function oldStatus(settings, lockdown, exempt) {
    const relaxed = Object.keys(AUTOMOD_RULES).filter((key) => isRelaxableRule(key)).map((key) => AUTOMOD_RULES[key].label).join(', ');
    const trusted = settings.trusted?.roleId || settings.trusted?.minLevel > 0
        ? [settings.trusted.roleId ? `<@&${settings.trusted.roleId}>` : null, settings.trusted.minLevel > 0 ? `level ${settings.trusted.minLevel}+` : null].filter(Boolean).join(' or ')
        : 'not set';
    const exceptions = Object.entries(settings.channelRules || {}).map(([channelId, rules]) => {
        const list = Object.entries(rules).map(([rule, mode]) => `${AUTOMOD_RULES[rule]?.label || rule} ${OLD_MODE_LABELS[mode] || mode}`);
        return list.length ? `<#${channelId}>: ${list.join(', ')}` : null;
    }).filter(Boolean);
    const rules = Object.entries(AUTOMOD_RULES).sort(([, a], [, b]) => b.severity - a.severity).map(([key, rule]) => {
        const mode = ruleMode(settings, key);
        const tag = hasRuleOverride(settings, key) ? ` · **${OLD_MODE_LABELS[mode]}**` : mode === 'on' ? '' : ` · ${OLD_MODE_LABELS[mode]}`;
        return `**${rule.label}:** ${rule.steps.map(describeStep).join(' → ')}${tag}`;
    });
    return [
        `**Status:** ${settings.enabled ? 'on' : 'off'}`,
        `**Mode:** ${settings.mode === 'monitor' ? "report only (don't delete): review cards only, nothing is done" : 'enforce (acts, then posts a review card)'}`,
        `**Lockdown:** ${lockdown?.active ? `active since <t:${Math.floor(new Date(lockdown.startedAt).getTime() / 1000)}:R>, ${lockdown.joinerIds.length} raid joiner(s)` : 'off'}`,
        `**Exempt channels:** ${exempt.length ? exempt.map((id) => `<#${id}>`).join(', ') : 'none'}`,
        `**Channel exceptions:** ${exceptions.length ? exceptions.join('; ') : 'none'}`,
        `**Trusted members** (skip ${relaxed}): ${trusted}`,
        `**Friendly notice for a first small offence** (a notice, no warning): ${settings.secondChance ? 'on' : 'off'}`,
        `**Mood alerts** (calm-down note + slowmode in heated channels): ${settings.moodAlerts ? 'on' : 'off'}`,
        `**Join gate** (new members): ${describeJoinGate(settings.joinGate)}`,
        `**Raid panic mode** (lockdown also pauses invites and DMs): ${settings.panic.enabled ? `on, for ${settings.panic.hours} h` : 'off'}`,
        `**Allowed invites** (besides this server's own): ${inviteAllowlistText(settings.inviteAllowlist)}`,
        `**Staff guard** (anti-nuke: staff who mass-ban, mass-delete or add bots lose their staff roles): ${!settings.staffGuard ? 'off' : settings.enabled ? 'on' : 'on, but only while automod is on'}`,
        '',
        '**Punishments** (1st → 2nd → 3rd+ offence within 30 days). A mode in **bold** is set for that rule with `/automod rule`; the others follow the global mode:',
        ...rules,
    ].join('\n');
}

function sampleSettings() {
    return normalizeSettings({
        enabled: true, mode: 'monitor', ruleModes: { spam: 'off', scam: 'monitor' },
        channelRules: { 400000000000000001: { caps: 'off', english: 'monitor' } },
        trusted: { roleId: '400000000000000002', minLevel: 5 }, secondChance: true, moodAlerts: false,
        joinGate: { avatar: 'flag', age: 'kick', ageDays: 3 }, panic: { enabled: true, hours: 4 },
        inviteAllowlist: ['abc', '400000000000000003'], staffGuard: true,
    }, GUILD);
}

test('/automod status: English is byte-for-byte the old text', () => {
    for (const settings of [sampleSettings(), normalizeSettings({}, GUILD)]) {
        const lockdown = { active: true, startedAt: '2026-11-01T10:00:00Z', joinerIds: ['1', '2'] };
        assert.equal(statusDescription(GUILD, settings, lockdown, ['400000000000000004'], { lang: 'en' }), oldStatus(settings, lockdown, ['400000000000000004']));
        assert.equal(statusDescription(GUILD, settings, null, [], { lang: 'en' }), oldStatus(settings, null, []));
    }
});

test('/automod status in German: translated labels, markup and mentions kept, within 4096', () => {
    const text = statusDescription(GUILD, sampleSettings(), null, ['400000000000000004'], { lang: 'de' });
    assert.ok(text.includes('<#400000000000000004>'));
    assert.ok(text.includes('<@&400000000000000002>'));
    assert.ok(!text.includes('**Status:** on'));
    assert.ok(text.includes('/automod rule'));
    for (const lang of LANG_CODES) assert.ok(statusDescription(GUILD, sampleSettings(), null, [], { lang }).length <= 4096, lang);
});

test('/automod custom list: English unchanged; plural header in every language', () => {
    const rules = [{ id: 'a1b2c3d4', name: 'Links', words: ['x.com'], action: 'mute', muteDuration: '1h', enabled: true }];
    assert.equal(customRulesText(rules, 3, 'Normal'), '1 rule, up to 3 run on the Normal plan.\n\n**Links**: Mute 1h, on\nx.com');
    for (const lang of OTHERS) {
        const text = customRulesText([...rules, { ...rules[0], id: 'e5f6g7h8', enabled: false }], 3, 'Normal', { lang });
        assert.ok(text.includes('**Links**') && text.length <= 4000, lang);
    }
});

test('join gate: English line, reasons and DM unchanged; translated reasons keep the member\'s name as typed', () => {
    const now = Date.UTC(2026, 10, 8);
    const user = { id: '1435000000000000000', username: 'alex483920', globalName: 'discord.gg/{x}', avatar: null };
    const { hits } = evaluateJoinGate(user, { avatar: 'flag', links: 'kick', botname: 'flag', age: 'flag', ageDays: 9999 }, now);
    const member = { id: user.id, user, guild: { id: GUILD } };
    const en = gateLinePayload(member, hits, 'kickFailed', { lang: 'en', withButtons: true });
    assert.equal(en.description, `**Join gate** · <@${user.id}> alex483920 (\`${user.id}\`) · flagged (kick failed) · ${hits.map((h) => h.reason).join('; ')}`);
    assert.deepEqual(en.components[0].toJSON().components.map((c) => c.label), ['Kick', 'Dismiss']);
    assert.equal(kickNotice('Mewvo', hits), [
        `You were removed from **Mewvo** by an automatic join check: ${hits.filter((h) => h.action === 'kick').map((h) => h.reason).join('; ')}.`,
        'This is not a ban and nothing was recorded against you.',
        'You are welcome to join again after removing the link from your username and display name.',
    ].join('\n'));
    const de = hitReason(hits[1], { lang: 'de' });
    assert.ok(de.includes('discord.gg/{x}'), de);
    assert.ok(kickNotice('Mewvo', hits, { lang: 'ru' }).includes('**Mewvo**'));
    // Stored flags from before (no detail): the stored English reason.
    assert.equal(hitReason({ check: 'avatar', reason: 'old reason' }, { lang: 'de' }), 'old reason');
});

test('join gate: closing a line replaces only the outcome, in any language', () => {
    const line = '**Join gate** · <@1> bob (`1`) · flagged (kick failed) · no profile picture; link in their name ("a · b")';
    assert.equal(closedGateText(line, 'kicked by mod'), '**Join gate** · <@1> bob (`1`) · kicked by mod · no profile picture; link in their name ("a · b")');
    const member = { id: '1', user: { username: 'bob' }, guild: { id: GUILD } };
    const de = gateLinePayload(member, [{ check: 'avatar', reason: 'x', detail: {} }], 'flagged', { lang: 'de' }).description;
    const closed = closedGateText(de, botText('de').t('automod.joinGate.outcome.dismissedBy', { name: 'mod' }), { lang: 'de' });
    assert.ok(closed.includes('mod') && closed.startsWith(botText('de').t('automod.joinGate.lineTitle')), closed);
    assert.equal(closedGateText('', 'x'), '**Join gate**');
});

test('join gate settings text: English unchanged', () => {
    assert.equal(describeJoinGate({ age: 'kick', ageDays: 1 }), 'No profile picture: **off** · Link or invite in their name: **off** · Generated-looking username: **off** · New account (younger than 1 day): **kick**');
    assert.match(describeJoinGate({ age: 'kick', ageDays: 3 }, { lang: 'pl' }), /3/);
});

// ── Raid alerts ────────────────────────────────────────────────────────────

test('lockdown alert and owner DM: English unchanged', () => {
    const post = lockdownAnnouncement({ joinerCount: 12, raised: true, panic: null });
    assert.equal(post.title, 'Join raid: lockdown started');
    assert.deepEqual(post.fields.map((f) => f.name), ['What happened', 'Verification level', 'Invites and DMs', 'Raid joiners', 'End it']);
    assert.match(post.fields[0].value, /^12 accounts joined within \d+ seconds\.$/);
    assert.equal(post.fields[2].value, 'Not paused (panic mode is off: `/automod panic`)');
    const manual = lockdownAnnouncement({ joinerCount: 0, raised: false, panic: { applied: true, until: '2026-11-01T12:00:00Z' }, startedBy: { username: 'mod', id: '5' } });
    assert.equal(manual.title, 'Lockdown started');
    assert.equal(manual.fields[0].value, 'Started by mod (5) from a nuke alert.');
    assert.equal(lockdownOwnerText({ raised: true, panic: { applied: true } }, 'S', 'Sum.'),
        '**Join raid in S.** Sum. The server is in lockdown and the verification level is now High and invites and DMs are paused. End it with `/automod lockdown-end` when it is over.');
    assert.equal(lockdownOwnerText({ raised: false, panic: null, startedBy: { id: '1' } }, 'S', 'Sum.'),
        '**Lockdown in S.** Sum. The server is in lockdown. End it with `/automod lockdown-end` when it is over.');
    for (const lang of OTHERS) {
        const p = lockdownAnnouncement({ joinerCount: 3, raised: false, panic: { applied: false, reason: 'missing Manage Server' } }, { lang });
        assert.ok(p.fields.every((f) => f.name.length <= 256 && f.value.length <= 1024), lang);
        assert.ok(lockdownOwnerText({ raised: true, panic: { applied: true } }, 'S', 'x', { lang }).includes('/automod lockdown-end'), lang);
    }
});

test('panic line, release result and buttons: English unchanged', () => {
    assert.equal(describePanic({ applied: false, reason: 'Missing Access' }), 'Not paused: Missing Access');
    assert.equal(describePanic({ applied: false }), 'Not paused: Discord refused');
    assert.equal(formatReleaseResult({ clean: 3, offenders: 0, probationEnded: 0, flagsCleared: 0, notInServer: 0 }),
        '**3** raid joiner(s) broke no rule.\nExtra-watch periods ended: 0 · join-gate flags closed: 0\nNothing else was held against them.');
    assert.equal(releaseRow(1).toJSON().components[0].label, 'Release non-offenders');
    assert.deepEqual(nukeAlertRow(Date.now(), GUILD, '0').toJSON().components.map((c) => c.label), ['Show what changed', 'Revert…', 'Lock down (panic)']);
    assert.equal(showDiffRow(Date.now()).toJSON().components[0].label, 'Show what changed');
    for (const lang of OTHERS) {
        for (const c of nukeAlertRow(Date.now(), GUILD, '0', { lang }).toJSON().components) assert.ok(c.label.length <= 80, `${lang} ${c.label}`);
        assert.ok(releaseRow(1, false, { lang }).toJSON().components[0].label.length <= 80, lang);
        assert.ok(summarizeCases([], { lang }));
    }
});

test('raid incident report fits Discord\'s limits in the longest language (30 joiners, 20 long cases)', () => {
    const joiners = Array.from({ length: 30 }, (_, i) => String(1435000000000000000n + BigInt(i)));
    const cases = Array.from({ length: 20 }, (_, i) => ({ case_code: `abc${i}xyz`, type: i % 2 ? 'kick' : 'ban', target_user_id: joiners[i], target_username: `user_with_a_long_name_${i}`.padEnd(32, 'x') }));
    const incident = {
        started_at: '2026-10-27T10:00:00Z', ended_at: '2026-10-29T12:31:00Z', joiner_ids: joiners,
        actions: { raisedVerification: true, incidentActions: { applied: false, reason: 'x'.repeat(300) }, resumed: false, gateKicks: joiners },
    };
    let longest = { lang: null, size: 0 };
    for (const lang of LANG_CODES) {
        const report = buildIncidentReport(incident, cases, { endedByLabel: `${'m'.repeat(32)} (\`1435000000000000000\`)`, lang });
        const size = report.title.length + report.description.length + report.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
        assert.ok(report.title.length <= 256, `${lang} title`);
        assert.ok(report.description.length <= 4096, `${lang} description`);
        for (const field of report.fields) assert.ok(field.name.length <= 256 && field.value.length <= 1024, `${lang} field`);
        assert.ok(size <= 6000, `${lang} total ${size}`);
        if (size > longest.size) longest = { lang, size };
    }
    assert.ok(longest.lang, 'a longest language was measured');
});

test('join gate line fits a 4096 description in every language with the longest names', () => {
    const now = Date.UTC(2026, 10, 8);
    const user = { id: '1435000000000000000', username: 'abcdefghijklmnopqrstuvwxyz12345', globalName: `https://${'x'.repeat(60)}`, avatar: null };
    const { hits } = evaluateJoinGate(user, { avatar: 'kick', links: 'kick', botname: 'kick', age: 'kick', ageDays: 365 }, now);
    for (const lang of LANG_CODES) {
        const { description, components } = gateLinePayload({ id: user.id, user, guild: { id: GUILD } }, hits, 'kickFailed', { lang, withButtons: true });
        assert.ok(description.length <= 4096, lang);
        for (const c of components[0].toJSON().components) assert.ok(c.label.length <= 80, lang);
        assert.ok(kickNotice('S'.repeat(100), hits, { lang }).length <= 2000, `${lang} DM`);
    }
});
