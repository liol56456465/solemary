// backgroundView.js — /background record views and their pagination buttons.
//
// custom_id: bg:page:<viewerId>:<targetId>:<page> — stateless, so it survives restarts.
// Staff notes (formerly /usernotes) are shown on the list and edited with the
// Add note / Remove note buttons: bg:noteadd|notedel:<viewerId>:<targetId>, whose
// forms submit as bgnote:add|del:<targetId>. Notes stay in the usernotes key.
//
// Language: these views are ephemeral answers to the administrator who opened them, so they are
// in that person's Discord language (utils/botText.js 'reply'); builders take { lang }, default English.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, LabelBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { addNote, listNotes, removeNote } from '../services/enforcement/staffNotesService.js';
import { createEmbed } from '../utils/embeds.js';
import { createError, ErrorTypes, replyUserError } from '../utils/errorHandler.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { botText, textForInteraction } from '../utils/botText.js';
import { isAdministrator } from '../services/enforcement/enforcementService.js';
import { caseStatusLabel, getAppealHistory, getLatestAppealStatuses, listCasesForUser } from '../services/enforcement/caseService.js';
import { countCaseEdits } from '../services/enforcement/caseEditService.js';
import { evidenceDisplay } from '../services/enforcement/evidenceService.js';
import { durationIn } from '../services/enforcement/dmTemplates.js';
import { dateStamp, formatDuration, LADDER_STAGE_BANS, ladderStageShort, stamp, truncate } from '../services/enforcement/format.js';
import { getActiveOrdersFor, noContactLines } from '../services/enforcement/noContactService.js';
import { getActiveWatchChecked, watchlistLine } from '../services/enforcement/watchlistService.js';

const PAGE_SIZE = 6;
const NOTES_SHOWN = 5;

// ── Shared words (also used by /case and /case search) ─────────────────────

const TYPE_TEXT = Object.freeze({
    ban: (tr) => tr.t('staff.case.type.ban'),
    kick: (tr) => tr.t('staff.case.type.kick'),
    mute: (tr) => tr.t('staff.case.type.mute'),
    warn: (tr) => tr.t('staff.case.type.warn'),
});
/** A case type (ban, kick, mute, warn) in the reader's language; anything else as stored. */
export function caseTypeText(type, tr = botText('en')) {
    return Object.hasOwn(TYPE_TEXT, type) ? TYPE_TEXT[type](tr) : type;
}

/** "1 of 3 (7-day ban)" (format.js ladderStageShort) in the reader's language. */
export function ladderStageText(level, tr = botText('en')) {
    if (tr.lang === 'en') return ladderStageShort(level);
    const n = Math.max(0, Math.min(3, Number(level) || 0));
    if (n === 0) return tr.t('staff.background.stage.none');
    const ms = LADDER_STAGE_BANS[n];
    return ms == null
        ? tr.t('staff.background.stage.permanent', { n })
        : tr.t('staff.background.stage.days', { n, days: Math.round(ms / (24 * 60 * 60 * 1000)) });
}

/** A stored duration in ms (null = permanent) in the reader's language; English as format.js. */
export function durationText(ms, tr = botText('en')) {
    return tr.lang === 'en' ? formatDuration(ms) : durationIn(ms, tr.lang);
}

const NOTE_TYPE_TEXT = Object.freeze({
    warning: (tr) => tr.t('staff.background.noteType.warning'),
    positive: (tr) => tr.t('staff.background.noteType.positive'),
    neutral: (tr) => tr.t('staff.background.noteType.neutral'),
    alert: (tr) => tr.t('staff.background.noteType.alert'),
});
const REASON_KIND_TEXT = Object.freeze({
    prebuilt: (tr) => tr.t('staff.background.reasonKind.prebuilt'),
    custom: (tr) => tr.t('staff.background.reasonKind.custom'),
});
const APPEAL_STATUS_TEXT = Object.freeze({
    pending: (tr) => tr.t('staff.background.appealStatus.pending'),
    accepted: (tr) => tr.t('staff.background.appealStatus.accepted'),
    denied: (tr) => tr.t('staff.background.appealStatus.denied'),
});
const wordOf = (map, value, tr) => (Object.hasOwn(map, value) ? map[value](tr) : value);

const loadNotes = listNotes;

