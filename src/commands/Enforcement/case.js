// /case — search, edit, remove, history, tags, notes, evidence, keep-apart orders and the watchlist.
// Every answer is ephemeral, so it is in the administrator's Discord language (utils/botText.js
// 'reply'); the mod log posts made by the services are in the server's language.

import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { ErrorTypes, TitanBotError } from '../../utils/errorHandler.js';
import { createEmbed, successEmbed } from '../../utils/embeds.js';
import { textForInteraction } from '../../utils/botText.js';
import { descriptionLocalizations } from '../../utils/commandLocalizations.js';
import { getReason } from '../../config/enforcement.js';
import { isAdministrator } from '../../services/enforcement/enforcementService.js';
import { getCaseByCode } from '../../services/enforcement/caseService.js';
import { isEnforcementDbAvailable } from '../../services/enforcement/db.js';
import {
    describeDuration, editCase, getCaseEdits, parseEditDuration, searchCases, voidCase,
} from '../../services/enforcement/caseEditService.js';
import { dateStamp, fitWholeLines, normalizeCaseCode, stamp, truncate } from '../../services/enforcement/format.js';
import {
    addEvidence, addImageEvidence, captureLinks, evidenceDisplay, evidenceLines, fitLines, listEvidence, NOTE_MAX,
    parseEvidenceUrls, removeEvidence, resolveImageUrls,
} from '../../services/enforcement/evidenceService.js';
import {
    listReasonKeys, normalizeSearchFilters, SEARCH_STATUSES, SEARCH_TEXT_MAX, SEARCH_TYPES,
} from '../../services/enforcement/caseSearchService.js';
import { buildSearchView } from '../../handlers/caseSearchView.js';
import { caseTypeText } from '../../handlers/backgroundView.js';
import { CaseNoteError, caseNotes, normalizeTags, tagsText } from '../../services/enforcement/caseNotesService.js';
import {
    addNoContactOrder, endNoContactOrder, listActiveNoContactOrders, NO_CONTACT_MAX_DAYS,
} from '../../services/enforcement/noContactService.js';
import {
    addWatch, endWatch, listActiveWatches, watchListDescription, WATCH_MAX_DAYS, WATCH_REASON_MAX,
} from '../../services/enforcement/watchlistService.js';

function userError(message) {
    return new TitanBotError(message, ErrorTypes.USER_INPUT, message, { expected: true });
}

// Errors the enforcement services throw with an `i18n` code ({ code, params }), in the reader's
// language. An error without a known code is shown as the service wrote it (English).
const SERVICE_ERRORS = Object.freeze({
    noCase: (tr, p) => tr.t('staff.case.error.noCase', p),
    noCaseAnywhere: (tr, p) => tr.t('staff.case.error.noCaseAnywhere', p),
    editVoided: (tr, p) => tr.t('staff.case.error.editVoided', p),
    noDurationType: (tr, p) => tr.t('staff.case.error.noDurationType', { ...p, type: caseTypeText(p.type, tr) }),
    ladderDuration: (tr) => tr.t('staff.case.error.ladderDuration'),
    importedDuration: (tr) => tr.t('staff.case.error.importedDuration'),
    endedDuration: (tr, p) => tr.t('staff.case.error.endedDuration', p),
    muteNeedsDuration: (tr) => tr.t('staff.case.error.muteNeedsDuration'),
    nothingToChange: (tr) => tr.t('staff.case.error.nothingToChange'),
    badDuration: (tr) => tr.t('staff.case.error.badDuration'),
    alreadyRemoved: (tr, p) => tr.t('staff.case.error.alreadyRemoved', p),
    badTag: (tr, p) => tr.t('staff.case.error.badTag', p),
    tooManyTags: (tr, p) => tr.t('staff.case.error.tooManyTags', p),
    noteEmpty: (tr) => tr.t('staff.case.error.noteEmpty'),
    noteTooLong: (tr, p) => tr.t('staff.case.error.noteTooLong', p),
    badDate: (tr, p) => tr.t('staff.case.error.badDate', p),
    badFromDate: (tr, p) => tr.t('staff.case.error.badFromDate', p),
    badToDate: (tr, p) => tr.t('staff.case.error.badToDate', p),
    badMember: (tr) => tr.t('staff.case.error.badMember'),
    badModerator: (tr) => tr.t('staff.case.error.badModerator'),
    badType: (tr, p) => tr.t('staff.case.error.badType', p),
    badReasonKey: (tr) => tr.t('staff.case.error.badReasonKey'),
    badStatus: (tr, p) => tr.t('staff.case.error.badStatus', p),
    fromAfterTo: (tr) => tr.t('staff.case.error.fromAfterTo'),
    badSearchTag: (tr) => tr.t('staff.case.error.badSearchTag'),
    watchBot: (tr) => tr.t('staff.case.error.watchBot'),
    watchSelf: (tr) => tr.t('staff.case.error.watchSelf'),
    watchDays: (tr, p) => tr.t('staff.case.error.watchDays', p),
    reasonRequired: (tr) => tr.t('staff.case.error.reasonRequired'),
    watchExists: (tr, p) => tr.t('staff.case.error.watchExists', p),
    evidenceFull: (tr, p) => tr.t('staff.case.error.evidenceFull', p),
    notImage: (tr) => tr.t('staff.case.error.notImage'),
    noEvidenceChannelHome: (tr) => tr.t('staff.case.error.noEvidenceChannelHome'),
    noEvidenceChannel: (tr) => tr.t('staff.case.error.noEvidenceChannel'),
});
/** For tests: the service error codes /case translates. */
export const CASE_SERVICE_ERROR_CODES = Object.freeze(Object.keys(SERVICE_ERRORS));

