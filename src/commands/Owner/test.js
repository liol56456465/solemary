// test.js — /test: send the DM an enforcement action would send, without doing it.
//
// Nothing is executed: no ban/kick/role change, no ladder change, no log entry. The
// case IS saved, marked is_test, with a real case code, so the whole flow can be
// tested: appeal it with that code, see it in /appeals, accept or deny it. The bot
// never acts on test cases (no unban, role, ladder or banned-role changes; expiry
// only closes the record). The DM comes from the same dmTemplates functions as the
// real action, and kicks and accepted appeals get a real one-time invite. It goes to
// the person running the command, never to the target.

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

function userError(message) {
    return new TitanBotError(message, ErrorTypes.USER_INPUT, message, { expected: true });
}

/** Saves a test case shaped like the real action's, and returns the mod_cases row. */
function saveTestCase({ moderator, target, type, reason, durationMs = null, unappealable = false, ladderLevel = 0, extra = {} }) {
    const now = new Date();
    return insertCase(null, {
        guildId: enforcementConfig.mainGuildId,
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
async function warnPreview({ invoker, target, reason, ladder }) {
    const step = previewWarn(ladder);
    const warn = await saveTestCase({
        moderator: invoker, target, type: 'warn', reason, ladderLevel: step.nextLevel, extra: prebuiltReasonFields(reason),
    });
    if (!step.escalates) {
        return { content: warnDm(warn, step.warnNumber), record: warn, note: `warn ${step.warnNumber} of ${step.threshold}` };
    }
    const ban = await saveTestCase({
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
        content: banDm(ban),
        record: ban,
        note: `this warn reaches the limit, so they'd get the automatic ladder-level-${step.nextLevel} ban DM instead (warn \`${warn.case_code}\` was saved too)`,
    };
}

async function buildPreview({ action, guild, invoker, target, reason, durationMs, unappealable }) {
    if (!action.startsWith('appeal-') && !isEnforcementDbAvailable()) {
        throw userError('The database is unavailable, so no test case can be saved. Try again later.');
    }
    const ladder = isEnforcementDbAvailable()
        ? await getLadder(enforcementConfig.mainGuildId, target.id)
        : { level: 0, warns_since_level: 0 };
    const save = (type, options = {}) => saveTestCase({
        moderator: invoker, target, type, reason, ladderLevel: ladder.level, ...options, extra: { ...prebuiltReasonFields(reason), ...options.extra },
    });

    switch (action) {
        case 'ban': {
            const record = await save('ban', { durationMs, unappealable });
            return { content: banDm(record), record };
        }
        case 'kick': {
            const record = await save('kick');
            const invite = await createRejoinInvite(guild, `Rejoin invite for kick ${record.case_code} (/test)`);
            return { content: kickDm(record, invite), record, invite };
        }
        case 'mute': {
            if (!durationMs) throw userError('A mute needs a duration, e.g. `duration:1h`.');
            const record = await save('mute', { durationMs });
            return { content: muteDm(record), record };
        }
        case 'warn':
            return warnPreview({ invoker, target, reason, ladder });
        case 'appeal-accepted': {
            const invite = await createRejoinInvite(guild, 'Appeal accepted (/test)');
            return { content: appealAcceptedDm(invoker.username, invite), invite };
        }
        case 'appeal-denied':
            return { content: appealDeniedDm() };
        default:
            throw userError(`Unknown action: ${action}`);
    }
}

export default {
    // Registered as a guild command in MAIN_GUILD_ID only.
    scope: 'main',
    data: new SlashCommandBuilder()
        .setName('test')
        .setDescription('Send yourself the DM an action would send and save a test case. Nothing is executed')
        .addStringOption((option) => option
            .setName('action')
            .setDescription('Which DM to preview')
            .setRequired(true)
            .addChoices(
                { name: 'ban', value: 'ban' },
                { name: 'kick', value: 'kick' },
                { name: 'mute', value: 'mute' },
                { name: 'warn', value: 'warn' },
                { name: 'appeal accepted', value: 'appeal-accepted' },
                { name: 'appeal denied', value: 'appeal-denied' },
            ))
        .addUserOption((option) => option
            .setName('user')
            .setDescription('Who the DM would be for (they receive nothing)')
            .setRequired(true))
        .addStringOption((option) => option
            .setName('reason')
            .setDescription('Reason shown in the DM')
            .setMaxLength(500))
        .addStringOption((option) => option
            .setName('duration')
            .setDescription('Ban/mute length, e.g. 30m, 12h, 7d, 1mo (ban: empty = permanent)')
            .setMaxLength(20))
        .addBooleanOption((option) => option
            .setName('unappealable')
            .setDescription('Ban only: preview an unappealable ban')),

    async execute(interaction) {
        if (interaction.guildId !== enforcementConfig.mainGuildId) {
            throw new TitanBotError('Wrong guild for /test', ErrorTypes.PERMISSION,
                'This command only works in the main server.', { expected: true });
        }
        if (!isAdministrator(interaction.member)) {
            throw new TitanBotError('Not an administrator', ErrorTypes.PERMISSION,
                'You need the Administrator permission to use /test.', { expected: true });
        }

        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;

        const action = interaction.options.getString('action');
        const target = interaction.options.getUser('user');
        const rawDuration = interaction.options.getString('duration')?.trim() || '';
        const durationMs = rawDuration ? parseDuration(rawDuration) : null;
        if (rawDuration && durationMs == null) {
            throw userError('That duration is not valid. Use e.g. `30m`, `12h`, `7d`, `2w` or `1mo` (at least 1 minute).');
        }

        const { content, note, invite, record } = await buildPreview({
            action,
            guild: interaction.guild,
            invoker: interaction.user,
            target,
            reason: interaction.options.getString('reason')?.trim() || 'No reason given',
            durationMs,
            unappealable: interaction.options.getBoolean('unappealable') ?? false,
        });

        const delivered = await sendDm(interaction.user, content);
        if (record) await setDmDelivered(record.id, delivered);
        logger.info(`/test preview of ${action} DM for ${target.id} sent to ${interaction.user.id}: ${delivered ? 'delivered' : 'not delivered'}`);
        if (!delivered) {
            throw userError('I could not DM you. Allow direct messages from server members in this server and try again.');
        }

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed('Preview DM sent to you.', [
                `The exact **${action}** DM ${target.username} would get.${note ? ` Note: ${note}.` : ''}`,
                'Nothing was executed.',
                record
                    ? `Test case \`${record.case_code}\` was saved, so it can be appealed and decided with /appeals like a real one. `
                        + (target.id === interaction.user.id
                            ? 'Appeal it from the support server with that code.'
                            : `Only ${target.username} can appeal it; run /test on yourself to try the appeal flow.`)
                    : null,
                invite ? 'The invite in it is a real one-time invite to this server.' : null,
            ].filter(Boolean).join('\n'))],
        });
    },
};
