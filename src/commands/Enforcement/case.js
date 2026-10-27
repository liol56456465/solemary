import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { ErrorTypes, TitanBotError } from '../../utils/errorHandler.js';
import { createEmbed, successEmbed } from '../../utils/embeds.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { isAdministrator } from '../../services/enforcement/enforcementService.js';
import { getCaseByCode } from '../../services/enforcement/caseService.js';
import { isEnforcementDbAvailable } from '../../services/enforcement/db.js';
import {
    describeDuration, editCase, getCaseEdits, searchCases, voidCase,
} from '../../services/enforcement/caseEditService.js';
import { dateStamp, normalizeCaseCode, parseDuration, stamp, truncate } from '../../services/enforcement/format.js';
import {
    addEvidence, addImageEvidence, captureLinks, evidenceDisplay, evidenceLines, fitLines, listEvidence, NOTE_MAX,
    parseEvidenceUrls, removeEvidence, resolveImageUrls,
} from '../../services/enforcement/evidenceService.js';

function userError(message) {
    return new TitanBotError(message, ErrorTypes.USER_INPUT, message, { expected: true });
}

function readCode(interaction) {
    const raw = interaction.options.getString('code', true);
    const code = normalizeCaseCode(raw);
    if (!code) throw userError(`\`${truncate(raw, 20)}\` is not a case code (5–7 letters and digits).`);
    return code;
}

/** "permanent" → null; otherwise a parsed duration; undefined when the option is absent. */
function readDuration(interaction) {
    const raw = interaction.options.getString('duration')?.trim();
    if (!raw) return undefined;
    if (/^(perm|permanent|forever)$/i.test(raw)) return null;
    const ms = parseDuration(raw);
    if (ms == null) throw userError('Duration must look like 30m, 24h, 7d, 2w, 1mo (or "permanent" for a ban).');
    return ms;
}

function codeOption(option) {
    return option.setName('code').setDescription('Case code').setRequired(true)
        .setAutocomplete(true).setMinLength(5).setMaxLength(7);
}

async function loadCaseInGuild(interaction, code) {
    const record = await getCaseByCode(code);
    if (!record || record.guild_id !== interaction.guildId) throw userError(`No case with code \`${code}\` in this server.`);
    return record;
}

/** /case evidence add | list | remove */
async function handleEvidence(interaction, client, sub, code) {
    const record = await loadCaseInGuild(interaction, code);
    const addedBy = { id: interaction.user.id, username: interaction.user.username };

    if (sub === 'add') {
        const link = interaction.options.getString('link')?.trim() || '';
        const image = interaction.options.getAttachment('image');
        const note = interaction.options.getString('note')?.trim() || null;
        if (!link && !image) throw userError('Give a `link`, an `image`, or both.');

        let linkEntry = null;
        if (link) {
            const entries = parseEvidenceUrls(link);
            if (entries.length !== 1) throw userError('`link` must be one http(s) link, e.g. a Discord message link.');
            [linkEntry] = await captureLinks(interaction.guild, entries);
        }

        const added = [];
        if (linkEntry) {
            added.push(await addEvidence(code, {
                kind: 'link', url: linkEntry.url, sourceMessageUrl: linkEntry.sourceMessageUrl, excerpt: linkEntry.excerpt, note, addedBy,
            }));
        }
        if (image) {
            added.push(await addImageEvidence(client, code, image, { note, addedBy }));
        }

        const fresh = await resolveImageUrls(client, added);
        const lines = evidenceLines(added, fresh, { excerptMax: 300 });
        if (linkEntry?.sourceMessageUrl && !linkEntry.excerpt) {
            lines.push('-# The message could not be read (other server, no access, or deleted), so only the link is saved.');
        }
        return InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed(`Evidence added to \`${record.case_code}\``, truncate(lines.join('\n'), 4000))],
        });
    }

    if (sub === 'list') {
        const rows = await listEvidence(code);
        const fresh = await resolveImageUrls(client, rows);
        const firstImage = rows.find((row) => fresh.has(String(row.id)));
        return InteractionHelper.safeEditReply(interaction, {
            embeds: [createEmbed({
                title: truncate(`Evidence — ${record.case_code} (${record.name})`, 256),
                description: rows.length
                    ? fitLines(evidenceLines(rows, fresh, { excerptMax: 300 }), 4096)
                    : 'No evidence yet. Add some with `/case evidence add`.',
                image: firstImage ? fresh.get(String(firstImage.id)) : null,
                footer: { text: `${record.type} on ${record.target_username} by ${record.moderator_username}` },
                color: 'primary',
            })],
        });
    }

    if (sub === 'remove') {
        const id = interaction.options.getInteger('id', true);
        const removed = await removeEvidence(code, id);
        if (!removed) throw userError(`Case \`${code}\` has no evidence #${id}. See \`/case evidence list\`.`);
        const what = removed.kind === 'image' ? 'Image (its copy in the evidence channel is kept).' : removed.url;
        return InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed(`Evidence #${id} removed from \`${record.case_code}\``, truncate(what, 4000))],
        });
    }
}