/** A service error with an `i18n` code → the same error in the reader's language; anything else unchanged. */
export function localizeServiceError(error, tr) {
    const info = error?.i18n;
    if (!info || !Object.hasOwn(SERVICE_ERRORS, info.code)) return error;
    const text = SERVICE_ERRORS[info.code](tr, info.params || {});
    return new TitanBotError(error.message, error.type || ErrorTypes.USER_INPUT, text, { expected: true });
}

function readCode(interaction, tr) {
    const raw = interaction.options.getString('code', true);
    const code = normalizeCaseCode(raw);
    if (!code) throw userError(tr.t('staff.case.notACode', { value: truncate(raw, 20) }));
    return code;
}

/** "permanent" → null; otherwise a parsed duration; undefined when the option is absent. */
function readDuration(interaction) {
    return parseEditDuration(interaction.options.getString('duration'));
}

function codeOption(option) {
    return option.setName('code').setDescription('Case code')
        .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.code')).setRequired(true)
        .setAutocomplete(true).setMinLength(5).setMaxLength(7);
}

async function loadCaseInGuild(interaction, code, tr) {
    const record = await getCaseByCode(code, interaction.guildId);
    if (!record || record.guild_id !== interaction.guildId) throw userError(tr.t('staff.case.error.noCase', { code }));
    return record;
}

const footerOf = (record, tr) => tr.t('staff.case.footer', {
    type: caseTypeText(record.type, tr), user: record.target_username, moderator: record.moderator_username,
});

/** /case tags, /case note add | list (staff-only; services/enforcement/caseNotesService.js). */
async function handleNotesAndTags(interaction, group, sub, code, tr) {
    try {
        if (sub === 'tags') {
            const tags = normalizeTags(interaction.options.getString('tags', true));
            const { before, after } = await caseNotes.setTags(interaction.guildId, code, tags);
            return InteractionHelper.safeEditReply(interaction, {
                embeds: [successEmbed(tr.t('staff.case.tags.title', { code }), `${tagsText(before, { lang: tr.lang })} → ${tagsText(after, { lang: tr.lang })}`)],
            });
        }
        if (sub === 'add') {
            await caseNotes.addNote(interaction.guildId, code, { id: interaction.user.id, username: interaction.user.username },
                interaction.options.getString('text', true));
            return InteractionHelper.safeEditReply(interaction, {
                embeds: [successEmbed(tr.t('staff.case.note.addedTitle', { code }), tr.t('staff.case.note.added'))],
            });
        }
        await loadCaseInGuild(interaction, code, tr);
        const notes = await caseNotes.listNotes(code);
        return InteractionHelper.safeEditReply(interaction, {
            embeds: [createEmbed({
                title: tr.t('staff.case.note.listTitle', { code }),
                description: truncate(notes.length
                    ? notes.map((n) => tr.t('staff.case.note.line', { date: dateStamp(n.created_at), author: n.author_username || n.author_id, text: truncate(n.text, 600) })).join('\n')
                    : tr.t('staff.case.note.none'), 4096),
                color: 'primary',
            })],
        });
    } catch (error) {
        if (error instanceof CaseNoteError) {
            const known = error.i18n && Object.hasOwn(SERVICE_ERRORS, error.i18n.code);
            throw userError(known ? SERVICE_ERRORS[error.i18n.code](tr, error.i18n.params || {}) : error.userMessage);
        }
        throw error;
    }
}

