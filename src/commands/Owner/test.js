// test.js — /test: preview the DM an enforcement action would send, without doing it.
//
// Nothing is executed: no ban/kick/role change, no case row, no ladder change, no log
// entry. The DM text comes from the same dmTemplates functions the real actions use
// (fed a record shaped like a real mod_cases row, with case code TEST1), and is sent
// to the person running the command, never to the target.

import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { successEmbed } from '../../utils/embeds.js';
import { ErrorTypes, TitanBotError } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { getLadder, isAdministrator, previewWarn, sendDm } from '../../services/enforcement/enforcementService.js';
import { isEnforcementDbAvailable } from '../../services/enforcement/db.js';
import { appealAcceptedDm, appealDeniedDm, banDm, kickDm, muteDm, warnDm } from '../../services/enforcement/dmTemplates.js';
import { addMonths, parseDuration } from '../../services/enforcement/format.js';

const TEST_CASE_CODE = 'TEST1';
const SIMULATION_FOOTER = '-# Simulation — no action taken.';
// Kick and accepted-appeal DMs contain a one-time invite; creating one would be an action.
const PLACEHOLDER_INVITE = 'https://discord.gg/xxxxxxx (a one-time invite is created for the real action)';

function userError(message) {
    return new TitanBotError(message, ErrorTypes.USER_INPUT, message, { expected: true });
}

/** A record with the columns dmTemplates reads, as insertCase would return it. */
function fakeRecord({ invoker, target, type, reason, durationMs, unappealable, extra = {} }) {
    const now = new Date();
    return {
        case_code: TEST_CASE_CODE,
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
        ladder_level_after: 0,
        is_auto: false,
        ...extra,
    };
}

/** The warn DM, or — when this warn would hit the ladder limit — the automatic ban DM that replaces it. */
async function warnPreview({ invoker, target, reason }) {
    const ladder = isEnforcementDbAvailable()
        ? await getLadder(enforcementConfig.mainGuildId, target.id)
        : { level: 0, warns_since_level: 0 };
    const step = previewWarn(ladder);
    if (!step.escalates) {
        return { content: warnDm(fakeRecord({ invoker, target, type: 'warn', reason }), step.warnNumber), note: `warn ${step.warnNumber} of ${step.threshold}` };
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

async function buildPreview({ action, invoker, target, reason, durationMs, unappealable }) {
    switch (action) {
        case 'ban':
            return { content: banDm(fakeRecord({ invoker, target, type: 'ban', reason, durationMs, unappealable })) };
        case 'kick':
            return { content: kickDm(fakeRecord({ invoker, target, type: 'kick', reason }), PLACEHOLDER_INVITE) };
        case 'mute':
            if (!durationMs) throw userError('A mute needs a duration, e.g. `duration:1h`.');
            return { content: muteDm(fakeRecord({ invoker, target, type: 'mute', reason, durationMs })) };
        case 'warn':
            return warnPreview({ invoker, target, reason });
        case 'appeal-accepted':
            return { content: appealAcceptedDm(invoker.username, PLACEHOLDER_INVITE) };
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

        const { content, note } = await buildPreview({
            action,
            invoker: interaction.user,
            target,
            reason: interaction.options.getString('reason')?.trim() || 'No reason given',
            durationMs,
            unappealable: interaction.options.getBoolean('unappealable') ?? false,
        });

        const delivered = await sendDm(interaction.user, `${content}\n\n${SIMULATION_FOOTER}`);
        logger.info(`/test preview of ${action} DM for ${target.id} sent to ${interaction.user.id}: ${delivered ? 'delivered' : 'not delivered'}`);
        if (!delivered) {
            throw userError('I could not DM you. Allow direct messages from server members in this server and try again.');
        }

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed('Preview DM sent to you.', `The **${action}** DM ${target.username} would get.${note ? ` Note: ${note}.` : ''} Nothing was executed.`)],
        });
    },
};