export default {
    // Registered as a guild command in MAIN_GUILD_ID only. Admin-only (not in commandAccess).
    scope: 'main',
    data: new SlashCommandBuilder()
        .setName('case')
        .setDescription('Edit, void, add evidence to or show the history of an enforcement case')
        .addSubcommand((sub) => sub.setName('edit').setDescription("Change a case's reason or duration (history is kept)")
            .addStringOption(codeOption)
            .addStringOption((option) => option.setName('reason').setDescription('New reason').setMaxLength(500))
            .addStringOption((option) => option.setName('duration')
                .setDescription('New total duration from when it was given, e.g. 7d, 1mo, permanent (open bans/mutes only)')
                .setMaxLength(20)))
        .addSubcommand((sub) => sub.setName('void').setDescription('Mark a case as a mistake: lift it and stop it counting')
            .addStringOption(codeOption)
            .addStringOption((option) => option.setName('reason').setDescription('Why it is voided (shown to the user)')
                .setRequired(true).setMaxLength(500)))
        .addSubcommand((sub) => sub.setName('history').setDescription("Show a case's edit history and evidence")
            .addStringOption(codeOption))
        .addSubcommandGroup((group) => group.setName('evidence').setDescription('Evidence attached to a case')
            .addSubcommand((sub) => sub.setName('add').setDescription('Attach a message link and/or an image to a case')
                .addStringOption(codeOption)
                .addStringOption((option) => option.setName('link').setDescription('A link, e.g. a Discord message link (its text is saved)')
                    .setMaxLength(500))
                .addAttachmentOption((option) => option.setName('image').setDescription('A screenshot; re-hosted in the evidence channel'))
                .addStringOption((option) => option.setName('note').setDescription('Short note about this evidence')
                    .setMaxLength(NOTE_MAX)))
            .addSubcommand((sub) => sub.setName('list').setDescription("List a case's evidence")
                .addStringOption(codeOption))
            .addSubcommand((sub) => sub.setName('remove').setDescription('Remove one piece of evidence from a case')
                .addStringOption(codeOption)
                .addIntegerOption((option) => option.setName('id').setDescription('Evidence number (#) from /case evidence list')
                    .setRequired(true).setMinValue(1)))),

    async execute(interaction, config, client) {
        if (interaction.guildId !== enforcementConfig.mainGuildId) {
            throw new TitanBotError('Wrong guild for /case', ErrorTypes.PERMISSION, 'This command only works in the main server.', { expected: true });
        }
        if (!isAdministrator(interaction.member)) {
            throw new TitanBotError('Not an administrator', ErrorTypes.PERMISSION, 'You need the Administrator permission to change cases.', { expected: true });
        }
        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;

        const group = interaction.options.getSubcommandGroup(false);
        const sub = interaction.options.getSubcommand();
        const code = readCode(interaction);
        const admin = interaction.user;

        if (group === 'evidence') {
            return handleEvidence(interaction, client, sub, code);
        }

        if (sub === 'edit') {
            const reasonRaw = interaction.options.getString('reason');
            const reason = reasonRaw == null ? undefined : reasonRaw.trim();
            if (reason === '') throw userError('The reason cannot be empty.');
            const durationMs = readDuration(interaction);
            if (reason === undefined && durationMs === undefined) throw userError('Give a new `reason`, a new `duration`, or both.');

            const { after, changes } = await editCase(client, {
                guildId: interaction.guildId, caseCode: code, editor: { id: admin.id, username: admin.username }, reason, durationMs,
            });
            const lines = changes.map((change) => (change.field === 'reason'
                ? `**Reason:** ${truncate(change.oldValue, 300)} → ${truncate(change.newValue, 300)}`
                : `**Duration:** ${describeDuration(change.oldValue)} → ${describeDuration(change.newValue)}`));
            if (changes.some((change) => change.field === 'duration')) {
                if (!after.expires_at) lines.push('It is now permanent.');
                else if (new Date(after.expires_at) <= new Date()) lines.push('The new end is already past: it will be lifted within a minute.');
                else lines.push(`Now ends ${stamp(after.expires_at)}.`);
            }
            return InteractionHelper.safeEditReply(interaction, {
                embeds: [successEmbed(`Case \`${after.case_code}\` edited`, truncate(lines.join('\n'), 4000))],
            });
        }

        if (sub === 'void') {
            const reason = interaction.options.getString('reason', true).trim();
            if (!reason) throw userError('The reason cannot be empty.');
            const { record, notes, dmDelivered } = await voidCase(client, {
                guildId: interaction.guildId, caseCode: code, admin, reason,
            });
            return InteractionHelper.safeEditReply(interaction, {
                embeds: [successEmbed(`Case \`${record.case_code}\` voided`, truncate([
                    `${record.type} on **${record.target_username}** no longer counts.`,
                    ...notes,
                    `DM to user: ${dmDelivered ? 'delivered' : 'not delivered'}.`,
                ].join('\n'), 4000))],
            });
        }

        if (sub === 'history') {
            const record = await getCaseByCode(code);
            if (!record || record.guild_id !== interaction.guildId) throw userError(`No case with code \`${code}\` in this server.`);
            const edits = await getCaseEdits(code);
            const lines = edits.map((edit) => {
                const what = edit.field === 'duration'
                    ? `duration ${describeDuration(edit.old_value)} → ${describeDuration(edit.new_value)}`
                    : `reason "${truncate(edit.old_value, 150)}" → "${truncate(edit.new_value, 150)}"`;
                return `${dateStamp(edit.edited_at)} · **${edit.edited_by_username}**: ${what}`;
            });
            if (record.voided_at) {
                lines.unshift(`**Voided** ${dateStamp(record.voided_at)} by \`${record.voided_by}\`: ${truncate(record.void_reason || '', 300)}`);
            }
            const evidence = await evidenceDisplay(client, code);
            return InteractionHelper.safeEditReply(interaction, {
                embeds: [createEmbed({
                    title: truncate(`Case history — ${record.case_code} (${record.name})`, 256),
                    description: truncate(lines.join('\n') || 'This case was never edited.', 4096),
                    fields: evidence.field ? [evidence.field] : [],
                    image: evidence.imageUrl,
                    footer: { text: `${record.type} on ${record.target_username} by ${record.moderator_username}` },
                    color: 'primary',
                })],
            });
        }
    },

    async autocomplete(interaction) {
        if (interaction.guildId !== enforcementConfig.mainGuildId || !isAdministrator(interaction.member)
            || !isEnforcementDbAvailable()) {
            return interaction.respond([]);
        }
        const focused = interaction.options.getFocused(true);
        if (focused.name !== 'code') return interaction.respond([]);
        const rows = await searchCases(interaction.guildId, focused.value);
        await interaction.respond(rows.map((row) => ({
            name: truncate(`${row.case_code} — ${row.name} (${row.type}, ${row.target_username})${row.voided_at ? ' · voided' : ''}`, 100),
            value: row.case_code,
        })));
    },
};