/** /case evidence add | list | remove */
async function handleEvidence(interaction, client, sub, code, tr) {
    const record = await loadCaseInGuild(interaction, code, tr);
    const addedBy = { id: interaction.user.id, username: interaction.user.username };

    if (sub === 'add') {
        const link = interaction.options.getString('link')?.trim() || '';
        const image = interaction.options.getAttachment('image');
        const note = interaction.options.getString('note')?.trim() || null;
        if (!link && !image) throw userError(tr.t('staff.case.evidence.needSomething'));

        let linkEntry = null;
        if (link) {
            const entries = parseEvidenceUrls(link);
            if (entries.length !== 1) throw userError(tr.t('staff.case.evidence.oneLink'));
            [linkEntry] = await captureLinks(interaction.guild, entries);
        }

        const added = [];
        if (linkEntry) {
            added.push(await addEvidence(code, {
                kind: 'link', url: linkEntry.url, sourceMessageUrl: linkEntry.sourceMessageUrl, excerpt: linkEntry.excerpt, note, addedBy,
            }));
        }
        if (image) {
            added.push(await addImageEvidence(client, code, image, { note, addedBy, guildId: interaction.guildId }));
        }

        const fresh = await resolveImageUrls(client, added);
        const lines = evidenceLines(added, fresh, { excerptMax: 300, caseGuildId: record.guild_id, lang: tr.lang });
        if (linkEntry?.sourceMessageUrl && !linkEntry.excerpt) {
            lines.push(tr.t('staff.case.evidence.unreadable'));
        }
        return InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed(tr.t('staff.case.evidence.addedTitle', { code: record.case_code }), truncate(lines.join('\n'), 4000))],
        });
    }

    if (sub === 'list') {
        const rows = await listEvidence(code);
        const fresh = await resolveImageUrls(client, rows);
        const firstImage = rows.find((row) => fresh.has(String(row.id)));
        return InteractionHelper.safeEditReply(interaction, {
            embeds: [createEmbed({
                title: truncate(tr.t('staff.case.evidence.listTitle', { code: record.case_code, name: record.name }), 256),
                description: rows.length
                    ? fitLines(evidenceLines(rows, fresh, { excerptMax: 300, caseGuildId: record.guild_id, lang: tr.lang }), 4096)
                    : tr.t('staff.case.evidence.none'),
                image: firstImage ? fresh.get(String(firstImage.id)) : null,
                footer: { text: truncate(footerOf(record, tr), 2048) },
                color: 'primary',
            })],
        });
    }

    if (sub === 'remove') {
        const id = interaction.options.getInteger('id', true);
        const removed = await removeEvidence(code, id);
        if (!removed) throw userError(tr.t('staff.case.evidence.noSuch', { code, id }));
        const what = removed.kind === 'image' ? tr.t('staff.case.evidence.removedImage') : removed.url;
        return InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed(tr.t('staff.case.evidence.removedTitle', { id, code: record.case_code }), truncate(what, 4000))],
        });
    }
}

const unixOf = (date) => Math.floor(new Date(date).getTime() / 1000);
function dmNote([a, b], tr) {
    if (a && b) return tr.t('staff.case.keepapart.dmBoth');
    if (!a && !b) return tr.t('staff.case.keepapart.dmNeither');
    return a ? tr.t('staff.case.keepapart.dmNotSecond') : tr.t('staff.case.keepapart.dmNotFirst');
}

