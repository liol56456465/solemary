// backgroundView.js — /background record views and their pagination buttons.
//
// custom_id: bg:page:<viewerId>:<targetId>:<page> — stateless, so it survives restarts.
// Staff notes (formerly /usernotes) are shown on the list and edited with the
// Add note / Remove note buttons: bg:noteadd|notedel:<viewerId>:<targetId>, whose
// forms submit as bgnote:add|del:<targetId>. Notes stay in the usernotes key.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, LabelBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { db } from '../utils/database/wrapper.js';
import { getUserNotesKey } from '../utils/database/keys.js';
import { createEmbed } from '../utils/embeds.js';
import { createError, ErrorTypes, replyUserError } from '../utils/errorHandler.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { enforcementConfig } from '../config/enforcement.js';
import { isAdministrator } from '../services/enforcement/enforcementService.js';
import { caseStatusLabel, getAppealHistory, getLatestAppealStatuses, listCasesForUser } from '../services/enforcement/caseService.js';
import { dateStamp, formatDuration, stamp, truncate } from '../services/enforcement/format.js';

const PAGE_SIZE = 6;
const NOTES_SHOWN = 5;
const NOTE_TYPE_EMOJI = { warning: '⚠️', positive: '✅', neutral: '📝', alert: '🚨' };

async function loadNotes(guildId, userId) {
    const notes = await db.get(getUserNotesKey(guildId, userId), []);
    return Array.isArray(notes) ? notes : [];
}

function notesField(notes) {
    if (notes.length === 0) return { name: 'Staff notes', value: 'None. Use **Add note** to write one.' };
    const lines = notes.map((note, index) => ({ note, number: index + 1 })).slice(-NOTES_SHOWN).reverse().map(({ note, number }) =>
        truncate(`**${number}.** ${NOTE_TYPE_EMOJI[note.type] ?? '📝'} ${note.content} — ${note.author ?? 'unknown'}, ${note.timestamp ? stamp(note.timestamp) : '?'}`, 200));
    const more = notes.length > NOTES_SHOWN ? `\n…and ${notes.length - NOTES_SHOWN} older` : '';
    return { name: `Staff notes (${notes.length})`, value: truncate(lines.join('\n') + more, 1024) };
}

function userError(message) {
    return createError(message, ErrorTypes.USER_INPUT, message, { expected: true });
}

/** Reads the user / user_id options shared by /enforcements and /background. */
export async function resolveTargetUser(interaction, client) {
    const picked = interaction.options.getUser('user');
    const rawId = interaction.options.getString('user_id')?.trim();

    if (picked && rawId && picked.id !== rawId) {
        throw userError('Use either the user picker or user_id, not both.');
    }
    if (picked) return picked;
    if (!rawId) throw userError('Pick a user or enter a user_id.');
    if (!/^\d{17,20}$/.test(rawId)) throw userError('user_id must be a Discord user ID (17–20 digits).');

    const user = await client.users.fetch(rawId).catch(() => null);
    if (!user) throw userError(`No Discord user with ID \`${rawId}\` exists.`);
    return user;
}

function statusLabel(row, appealStatus = null) {
    return caseStatusLabel(row, appealStatus);
}

function appealability(row) {
    if (row.unappealable) return 'Unappealable';
    if (row.appeal_deadline) return `Appealable until ${dateStamp(row.appeal_deadline)}`;
    return 'Appealable';
}

export async function buildRecordEmbed(row) {
    const appeals = await getAppealHistory(row.case_code);
    const lines = [
        `**Case code:** \`${row.case_code}\``,
        `**Type:** ${row.type}${row.is_auto ? ' (automatic, warn ladder)' : ''}${row.is_imported ? ' (imported, not counted)' : ''}`,
        `**User:** ${row.target_username} (\`${row.target_user_id}\`)`,
        `**By:** ${row.moderator_username} (\`${row.moderator_id}\`)`,
        `**When:** ${stamp(row.created_at)}`,
        `**Reason:** ${row.reason} (${row.prebuilt_or_custom})`,
    ];
    if (row.type === 'ban' || row.type === 'mute') {
        lines.push(row.expires_at
            ? `**Duration:** ${formatDuration(Number(row.duration_ms))} — ends ${stamp(row.expires_at)}`
            : '**Duration:** Permanent');
    }
    lines.push(
        `**Appeal:** ${appealability(row)}`,
        `**Ladder level after:** ${row.ladder_level_after}`,
        `**DM delivered:** ${row.dm_delivered ? 'Yes' : 'No'}`,
        `**Status:** ${statusLabel(row, appeals[0]?.status)}`,
    );
    if (row.status === 'revoked') {
        lines.push(`**Revoked:** ${row.revoked_at ? dateStamp(row.revoked_at) : '—'}${row.revoked_by ? ` by \`${row.revoked_by}\`` : ''}${row.revoke_reason ? ` — ${row.revoke_reason}` : ''}`);
    }

    const history = appeals.length
        ? appeals.map((appeal) => `${dateStamp(appeal.created_at)} — **${appeal.status}**${appeal.decided_by_username ? ` by ${appeal.decided_by_username}` : ''}${appeal.note ? `: ${appeal.note}` : ''}`).join('\n')
        : 'None';

    return createEmbed({
        title: truncate(row.name, 256),
        description: truncate(lines.join('\n'), 4096),
        fields: [{ name: 'Appeal history', value: truncate(history, 1024) }],
        color: row.status === 'active' ? 'warning' : 'secondary',
    });
}

export async function buildRecordList(guildId, viewerId, targetUser, page) {
    const [{ rows, total }, appealStatuses, notes] = await Promise.all([
        listCasesForUser(guildId, targetUser.id, { limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
        getLatestAppealStatuses(targetUser.id),
        loadNotes(guildId, targetUser.id),
    ]);
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    const fields = rows.map((row) => ({
        name: truncate(`${row.name} · ${row.type}${row.is_test ? ' (test)' : ''} · ${statusLabel(row, appealStatuses.get(row.case_code))}`, 256),
        value: truncate([
            `\`${row.case_code}\` · ${dateStamp(row.created_at)}${row.is_imported ? ' · imported' : ''}`,
            `Reason: ${row.reason}`,
            row.expires_at ? `Ends ${stamp(row.expires_at)}` : null,
        ].filter(Boolean).join('\n'), 1024),
    }));

    const embed = createEmbed({
        title: truncate(`Background — ${targetUser.username}`, 256),
        description: total
            ? `${total} record(s), newest first. Use \`name:\` to open one in full.`
            : 'No records for this user.',
        fields: [...fields, notesField(notes)],
        footer: { text: `Page ${Math.min(page + 1, pages)} of ${pages}` },
        color: 'primary',
    });

    const noteRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`bg:noteadd:${viewerId}:${targetUser.id}`).setLabel('Add note').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`bg:notedel:${viewerId}:${targetUser.id}`).setLabel('Remove note').setStyle(ButtonStyle.Secondary)
            .setDisabled(notes.length === 0),
    );
    const components = pages > 1 ? [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`bg:page:${viewerId}:${targetUser.id}:${page - 1}`)
            .setLabel('Newer')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page <= 0),
        new ButtonBuilder()
            .setCustomId(`bg:page:${viewerId}:${targetUser.id}:${page + 1}`)
            .setLabel('Older')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page + 1 >= pages),
    )] : [];
    components.push(noteRow);

    return { embeds: [embed], components };
}

