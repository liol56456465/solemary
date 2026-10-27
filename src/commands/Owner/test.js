// test.js — /test: preview the DM an enforcement action would send, without doing it.
//
// Nothing is executed: no ban/kick/role change, no case row, no ladder change, no log
// entry. The DM is exactly what the real action sends: the same dmTemplates functions,
// fed a record shaped like a real mod_cases row (a freshly generated case code that is
// not saved, the target's current ladder level), and for kicks and accepted appeals a
// real one-time invite, created the same way. It goes to the person running the
// command, never to the target.

import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { successEmbed } from '../../utils/embeds.js';
import { ErrorTypes, TitanBotError } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { createRejoinInvite, getLadder, isAdministrator, previewWarn, sendDm } from '../../services/enforcement/enforcementService.js';
import { isEnforcementDbAvailable } from '../../services/enforcement/db.js';
import { appealAcceptedDm, appealDeniedDm, banDm, kickDm, muteDm, warnDm } from '../../services/enforcement/dmTemplates.js';
import { addMonths, generateCaseCode, parseDuration } from '../../services/enforcement/format.js';

function userError(message) {
    return new TitanBotError(message, ErrorTypes.USER_INPUT, message, { expected: true });
}

/** A record with the columns dmTemplates reads, as insertCase would return it. */
function fakeRecord({ invoker, target, type, reason, durationMs, unappealable, ladderLevel = 0, extra = {} }) {
    const now = new Date();
    return {
        case_code: generateCaseCode(),
        guild_id: enforcementConfig.mainGuildId,
        target_user_id: target.id,
        target_username: target.username,
        moderator_id: invoker.id,
        moderator_username: invoker.username,
        type,
        reason,
        duration_ms: durationMs ?? null,
        created_at: now,
        expires_at: durationMs ? new Date(now.getTime() + durationMs) : null,
        unappealable: Boolean(unappealable),
        appeal_deadline: null,
        ladder_level_after: ladderLevel,
        is_auto: false,
        ...extra,
    };
}

async function currentLadder(userId) {
    return isEnforcementDbAvailable()
        ? getLadder(enforcementConfig.mainGuildId, userId)
        : { level: 0, warns_since_level: 0 };
}

/** The warn DM, or — when this warn would hit the ladder limit — the automatic ban DM that replaces it. */
async function warnPreview({ invoker, target, reason, ladder }) {
    const step = previewWarn(ladder);
    if (!step.escalates) {
        return { content: warnDm(fakeRecord({ invoker, target, type: 'warn', reason, ladderLevel: ladder.level }), step.warnNumber), note: `warn ${step.warnNumber} of ${step.threshold}` };
    }
    const now = new Date();
    const banRecord = fakeRecord({
        invoker: { id: invoker.client.user.id, username: invoker.client.user.username },
        target,
        type: 'ban',
        reason: enforcementConfig.ladderReason,
        durationMs: step.banDurationMs,
        extra: {
            is_auto: true,
            ladder_level_after: step.nextLevel,
            appeal_deadline: step.nextLevel === 3 ? addMonths(now, enforcementConfig.level3AppealMonths) : null,
        },
    });
    return { content: banDm(banRecord), note: `this warn reaches the limit, so they'd get the automatic ladder-level-${step.nextLevel} ban DM instead` };
}

async function buildPreview({ action, guild, invoker, target, reason, durationMs, unappealable }) {
    const ladder = await currentLadder(target.id);
    const record = (type, extra = {}) => fakeRecord({ invoker, target, type, reason, durationMs, unappealable, ladderLevel: ladder.level, ...extra });
    switch (action) {
        case 'ban':
            return { content: banDm(record('ban')) };
        case 'kick': {
            const kickRecord = record('kick', { durationMs: null, unappealable: false });
            const invite = await createRejoinInvite(guild, `/test preview of kick ${kickRecord.case_code}`);
            return { content: kickDm(kickRecord, invite), invite };
        }
        case 'mute':
            if (!durationMs) throw userError('A mute needs a duration, e.g. `duration:1h`.');
            return { content: muteDm(record('mute', { unappealable: false })) };
        case 'warn':
            return warnPreview({ invoker, target, reason, ladder });
        case 'appeal-accepted': {
            const invite = await createRejoinInvite(guild, '/test preview of an accepted appeal');
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
        .setDescription('Preview the DM an enforcement action would send — sent to you, nothing is executed')
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

        const { content, note, invite } = await buildPreview({
            action,
            guild: interaction.guild,
            invoker: interaction.user,
            target,
            reason: interaction.options.getString('reason')?.trim() || 'No reason given',
            durationMs,
            unappealable: interaction.options.getBoolean('unappealable') ?? false,
        });

        const delivered = await sendDm(interaction.user, content);
        logger.info(`/test preview of ${action} DM for ${target.id} sent to ${interaction.user.id}: ${delivered ? 'delivered' : 'not delivered'}`);
        if (!delivered) {
            throw userError('I could not DM you. Allow direct messages from server members in this server and try again.');
        }

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed('Preview DM sent to you.', [
                `The exact **${action}** DM ${target.username} would get.${note ? ` Note: ${note}.` : ''}`,
                action.startsWith('appeal-')
                    ? 'Nothing was executed.'
                    : 'Nothing was executed. The case code in it was not saved, so it cannot be appealed.',
                invite ? 'The invite in it is a real one-time invite to this server.' : null,
            ].filter(Boolean).join('\n'))],
        });
    },
};
