// test.js — /test: send the DM an enforcement action would send, without doing it.
//
// Nothing is executed: no ban/kick/role change, no ladder change, no log entry. The
// case IS saved, marked is_test, with a real case code, so the whole flow can be
// tested: appeal it with that code, see it in /appeals, accept or deny it. The bot
// never acts on test cases (no unban, role, ladder or banned-role changes; expiry
// only closes the record). The DM comes from the same dmTemplates functions as the
// real action, and kicks and accepted appeals get a real one-time invite. It goes to
// the person running the command, never to the target.
//
// Any server (multi-server B4): an Administrator of that server previews the DM as that server
// would send it (its name, appeal invite, language and ladder), and the test case is saved in
// that server.

import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { successEmbed } from '../../utils/embeds.js';
import { ErrorTypes, TitanBotError } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { ENFORCEMENT_REASONS, enforcementConfig } from '../../config/enforcement.js';
import { createRejoinInvite, getLadder, isAdministrator, previewWarn, sendDm } from '../../services/enforcement/enforcementService.js';
import { isEnforcementDbAvailable } from '../../services/enforcement/db.js';
import { insertCase, setDmDelivered } from '../../services/enforcement/caseService.js';
import { appealAcceptedDm, appealDeniedDm, banDm, kickDm, muteDm, warnDm } from '../../services/enforcement/dmTemplates.js';
import { addMonths, parseDuration } from '../../services/enforcement/format.js';
import { botText, resolveBotLanguage, textForInteraction } from '../../utils/botText.js';
import { descriptionLocalizations } from '../../utils/commandLocalizations.js';
import { isMewvoServer } from '../../utils/ownerPower.js';

function userError(message) {
    return new TitanBotError(message, ErrorTypes.USER_INPUT, message, { expected: true });
}

/** Saves a test case shaped like the real action's, and returns the mod_cases row. */
function saveTestCase({ guildId, moderator, target, type, reason, durationMs = null, unappealable = false, ladderLevel = 0, extra = {} }) {
    const now = new Date();
    return insertCase(null, {
        guildId,
        targetUserId: target.id,
        targetUsername: target.username,
        moderatorId: moderator.id,
        moderatorUsername: moderator.username,
        type,
        // Unique per server; kept out of the real "<username> <type> <n>" numbering.
        name: `${target.username} test ${type} ${now.getTime().toString(36)}`,
        reason,
        reasonSource: 'custom',
        durationMs,
        expiresAt: durationMs ? new Date(now.getTime() + durationMs) : null,
        unappealable,
        ladderLevelAfter: ladderLevel,
        isTest: true,
        ...extra,
    });
}

/**
 * A reason typed exactly as a prebuilt reason (its label or key, any case) is saved as that
 * prebuilt reason, so the preview shows the rule line it is linked to (dashboard Rules page).
 * Anything else stays a custom reason (no rule line).
 */
export function prebuiltReasonFields(reason) {
    const text = String(reason || '').trim().toLowerCase();
    const match = ENFORCEMENT_REASONS.find((r) => r.label.toLowerCase() === text || r.key === text);
    return match ? { reason: match.label, reasonSource: 'prebuilt', reasonKey: match.key } : {};
}