function noteModal(step, targetId) {
    const input = step === 'add'
        ? new TextInputBuilder().setCustomId('note').setStyle(TextInputStyle.Paragraph).setMaxLength(1000).setRequired(true)
        : new TextInputBuilder().setCustomId('number').setStyle(TextInputStyle.Short).setMaxLength(4).setRequired(true).setPlaceholder('e.g. 3');
    return new ModalBuilder()
        .setCustomId(`bgnote:${step}:${targetId}`)
        .setTitle(step === 'add' ? 'Add a staff note' : 'Remove a staff note')
        .addLabelComponents(new LabelBuilder()
            .setLabel(step === 'add' ? 'Note (only staff can see it)' : 'Number of the note to remove')
            .setTextInputComponent(input));
}

function staffOnly(interaction) {
    return isAdministrator(interaction.member) && interaction.guildId === enforcementConfig.mainGuildId;
}

export async function handleBackgroundButton(interaction, client, args) {
    const [step, viewerId, targetId, rawPage] = args;
    if (!['page', 'noteadd', 'notedel'].includes(step)) return;

    if (interaction.user.id !== viewerId || !staffOnly(interaction)) {
        return replyUserError(interaction, {
            type: ErrorTypes.PERMISSION,
            message: 'Run /background yourself to browse records.',
        });
    }
    if (step === 'noteadd') return InteractionHelper.safeShowModal(interaction, noteModal('add', targetId));
    if (step === 'notedel') return InteractionHelper.safeShowModal(interaction, noteModal('del', targetId));

    await interaction.deferUpdate();
    const targetUser = await client.users.fetch(targetId);
    const page = Math.max(0, Number.parseInt(rawPage, 10) || 0);
    await InteractionHelper.safeEditReply(interaction, await buildRecordList(interaction.guildId, viewerId, targetUser, page));
}

/** Saves a staff note added or removed from the /background view, then refreshes the view. */
export async function handleBackgroundNoteModal(interaction, client, args) {
    const [step, targetId] = args;
    if (!staffOnly(interaction) || !/^\d{17,20}$/.test(targetId ?? '')) {
        return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'Only administrators can edit staff notes.' });
    }
    const key = getUserNotesKey(interaction.guildId, targetId);

    if (step === 'add') {
        const content = interaction.fields.getTextInputValue('note').trim();
        if (!content) return replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'The note is empty.' });
        await db.update(key, (notes) => [...(Array.isArray(notes) ? notes : []), {
            id: Date.now(),
            content,
            type: 'neutral',
            author: interaction.user.tag,
            authorId: interaction.user.id,
            timestamp: new Date().toISOString(),
        }], []);
    } else if (step === 'del') {
        const number = Number.parseInt(interaction.fields.getTextInputValue('number'), 10);
        let removed = false;
        await db.update(key, (notes) => {
            const list = Array.isArray(notes) ? [...notes] : [];
            if (Number.isInteger(number) && number >= 1 && number <= list.length) {
                list.splice(number - 1, 1);
                removed = true;
            }
            return list;
        }, []);
        if (!removed) return replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: `There is no note number ${interaction.fields.getTextInputValue('number')}.` });
    } else {
        return;
    }

    const targetUser = await client.users.fetch(targetId);
    const view = await buildRecordList(interaction.guildId, interaction.user.id, targetUser, 0);
    // The form was opened from the /background message: update it in place.
    if (interaction.isFromMessage?.()) return interaction.update(view);
    return InteractionHelper.safeReply(interaction, { ...view, flags: MessageFlags.Ephemeral });
}