function notesField(notes, tr) {
    if (notes.length === 0) return { name: tr.t('staff.background.notes.title'), value: tr.t('staff.background.notes.none') };
    const lines = notes.map((note, index) => ({ note, number: index + 1 })).slice(-NOTES_SHOWN).reverse().map(({ note, number }) =>
        truncate(tr.t('staff.background.notes.line', {
            number,
            type: Object.hasOwn(NOTE_TYPE_TEXT, note.type) ? NOTE_TYPE_TEXT[note.type](tr) : tr.t('staff.background.noteType.neutral'),
            content: note.content,
            author: note.author ?? tr.t('staff.background.notes.unknownAuthor'),
            when: note.timestamp ? stamp(note.timestamp) : '?',
        }), 200));
    const more = notes.length > NOTES_SHOWN ? `\n${tr.tp('staff.background.notes.older', notes.length - NOTES_SHOWN)}` : '';
    return { name: tr.tp('staff.background.notes.titleCount', notes.length), value: truncate(lines.join('\n') + more, 1024) };
}

function userError(message) {
    return createError(message, ErrorTypes.USER_INPUT, message, { expected: true });
}

/** Reads the user / user_id options shared by /enforcements and /background. */
export async function resolveTargetUser(interaction, client) {
    const tr = textForInteraction(interaction);
    const picked = interaction.options.getUser('user');
    const rawId = interaction.options.getString('user_id')?.trim();

    if (picked && rawId && picked.id !== rawId) {
        throw userError(tr.t('staff.background.target.both'));
    }
    if (picked) return picked;
    if (!rawId) throw userError(tr.t('staff.background.target.none'));
    if (!/^\d{17,20}$/.test(rawId)) throw userError(tr.t('staff.background.target.badId'));

    const user = await client.users.fetch(rawId).catch(() => null);
    if (!user) throw userError(tr.t('staff.background.target.unknown', { id: rawId }));
    return user;
}

function statusLabel(row, appealStatus, tr) {
    return caseStatusLabel(row, appealStatus, { lang: tr.lang });
}

function appealability(row, tr) {
    if (row.unappealable) return tr.t('staff.background.record.no');
    if (row.appeal_deadline) return tr.t('staff.background.record.yesUntil', { date: dateStamp(row.appeal_deadline) });
    return tr.t('staff.background.record.yes');
}