/** The warn DM, or — when this warn would hit the ladder limit — the automatic ban DM that replaces it. */
async function warnPreview({ guild, invoker, target, reason, ladder, lang, tr }) {
    const step = previewWarn(ladder);
    const dm = { guildId: guild.id, serverName: guild.name, lang };
    const warn = await saveTestCase({
        guildId: guild.id,
        moderator: invoker, target, type: 'warn', reason, ladderLevel: step.nextLevel, extra: prebuiltReasonFields(reason),
    });
    if (!step.escalates) {
        return { content: warnDm(warn, step.warnNumber, dm), record: warn, note: tr.t('owner.test.noteWarn', { number: step.warnNumber, threshold: step.threshold }) };
    }
    const ban = await saveTestCase({
        guildId: guild.id,
        moderator: { id: invoker.client.user.id, username: invoker.client.user.username },
        target,
        type: 'ban',
        reason: enforcementConfig.ladderReason,
        durationMs: step.banDurationMs,
        ladderLevel: step.nextLevel,
        extra: {
            isAuto: true,
            appealDeadline: step.nextLevel === 3 ? addMonths(new Date(), enforcementConfig.level3AppealMonths) : null,
        },
    });
    return {
        content: banDm(ban, dm),
        record: ban,
        note: tr.t('owner.test.noteLadder', { level: step.nextLevel, code: warn.case_code }),
    };
}

/**
 * The DM preview for `action`, as `guild` would send it (its name, invite, language, ladder). Saves a test case; executes nothing.
 * `lang`: the DM's language (the server's); `replyLang`: refusals and the note for the person running /test (their own).
 */
export async function buildPreview({ action, guild, invoker, target, reason, durationMs, unappealable, lang = 'en', replyLang = 'en' }) {
    const tr = botText(replyLang);
    if (!action.startsWith('appeal-') && !isEnforcementDbAvailable()) {
        throw userError(tr.t('owner.test.noDatabase'));
    }
    const ladder = isEnforcementDbAvailable()
        ? await getLadder(guild.id, target.id)
        : { level: 0, warns_since_level: 0 };
    const dm = { guildId: guild.id, serverName: guild.name, lang };
    const save = (type, options = {}) => saveTestCase({
        guildId: guild.id,
        moderator: invoker, target, type, reason, ladderLevel: ladder.level, ...options, extra: { ...prebuiltReasonFields(reason), ...options.extra },
    });

    switch (action) {
        case 'ban': {
            const record = await save('ban', { durationMs, unappealable });
            return { content: banDm(record, dm), record };
        }
        case 'kick': {
            const record = await save('kick');
            const invite = await createRejoinInvite(guild, `Rejoin invite for kick ${record.case_code} (/test)`);
            return { content: kickDm(record, invite, dm), record, invite };
        }
        case 'mute': {
            if (!durationMs) throw userError(tr.t('owner.test.muteNeedsDuration'));
            const record = await save('mute', { durationMs });
            return { content: muteDm(record, dm), record };
        }
        case 'warn':
            return warnPreview({ guild, invoker, target, reason, ladder, lang, tr });
        case 'appeal-accepted': {
            const invite = await createRejoinInvite(guild, 'Appeal accepted (/test)');
            return { content: appealAcceptedDm(invoker.username, invite, dm), invite };
        }
        case 'appeal-denied':
            return { content: appealDeniedDm({ guildId: guild.id, lang }) };
        default:
            throw userError(tr.t('owner.test.unknownAction', { action }));
    }
}