/** /case keepapart add | list | end */
async function handleNoContact(interaction, client, sub, tr) {
    const admin = { id: interaction.user.id, username: interaction.user.username };

    if (sub === 'add') {
        const userA = interaction.options.getUser('user_a', true);
        const userB = interaction.options.getUser('user_b', true);
        if (userA.bot || userB.bot) throw userError(tr.t('staff.case.keepapart.noBots'));
        const { order, delivered } = await addNoContactOrder(client, {
            guildId: interaction.guildId,
            userA: userA.id,
            userB: userB.id,
            days: interaction.options.getInteger('days', true),
            reason: interaction.options.getString('reason', true),
            createdBy: admin,
        });
        return InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed(tr.t('staff.case.keepapart.startedTitle', { id: order.id }), [
                tr.t('staff.case.keepapart.started', {
                    a: userA.username, b: userB.username, until: `<t:${unixOf(order.until)}:f>`, relative: `<t:${unixOf(order.until)}:R>`,
                }),
                tr.t('staff.case.keepapart.breaking'),
                dmNote(delivered, tr),
            ].join('\n'))],
        });
    }

    if (sub === 'list') {
        const rows = await listActiveNoContactOrders(interaction.guildId);
        const lines = rows.map((row) => tr.t('staff.case.keepapart.listLine', {
            id: row.id, a: `<@${row.user_a}>`, b: `<@${row.user_b}>`, until: `<t:${unixOf(row.until)}:f>`, by: `<@${row.created_by}>`, reason: truncate(row.reason, 120),
        }));
        return InteractionHelper.safeEditReply(interaction, {
            embeds: [createEmbed({
                title: tr.t('staff.case.keepapart.listTitle', { count: rows.length }),
                description: lines.length ? fitWholeLines(lines) : tr.t('staff.case.keepapart.none'),
                color: 'primary',
            })],
        });
    }

    if (sub === 'end') {
        const id = interaction.options.getInteger('id', true);
        const result = await endNoContactOrder(client, { guildId: interaction.guildId, id, endedBy: admin });
        if (!result) throw userError(tr.t('staff.case.keepapart.noSuch', { id }));
        return InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed(tr.t('staff.case.keepapart.endedTitle', { id }), [
                tr.t('staff.case.keepapart.ended', { a: `<@${result.order.user_a}>`, b: `<@${result.order.user_b}>` }),
                dmNote(result.delivered, tr),
            ].join('\n'))],
        });
    }
}

/** /case watch add | list | end — the watched member is never told. */
async function handleWatch(interaction, client, sub, tr) {
    const admin = { id: interaction.user.id, username: interaction.user.username };

    if (sub === 'add') {
        const member = interaction.options.getUser('member', true);
        const row = await addWatch(client, {
            guildId: interaction.guildId,
            userId: member.id,
            username: member.username,
            isBot: Boolean(member.bot),
            days: interaction.options.getInteger('days') ?? null,
            reason: interaction.options.getString('reason', true),
            createdBy: admin,
        });
        const name = truncate(member.username, 50);
        return InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed(tr.t('staff.case.watch.addedTitle', { id: row.id }), [
                row.until
                    ? tr.t('staff.case.watch.addedUntil', { name, until: `<t:${unixOf(row.until)}:f>`, relative: `<t:${unixOf(row.until)}:R>` })
                    : tr.t('staff.case.watch.addedNoEnd', { name }),
                tr.t('staff.case.watch.notTold'),
            ].join('\n'))],
        });
    }

    if (sub === 'list') {
        const rows = await listActiveWatches(interaction.guildId);
        return InteractionHelper.safeEditReply(interaction, {
            embeds: [createEmbed({
                title: tr.t('staff.case.watch.listTitle', { count: rows.length }),
                description: watchListDescription(rows, 4096, { lang: tr.lang }),
                color: 'primary',
            })],
        });
    }

    if (sub === 'end') {
        const id = interaction.options.getInteger('id', true);
        const row = await endWatch(client, { guildId: interaction.guildId, id, endedBy: admin });
        if (!row) throw userError(tr.t('staff.case.watch.noSuch', { id }));
        return InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed(tr.t('staff.case.watch.endedTitle', { id }), tr.t('staff.case.watch.ended', { user: `<@${row.user_id}>` }))],
        });
    }
}

