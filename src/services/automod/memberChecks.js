// memberChecks.js — automod checks that are about a member rather than a message:
// impersonation by name (on join and on every name change) and member reports.

import { AUTOMOD_RULES, automodConfig } from '../../config/automod.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { logger } from '../../utils/logger.js';
import { isEnforcementDbAvailable } from '../enforcement/db.js';
import { isAdministrator } from '../enforcement/enforcementService.js';
import { getAutomodSettings, isChannelExempt } from './automodSettings.js';
import { applyStep, isStaff } from './automodService.js';
import { findForbiddenCharacters, findImpersonation, plainName } from './filters.js';
import { postReviewCard } from './reviewCards.js';
import { impersonationReason } from './reasons.js';

const RENAMED_NICKNAME = 'Renamed member';
const recentlyChecked = new Map(); // guildId:userId → names key (avoids double action on one change)

function staffNames(guild, exceptId) {
    const names = new Set();
    for (const member of guild.members.cache.values()) {
        if (member.id === exceptId || member.user.bot || !isStaff(member)) continue;
        [member.displayName, member.user.username, member.user.globalName].filter(Boolean).forEach((name) => names.add(name));
    }
    return [...names];
}

/** Checks a member's names; renames and punishes an imitation of staff. */
export async function checkImpersonation(member) {
    try {
        const { guild } = member;
        if (guild.id !== enforcementConfig.mainGuildId || member.user.bot || !isEnforcementDbAvailable()) return;
        if (isStaff(member) || isAdministrator(member)) return;
        const settings = await getAutomodSettings(guild.id);
        if (!settings.enabled) return;

        // English only, names included: a styled or non-English display name is reset to
        // plain letters. Not a punishment, so no case.
        if (findForbiddenCharacters(member.displayName) && member.manageable) {
            const plain = plainName(member.displayName) || RENAMED_NICKNAME;
            await member.setNickname(plain, 'Automod: English letters only in names').catch((error) =>
                logger.warn(`Could not reset nickname of ${member.id}: ${error.message}`));
        }

        const names = [member.nickname, member.user.globalName, member.user.username];
        const namesKey = names.join('|');
        const checkKey = `${guild.id}:${member.id}`;
        if (recentlyChecked.get(checkKey) === namesKey) return;
        recentlyChecked.set(checkKey, namesKey);
        if (recentlyChecked.size > 2000) recentlyChecked.clear();

        const evidence = findImpersonation(names, staffNames(guild, member.id));
        if (!evidence) return;

        const card = {
            guild, rule: 'impersonation', evidence: impersonationReason(evidence), detail: evidence, targetUser: member.user,
            channelId: null, messageUrl: null, content: `Names: ${names.filter(Boolean).join(', ')}`,
        };
        if (settings.mode === 'monitor') {
            await postReviewCard({ ...card, monitor: true, suggested: AUTOMOD_RULES.impersonation.steps[0] });
            return;
        }

        // A nickname can be reset; usernames can't be changed by the bot, so the case is enough then.
        const renamed = await member.setNickname(RENAMED_NICKNAME, 'Automod: impersonation').then(() => true).catch(() => false);
        const step = AUTOMOD_RULES.impersonation.steps[0];
        const result = await applyStep({ guild, targetUser: member.user, step, rule: 'impersonation', reason: 'Automod: Impersonation or deception' })
            .catch((error) => ({ error }));
        await postReviewCard({ ...card, evidence: `${card.evidence}${renamed ? `; their nickname was reset to "${RENAMED_NICKNAME}"` : ''}`, step, result, deleted: false });
    } catch (error) {
        logger.warn(`Impersonation check failed for ${member?.id}: ${error.message}`);
    }
}

const reportedMessages = new Set(); // message ids already sent to staff by reactions

/** A member report from the "Report message" context menu. */
export async function reportMessage(message, reporter) {
    await postReviewCard({
        guild: message.guild,
        rule: 'report',
        evidence: `was reported by ${reporter.username} with "Report message"`,
        targetUser: message.author,
        channelId: message.channelId,
        messageUrl: message.url,
        content: message.content || '',
        report: { reporter: `${reporter.username} (\`${reporter.id}\`)`, messageId: message.id, removed: false },
    });
}

/** Flag reactions: enough distinct members remove the message and send it to staff. */
export async function handleReportReaction(reaction, user) {
    try {
        if (user.bot || reaction.emoji.name !== automodConfig.reportEmoji) return;
        const message = reaction.message.partial ? await reaction.message.fetch().catch(() => null) : reaction.message;
        if (!message?.guild || message.guild.id !== enforcementConfig.mainGuildId || reportedMessages.has(message.id)) return;
        if (!message.author || message.author.bot) return;
        if (await isChannelExempt(message.guild.id, message.channel)) return;

        const author = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
        if (isStaff(author)) return;

        const users = await reaction.users.fetch().catch(() => null);
        const reporters = users ? [...users.values()].filter((u) => !u.bot && u.id !== message.author.id) : [];
        if (reporters.length < automodConfig.reportReactions) return;

        reportedMessages.add(message.id);
        if (reportedMessages.size > 2000) reportedMessages.clear();
        await message.delete().catch(() => {});
        await postReviewCard({
            guild: message.guild,
            rule: 'report',
            evidence: `was reported by ${reporters.length} members reacting with ${automodConfig.reportEmoji}`,
            targetUser: message.author,
            channelId: message.channelId,
            messageUrl: null,
            content: message.content || '',
            report: { reporter: reporters.map((u) => u.username).join(', '), messageId: message.id, removed: true },
        });
    } catch (error) {
        logger.warn(`Report reaction failed: ${error.message}`);
    }
}