export default {
    // Every server (multi-server B4), for that server's Administrators.
    data: new SlashCommandBuilder()
        .setName('test')
        .setDescription('Send yourself the DM an action would send and save a test case. Nothing is executed')
        .setDescriptionLocalizations(descriptionLocalizations('owner.test.cmd.description'))
        .addStringOption((option) => option
            .setName('action')
            .setDescription('Which DM to preview')
            .setDescriptionLocalizations(descriptionLocalizations('owner.test.cmd.action'))
            .setRequired(true)
            .addChoices(
                { name: 'ban', name_localizations: descriptionLocalizations('owner.test.cmd.choiceBan'), value: 'ban' },
                { name: 'kick', name_localizations: descriptionLocalizations('owner.test.cmd.choiceKick'), value: 'kick' },
                { name: 'mute', name_localizations: descriptionLocalizations('owner.test.cmd.choiceMute'), value: 'mute' },
                { name: 'warn', name_localizations: descriptionLocalizations('owner.test.cmd.choiceWarn'), value: 'warn' },
                { name: 'appeal accepted', name_localizations: descriptionLocalizations('owner.test.cmd.choiceAppealAccepted'), value: 'appeal-accepted' },
                { name: 'appeal denied', name_localizations: descriptionLocalizations('owner.test.cmd.choiceAppealDenied'), value: 'appeal-denied' },
            ))
        .addUserOption((option) => option
            .setName('user')
            .setDescription('Who the DM would be for (they receive nothing)')
            .setDescriptionLocalizations(descriptionLocalizations('owner.test.cmd.user'))
            .setRequired(true))
        .addStringOption((option) => option
            .setName('reason')
            .setDescription('Reason shown in the DM')
            .setDescriptionLocalizations(descriptionLocalizations('owner.test.cmd.reason'))
            .setMaxLength(500))
        .addStringOption((option) => option
            .setName('duration')
            .setDescription('Ban/mute length, e.g. 30m, 12h, 7d, 1mo (ban: empty = permanent)')
            .setDescriptionLocalizations(descriptionLocalizations('owner.test.cmd.duration'))
            .setMaxLength(20))
        .addBooleanOption((option) => option
            .setName('no_appeal')
            .setDescription('Ban only: preview a ban they cannot appeal')
            .setDescriptionLocalizations(descriptionLocalizations('owner.test.cmd.noAppeal'))),

    async execute(interaction) {
        // Replies to the person running /test: their Discord language. The DM preview: the server's (below).
        const tr = textForInteraction(interaction);
        if (!interaction.guildId || !interaction.guild) {
            throw new TitanBotError('/test outside a server', ErrorTypes.PERMISSION,
                tr.t('owner.test.serverOnly'), { expected: true });
        }
        if (!isAdministrator(interaction.member)) {
            throw new TitanBotError('Not an administrator', ErrorTypes.PERMISSION,
                tr.t('owner.test.noAdmin'), { expected: true });
        }

        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;

        const action = interaction.options.getString('action');
        const target = interaction.options.getUser('user');
        const rawDuration = interaction.options.getString('duration')?.trim() || '';
        const durationMs = rawDuration ? parseDuration(rawDuration) : null;
        if (rawDuration && durationMs == null) {
            throw userError(tr.t('owner.test.badDuration'));
        }

        const { content, note, invite, record } = await buildPreview({
            action,
            guild: interaction.guild,
            invoker: interaction.user,
            target,
            reason: interaction.options.getString('reason')?.trim() || 'No reason given', // stored on the test case: English like real cases
            durationMs,
            unappealable: interaction.options.getBoolean('no_appeal') ?? false,
            // The language the member would get: the server's (a DM), not the invoker's.
            lang: resolveBotLanguage({ guildId: interaction.guildId, userId: target.id, purpose: 'dm' }),
            replyLang: tr.lang,
        });

        const delivered = await sendDm(interaction.user, content);
        if (record) await setDmDelivered(record.id, delivered);
        logger.info(`/test preview of ${action} DM for ${target.id} sent to ${interaction.user.id}: ${delivered ? 'delivered' : 'not delivered'}`);
        if (!delivered) {
            throw userError(tr.t('owner.test.dmFailed'));
        }

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed(tr.t('owner.test.sentTitle'), [
                tr.t('owner.test.exact', { action, name: target.username }) + (note ? ` ${tr.t('owner.test.note', { note })}` : ''),
                tr.t('owner.test.nothingExecuted'),
                record
                    ? `${tr.t('owner.test.caseSaved', { code: record.case_code })} `
                        + (target.id === interaction.user.id
                            ? (isMewvoServer(interaction.guildId) ? tr.t('owner.test.appealSupport') : tr.t('owner.test.appealWithCode'))
                            : tr.t('owner.test.onlyTarget', { name: target.username }))
                    : null,
                invite ? tr.t('owner.test.realInvite') : null,
            ].filter(Boolean).join('\n').slice(0, 4096))],
        });
    },
};