/** `client` is used to re-fetch evidence images (their CDN URLs expire); optional. */
export async function buildRecordEmbed(row, { client = null, lang = 'en' } = {}) {
    const tr = botText(lang);
    const [appeals, edits, evidence] = await Promise.all([
        getAppealHistory(row.case_code),
        countCaseEdits(row.case_code),
        evidenceDisplay(client, row.case_code, { lang: tr.lang }),
    ]);
    const yesNo = (value) => (value ? tr.t('staff.background.record.yes') : tr.t('staff.background.record.no'));
    const lines = [
        tr.t('staff.background.record.code', { code: row.case_code }),
        tr.t('staff.background.record.type', {
            type: caseTypeText(row.type, tr),
            auto: row.is_auto ? tr.t('staff.background.record.auto') : '',
            imported: row.is_imported ? tr.t('staff.background.record.imported') : '',
        }),
        tr.t('staff.background.record.user', { name: row.target_username, id: row.target_user_id }),
        tr.t('staff.background.record.by', { name: row.moderator_username, id: row.moderator_id }),
        tr.t('staff.background.record.when', { date: stamp(row.created_at) }),
        tr.t('staff.background.record.reason', { reason: row.reason, kind: wordOf(REASON_KIND_TEXT, row.prebuilt_or_custom, tr) }),
    ];
    if (row.type === 'ban' || row.type === 'mute') {
        lines.push(row.expires_at
            ? tr.t('staff.background.record.duration', { duration: durationText(Number(row.duration_ms), tr), end: stamp(row.expires_at) })
            : tr.t('staff.background.record.durationPermanent'));
    }
    lines.push(
        tr.t('staff.background.record.canAppeal', { answer: appealability(row, tr) }),
        tr.t('staff.background.record.stageAfter', { stage: ladderStageText(row.ladder_level_after, tr) }),
        tr.t('staff.background.record.dmDelivered', { answer: yesNo(row.dm_delivered) }),
        ...(row.end_dm_delivered == null ? [] : [tr.t('staff.background.record.endDmDelivered', { answer: yesNo(row.end_dm_delivered) })]),
        ...(edits ? [tr.tp('staff.background.record.edited', edits, { code: row.case_code })] : []),
        tr.t('staff.background.record.status', { status: statusLabel(row, appeals[0]?.status, tr) }),
    );
    if (row.voided_at) {
        lines.push(tr.t('staff.background.record.removed', {
            date: dateStamp(row.voided_at),
            by: row.voided_by ? tr.t('staff.background.record.byId', { id: row.voided_by }) : '',
            reason: row.void_reason ? `, ${row.void_reason}` : '',
        }));
    } else if (row.status === 'revoked') {
        lines.push(tr.t('staff.background.record.liftedEarly', {
            date: row.revoked_at ? dateStamp(row.revoked_at) : '-',
            by: row.revoked_by ? tr.t('staff.background.record.byId', { id: row.revoked_by }) : '',
            reason: row.revoke_reason ? `, ${row.revoke_reason}` : '',
        }));
    }

    const history = appeals.length
        ? appeals.map((appeal) => tr.t('staff.background.record.appealLine', {
            date: dateStamp(appeal.created_at),
            status: wordOf(APPEAL_STATUS_TEXT, appeal.status, tr),
            by: appeal.decided_by_username ? tr.t('staff.background.record.byName', { name: appeal.decided_by_username }) : '',
            note: appeal.note ? `: ${appeal.note}` : '',
        })).join('\n')
        : tr.t('staff.background.record.noAppeals');

    return createEmbed({
        title: truncate(row.name, 256),
        description: truncate(lines.join('\n'), 4096),
        fields: [
            ...(evidence.field ? [evidence.field] : []),
            { name: tr.t('staff.background.record.appealHistory'), value: truncate(history, 1024) },
        ],
        image: evidence.imageUrl,
        color: row.status === 'active' && !row.voided_at ? 'warning' : 'secondary',
    });
}

export async function buildRecordList(guildId, viewerId, targetUser, page, { lang = 'en' } = {}) {
    const tr = botText(lang);
    const [{ rows, total }, appealStatuses, notes] = await Promise.all([
        listCasesForUser(guildId, targetUser.id, { limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
        getLatestAppealStatuses(targetUser.id, guildId),
        loadNotes(guildId, targetUser.id),
    ]);
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    const fields = rows.map((row) => ({
        name: truncate(`${row.name} · ${caseTypeText(row.type, tr)}${row.is_test ? tr.t('staff.background.list.test') : ''} · ${statusLabel(row, appealStatuses.get(row.case_code), tr)}`, 256),
        value: truncate([
            `\`${row.case_code}\` · ${dateStamp(row.created_at)}${row.is_imported ? tr.t('staff.background.list.imported') : ''}`,
            tr.t('staff.background.list.reason', { reason: row.reason }),
            row.expires_at ? tr.t('staff.background.list.ends', { date: stamp(row.expires_at) }) : null,
        ].filter(Boolean).join('\n'), 1024),
    }));

    const noContact = getActiveOrdersFor(guildId, targetUser.id);
    const noContactField = noContact.length
        ? [{ name: tr.t('staff.background.list.keepApart'), value: truncate(noContactLines(noContact).join('\n'), 1024) }]
        : [];
    // Reads the database when the cache never loaded; a database error throws (never "not watched").
    const watch = await getActiveWatchChecked(guildId, targetUser.id);
    const watchField = watch ? [{ name: tr.t('staff.background.list.watchlist'), value: truncate(watchlistLine(watch, { lang: tr.lang }), 1024) }] : [];

    const embed = createEmbed({
        title: truncate(tr.t('staff.background.list.title', { name: targetUser.username }), 256),
        description: total
            ? tr.tp('staff.background.list.count', total)
            : tr.t('staff.background.list.empty'),
        fields: [...watchField, ...noContactField, ...fields, notesField(notes, tr)],
        footer: { text: tr.t('staff.background.list.page', { page: Math.min(page + 1, pages), pages }) },
        color: 'primary',
    });

    const noteRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`bg:noteadd:${viewerId}:${targetUser.id}`).setLabel(tr.t('staff.background.button.addNote')).setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`bg:notedel:${viewerId}:${targetUser.id}`).setLabel(tr.t('staff.background.button.removeNote')).setStyle(ButtonStyle.Secondary)
            .setDisabled(notes.length === 0),
    );
    const components = pages > 1 ? [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`bg:page:${viewerId}:${targetUser.id}:${page - 1}`)
            .setLabel(tr.t('staff.background.button.newer'))
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page <= 0),
        new ButtonBuilder()
            .setCustomId(`bg:page:${viewerId}:${targetUser.id}:${page + 1}`)
            .setLabel(tr.t('staff.background.button.older'))
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page + 1 >= pages),
    )] : [];
    components.push(noteRow);

    return { embeds: [embed], components };
}