// Choice labels: the stored words (ban, active …) in English; their translations for the picker.
const TYPE_CHOICE = Object.freeze({
    ban: () => descriptionLocalizations('staff.case.type.ban'),
    kick: () => descriptionLocalizations('staff.case.type.kick'),
    mute: () => descriptionLocalizations('staff.case.type.mute'),
    warn: () => descriptionLocalizations('staff.case.type.warn'),
});
const STATUS_CHOICE = Object.freeze({
    active: () => descriptionLocalizations('staff.case.cmd.statusChoice.active'),
    ended: () => descriptionLocalizations('staff.case.cmd.statusChoice.ended'),
    revoked: () => descriptionLocalizations('staff.case.cmd.statusChoice.revoked'),
    voided: () => descriptionLocalizations('staff.case.cmd.statusChoice.voided'),
});
const choiceOf = (map, value) => ({ name: value, ...(Object.hasOwn(map, value) ? { name_localizations: map[value]() } : {}), value });

/** Runs one /case subcommand (the language is passed in; errors are thrown as they are). */
async function runCase(interaction, client, tr) {
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();

    if (!group && sub === 'search') {
        const filters = normalizeSearchFilters({
            memberId: interaction.options.getUser('member')?.id,
            moderatorId: interaction.options.getUser('moderator')?.id,
            type: interaction.options.getString('type'),
            reasonKey: interaction.options.getString('reason_key'),
            status: interaction.options.getString('status'),
            from: interaction.options.getString('from'),
            to: interaction.options.getString('to'),
            text: interaction.options.getString('text'),
            tag: interaction.options.getString('tag'),
        });
        return InteractionHelper.safeEditReply(interaction, await buildSearchView(interaction.guildId, interaction.user.id, filters, 0, { lang: tr.lang }));
    }

    if (group === 'keepapart') {
        return handleNoContact(interaction, client, sub, tr);
    }

    if (group === 'watch') {
        return handleWatch(interaction, client, sub, tr);
    }

    const code = readCode(interaction, tr);
    const admin = interaction.user;

    if (group === 'evidence') {
        return handleEvidence(interaction, client, sub, code, tr);
    }

    if (group === 'note' || sub === 'tags') {
        return handleNotesAndTags(interaction, group, sub, code, tr);
    }

    if (sub === 'edit') {
        const reasonRaw = interaction.options.getString('reason');
        const reason = reasonRaw == null ? undefined : reasonRaw.trim();
        if (reason === '') throw userError(tr.t('staff.case.reasonEmpty'));
        const durationMs = readDuration(interaction);
        if (reason === undefined && durationMs === undefined) throw userError(tr.t('staff.case.edit.needSomething'));

        const { after, changes } = await editCase(client, {
            guildId: interaction.guildId, caseCode: code, editor: { id: admin.id, username: admin.username }, reason, durationMs,
        });
        const lines = changes.map((change) => (change.field === 'reason'
            ? tr.t('staff.case.edit.reasonLine', { old: truncate(change.oldValue, 300), new: truncate(change.newValue, 300) })
            : tr.t('staff.case.edit.durationLine', { old: describeDuration(change.oldValue, { lang: tr.lang }), new: describeDuration(change.newValue, { lang: tr.lang }) })));
        if (changes.some((change) => change.field === 'duration')) {
            if (!after.expires_at) lines.push(tr.t('staff.case.edit.nowPermanent'));
            else if (new Date(after.expires_at) <= new Date()) lines.push(tr.t('staff.case.edit.alreadyPast'));
            else lines.push(tr.t('staff.case.edit.nowEnds', { date: stamp(after.expires_at) }));
        }
        return InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed(tr.t('staff.case.edit.title', { code: after.case_code }), truncate(lines.join('\n'), 4000))],
        });
    }

    if (!group && sub === 'remove') {
        const reason = interaction.options.getString('reason', true).trim();
        if (!reason) throw userError(tr.t('staff.case.reasonEmpty'));
        const { record, notes, dmDelivered } = await voidCase(client, {
            guildId: interaction.guildId, caseCode: code, admin, reason, lang: tr.lang,
        });
        return InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed(tr.t('staff.case.remove.title', { code: record.case_code }), truncate([
                tr.t('staff.case.remove.noLongerCounts', { type: caseTypeText(record.type, tr), user: record.target_username }),
                ...notes,
                dmDelivered ? tr.t('staff.case.remove.dmDelivered') : tr.t('staff.case.remove.dmNotDelivered'),
            ].join('\n'), 4000))],
        });
    }

    if (sub === 'history') {
        const record = await getCaseByCode(code, interaction.guildId);
        if (!record || record.guild_id !== interaction.guildId) throw userError(tr.t('staff.case.error.noCase', { code }));
        const edits = await getCaseEdits(code);
        const lines = edits.map((edit) => {
            const what = edit.field === 'duration'
                ? tr.t('staff.case.history.durationChange', { old: describeDuration(edit.old_value, { lang: tr.lang }), new: describeDuration(edit.new_value, { lang: tr.lang }) })
                : tr.t('staff.case.history.reasonChange', { old: truncate(edit.old_value, 150), new: truncate(edit.new_value, 150) });
            return tr.t('staff.case.history.line', { date: dateStamp(edit.edited_at), name: edit.edited_by_username, what });
        });
        if (record.voided_at) {
            lines.unshift(tr.t('staff.case.history.removed', { date: dateStamp(record.voided_at), by: record.voided_by, reason: truncate(record.void_reason || '', 300) }));
        }
        const evidence = await evidenceDisplay(client, code, { lang: tr.lang });
        const noteCount = await caseNotes.countNotes(code);
        const extra = [{ name: tr.t('staff.case.history.tags'), value: tagsText(record.tags, { lang: tr.lang }), inline: true }];
        if (noteCount) extra.push({ name: tr.t('staff.case.history.notes'), value: `${noteCount} · \`/case note list code:${code}\``, inline: true });
        return InteractionHelper.safeEditReply(interaction, {
            embeds: [createEmbed({
                title: truncate(tr.t('staff.case.history.title', { code: record.case_code, name: record.name }), 256),
                description: truncate(lines.join('\n') || tr.t('staff.case.history.never'), 4096),
                fields: [...extra, ...(evidence.field ? [evidence.field] : [])],
                image: evidence.imageUrl,
                footer: { text: truncate(footerOf(record, tr), 2048) },
                color: 'primary',
            })],
        });
    }
}

export default {
    // Admin-only (not in commandAccess).
    data: new SlashCommandBuilder()
        .setName('case')
        .setDescription('Search, edit and remove cases, evidence and history, keep-apart orders and the watchlist')
        .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.description'))
        .addSubcommand((sub) => sub.setName('search').setDescription('Find cases by member, moderator, type, reason, status, date or text')
            .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.search.description'))
            .addUserOption((option) => option.setName('member').setDescription('Cases given to this member')
                .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.search.member')))
            .addUserOption((option) => option.setName('moderator').setDescription('Cases given by this moderator')
                .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.search.moderator')))
            .addStringOption((option) => option.setName('type').setDescription('Case type')
                .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.search.type'))
                .addChoices(...SEARCH_TYPES.map((type) => choiceOf(TYPE_CHOICE, type))))
            .addStringOption((option) => option.setName('reason_key').setDescription('Prebuilt reason (or custom)')
                .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.search.reasonKey'))
                .setAutocomplete(true).setMaxLength(50))
            .addStringOption((option) => option.setName('status').setDescription('active, ended, revoked (lifted early) or voided (removed as a mistake)')
                .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.search.status'))
                .addChoices(...SEARCH_STATUSES.map((status) => choiceOf(STATUS_CHOICE, status))))
            .addStringOption((option) => option.setName('from').setDescription('Given on or after (YYYY-MM-DD, UTC)')
                .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.search.from'))
                .setMinLength(10).setMaxLength(10))
            .addStringOption((option) => option.setName('to').setDescription('Given on or before (YYYY-MM-DD, UTC)')
                .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.search.to'))
                .setMinLength(10).setMaxLength(10))
            .addStringOption((option) => option.setName('tag').setDescription('Cases with this tag')
                .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.search.tag')).setAutocomplete(true).setMaxLength(21))
            .addStringOption((option) => option.setName('text').setDescription('Text in the case name or reason')
                .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.search.text'))
                .setMaxLength(SEARCH_TEXT_MAX)))
        .addSubcommand((sub) => sub.setName('edit').setDescription("Change a case's reason or duration (history is kept)")
            .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.edit.description'))
            .addStringOption(codeOption)
            .addStringOption((option) => option.setName('reason').setDescription('New reason')
                .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.edit.reason')).setMaxLength(500))
            .addStringOption((option) => option.setName('duration')
                .setDescription('New total duration from when it was given, e.g. 7d, 1mo, permanent (open bans/mutes only)')
                .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.edit.duration'))
                .setMaxLength(20)))
        .addSubcommand((sub) => sub.setName('remove').setDescription('Mark a case as a mistake: lift it and stop it counting')
            .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.remove.description'))
            .addStringOption(codeOption)
            .addStringOption((option) => option.setName('reason').setDescription('Why it is removed as a mistake (shown to the user)')
                .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.remove.reason'))
                .setRequired(true).setMaxLength(500)))
        .addSubcommand((sub) => sub.setName('history').setDescription("Show a case's edit history and evidence")
            .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.history.description'))
            .addStringOption(codeOption))
        .addSubcommand((sub) => sub.setName('tags').setDescription('Set the tags on a case, like scam, alt or raid')
            .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.tags.description'))
            .addStringOption(codeOption)
            .addStringOption((option) => option.setName('tags').setDescription('Comma-separated; "none" clears them')
                .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.tags.tags')).setRequired(true).setMaxLength(250)))
        .addSubcommandGroup((group) => group.setName('note').setDescription('Private staff notes on a case')
            .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.note.description'))
            .addSubcommand((sub) => sub.setName('add').setDescription('Add a note only staff can see')
                .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.note.add'))
                .addStringOption(codeOption)
                .addStringOption((option) => option.setName('text').setDescription('The note')
                    .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.note.text')).setRequired(true).setMaxLength(1000)))
            .addSubcommand((sub) => sub.setName('list').setDescription('Show the notes on a case')
                .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.note.list'))
                .addStringOption(codeOption)))
        .addSubcommandGroup((group) => group.setName('evidence').setDescription('Evidence attached to a case')
            .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.evidence.description'))
            .addSubcommand((sub) => sub.setName('add').setDescription('Attach a message link and/or an image to a case')
                .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.evidence.add'))
                .addStringOption(codeOption)
                .addStringOption((option) => option.setName('link').setDescription('A link, e.g. a Discord message link (its text is saved)')
                    .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.evidence.link'))
                    .setMaxLength(500))
                .addAttachmentOption((option) => option.setName('image').setDescription('A screenshot; re-hosted in the evidence channel')
                    .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.evidence.image')))
                .addStringOption((option) => option.setName('note').setDescription('Short note about this evidence')
                    .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.evidence.note'))
                    .setMaxLength(NOTE_MAX)))
            .addSubcommand((sub) => sub.setName('list').setDescription("List a case's evidence")
                .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.evidence.list'))
                .addStringOption(codeOption))
            .addSubcommand((sub) => sub.setName('remove').setDescription('Remove one piece of evidence from a case')
                .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.evidence.remove'))
                .addStringOption(codeOption)
                .addIntegerOption((option) => option.setName('id').setDescription('Evidence number (#) from /case evidence list')
                    .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.evidence.id'))
                    .setRequired(true).setMinValue(1))))
        .addSubcommandGroup((group) => group.setName('keepapart').setDescription('Keep apart: two members may not mention or reply to each other')
            .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.keepapart.description'))
            .addSubcommand((sub) => sub.setName('add').setDescription('Keep two members apart: start an order (both are DMed)')
                .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.keepapart.add'))
                .addUserOption((option) => option.setName('user_a').setDescription('First member')
                    .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.keepapart.userA')).setRequired(true))
                .addUserOption((option) => option.setName('user_b').setDescription('Second member')
                    .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.keepapart.userB')).setRequired(true))
                .addIntegerOption((option) => option.setName('days').setDescription('How many days it lasts')
                    .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.keepapart.days'))
                    .setRequired(true).setMinValue(1).setMaxValue(NO_CONTACT_MAX_DAYS))
                .addStringOption((option) => option.setName('reason').setDescription('Why (shown to both members)')
                    .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.keepapart.reason'))
                    .setRequired(true).setMaxLength(500)))
            .addSubcommand((sub) => sub.setName('list').setDescription('List active keep-apart orders')
                .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.keepapart.list')))
            .addSubcommand((sub) => sub.setName('end').setDescription('End a keep-apart order early (both are DMed)')
                .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.keepapart.end'))
                .addIntegerOption((option) => option.setName('id').setDescription('Order number (#) from /case keepapart list')
                    .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.keepapart.id'))
                    .setRequired(true).setMinValue(1))))
        .addSubcommandGroup((group) => group.setName('watch').setDescription('Staff watchlist: joins, new cases and automod hits go to the mod log')
            .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.watch.description'))
            .addSubcommand((sub) => sub.setName('add').setDescription('Put a member on the watchlist (they are not told)')
                .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.watch.add'))
                .addUserOption((option) => option.setName('member').setDescription('The member to watch')
                    .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.watch.member')).setRequired(true))
                .addStringOption((option) => option.setName('reason').setDescription('Why (staff only)')
                    .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.watch.reason'))
                    .setRequired(true).setMaxLength(WATCH_REASON_MAX))
                .addIntegerOption((option) => option.setName('days').setDescription('How many days (empty = no end date)')
                    .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.watch.days'))
                    .setMinValue(1).setMaxValue(WATCH_MAX_DAYS)))
            .addSubcommand((sub) => sub.setName('list').setDescription('List members on the watchlist')
                .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.watch.list')))
            .addSubcommand((sub) => sub.setName('end').setDescription('Take a member off the watchlist')
                .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.watch.end'))
                .addIntegerOption((option) => option.setName('id').setDescription('Entry number (#) from /case watch list')
                    .setDescriptionLocalizations(descriptionLocalizations('staff.case.cmd.watch.id'))
                    .setRequired(true).setMinValue(1)))),

    async execute(interaction, config, client) {
        const tr = textForInteraction(interaction);
        // Any server (multi-server B1): every subcommand reads and writes this server's cases only.
        if (!interaction.guildId) {
            throw new TitanBotError('/case outside a server', ErrorTypes.PERMISSION, tr.t('staff.case.serverOnly'), { expected: true });
        }
        if (!isAdministrator(interaction.member)) {
            throw new TitanBotError('Not an administrator', ErrorTypes.PERMISSION, tr.t('staff.case.noAdmin'), { expected: true });
        }
        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;

        try {
            return await runCase(interaction, client, tr);
        } catch (error) {
            throw localizeServiceError(error, tr);
        }
    },

    async autocomplete(interaction) {
        if (!interaction.guildId || !isAdministrator(interaction.member)
            || !isEnforcementDbAvailable()) {
            return interaction.respond([]);
        }
        const tr = textForInteraction(interaction);
        const focused = interaction.options.getFocused(true);
        if (focused.name === 'reason_key') {
            const keys = await listReasonKeys(interaction.guildId, focused.value);
            return interaction.respond(keys.map((row) => ({
                name: truncate(tr.tp('staff.case.autocomplete.reasonCount', row.count, { label: getReason(row.reason_key)?.label || row.reason_key, key: row.reason_key }), 100),
                value: row.reason_key,
            })));
        }
        if (focused.name === 'tag') {
            const tags = await caseNotes.usedTags(interaction.guildId, focused.value);
            return interaction.respond(tags.map((tag) => ({ name: `#${tag}`, value: tag })));
        }
        if (focused.name !== 'code') return interaction.respond([]);
        const rows = await searchCases(interaction.guildId, focused.value);
        await interaction.respond(rows.map((row) => ({
            name: truncate(`${row.case_code}: ${row.name} (${row.type}, ${row.target_username})${row.voided_at ? tr.t('staff.case.autocomplete.removed') : ''}`, 100),
            value: row.case_code,
        })));
    },
};