function noteModal(step, targetId, tr) {
    const input = step === 'add'
        ? new TextInputBuilder().setCustomId('note').setStyle(TextInputStyle.Paragraph).setMaxLength(1000).setRequired(true)
        : new TextInputBuilder().setCustomId('number').setStyle(TextInputStyle.Short).setMaxLength(4).setRequired(true).setPlaceholder(tr.t('staff.background.modal.numberPlaceholder'));
    return new ModalBuilder()
        .setCustomId(`bgnote:${step}:${targetId}`)
        .setTitle(step === 'add' ? tr.t('staff.background.modal.addTitle') : tr.t('staff.background.modal.removeTitle'))
        .addLabelComponents(new LabelBuilder()
            .setLabel(step === 'add' ? tr.t('staff.background.modal.noteLabel') : tr.t('staff.background.modal.numberLabel'))
            .setTextInputComponent(input));
}

function staffOnly(interaction) {
    // Any server: the view only ever reads and writes interaction.guildId's records and notes.
    return isAdministrator(interaction.member) && Boolean(interaction.guildId);
}

export async function handleBackgroundButton(interaction, client, args) {
    const [step, viewerId, targetId, rawPage] = args;
    if (!['page', 'noteadd', 'notedel'].includes(step)) return;
    const tr = textForInteraction(interaction);

    if (interaction.user.id !== viewerId || !staffOnly(interaction)) {
        return replyUserError(interaction, {
            type: ErrorTypes.PERMISSION,
            message: tr.t('staff.background.notYours'),
        });
    }
    if (step === 'noteadd') return InteractionHelper.safeShowModal(interaction, noteModal('add', targetId, tr));
    if (step === 'notedel') return InteractionHelper.safeShowModal(interaction, noteModal('del', targetId, tr));

    await interaction.deferUpdate();
    const targetUser = await client.users.fetch(targetId);
    const page = Math.max(0, Number.parseInt(rawPage, 10) || 0);
    await InteractionHelper.safeEditReply(interaction, await buildRecordList(interaction.guildId, viewerId, targetUser, page, { lang: tr.lang }));
}

/** Saves a staff note added or removed from the /background view, then refreshes the view. */
export async function handleBackgroundNoteModal(interaction, client, args) {
    const [step, targetId] = args;
    const tr = textForInteraction(interaction);
    if (!staffOnly(interaction) || !/^\d{17,20}$/.test(targetId ?? '')) {
        return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: tr.t('staff.background.notesAdminOnly') });
    }
    if (step === 'add') {
        const content = interaction.fields.getTextInputValue('note').trim();
        if (!content) return replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: tr.t('staff.background.noteEmpty') });
        await addNote(interaction.guildId, targetId, content, { id: interaction.user.id, tag: interaction.user.tag });
    } else if (step === 'del') {
        const number = Number.parseInt(interaction.fields.getTextInputValue('number'), 10);
        const removed = await removeNote(interaction.guildId, targetId, { number });
        if (!removed) return replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: tr.t('staff.background.noNoteNumber', { number: interaction.fields.getTextInputValue('number') }) });
    } else {
        return;
    }

    const targetUser = await client.users.fetch(targetId);
    const view = await buildRecordList(interaction.guildId, interaction.user.id, targetUser, 0, { lang: tr.lang });
    // The form was opened from the /background message: update it in place.
    if (interaction.isFromMessage?.()) return interaction.update(view);
    return InteractionHelper.safeReply(interaction, { ...view, flags: MessageFlags.Ephemeral });
}
