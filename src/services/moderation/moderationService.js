// moderationService.js

import { TitanBotError, ErrorTypes } from '../../utils/errorHandler.js';
import { botText } from '../../utils/botText.js';

function getTargetLabel(target) {
  return target.user?.tag ?? target.displayName ?? 'this user';
}

function getHighestRole(member) {
  return member?.roles?.highest ?? null;
}

export class ModerationService {

  /**
   * The role-order refusal, translated (staff.enfCheck.*). Action-neutral wording ("act on"), so
   * it reads right in every language; `action` is kept for callers. `lang`: the reader's language.
   */
  static buildHierarchyMessage({ actor, actorRole, targetRole, targetLabel, action, lang = 'en' }) {
    void action;
    const tr = botText(lang);
    const params = { target: targetLabel, targetRole: targetRole.name, yourRole: actorRole.name, botRole: actorRole.name };
    if (actor === 'moderator') {
      return tr.t('staff.enfCheck.modTooLow', { target: params.target, targetRole: params.targetRole, yourRole: params.yourRole });
    }
    return tr.t('staff.enfCheck.botTooLow', { target: params.target, targetRole: params.targetRole, botRole: params.botRole });
  }

  static buildHierarchySkipReason(moderator, target, action, actor = 'moderator') {
    const targetLabel = getTargetLabel(target);
    const targetRole = getHighestRole(target);

    if (actor === 'bot') {
      const botMember = target.guild?.members?.me;
      const botRole = getHighestRole(botMember);
      if (!botRole || !targetRole) {
        return `Bot role hierarchy blocked ${action} for ${targetLabel}`;
      }
      return `Bot role **${botRole.name}** is too low for **${targetRole.name}**: move the bot role higher`;
    }

    const modRole = getHighestRole(moderator);
    if (!modRole || !targetRole) {
      return `Role hierarchy blocked ${action} for ${targetLabel}`;
    }
    return `Your role **${modRole.name}** is too low for **${targetRole.name}**: move your role higher`;
  }

  static validateHierarchy(moderator, target, action, { lang = 'en' } = {}) {
    if (!moderator || !target) {
      return { valid: false, error: 'Invalid moderator or target' };
    }

    if (moderator.guild?.ownerId === moderator.id) {
      return { valid: true };
    }

    const modRole = getHighestRole(moderator);
    const targetRole = getHighestRole(target);

    if (!modRole || !targetRole) {
      return {
        valid: false,
        error: botText(lang).t('staff.enfCheck.hierarchyUnknown', { target: getTargetLabel(target) }),
      };
    }

    if (modRole.position <= targetRole.position) {
      return {
        valid: false,
        error: this.buildHierarchyMessage({
          actor: 'moderator',
          actorRole: modRole,
          targetRole,
          targetLabel: getTargetLabel(target),
          action,
          lang,
        }),
      };
    }

    return { valid: true };
  }

  static validateBotHierarchy(target, action, { lang = 'en' } = {}) {
    if (!target) {
      return { valid: false, error: 'Invalid target' };
    }

    const botMember = target.guild?.members?.me;
    if (!botMember) {
      return { valid: false, error: botText(lang).t('staff.enfCheck.botNotInServer') };
    }

    const botRole = getHighestRole(botMember);
    const targetRole = getHighestRole(target);

    if (!botRole || !targetRole) {
      return {
        valid: false,
        error: botText(lang).t('staff.enfCheck.hierarchyUnknown', { target: getTargetLabel(target) }),
      };
    }

    if (botRole.position <= targetRole.position) {
      return {
        valid: false,
        error: this.buildHierarchyMessage({
          actor: 'bot',
          actorRole: botRole,
          targetRole,
          targetLabel: getTargetLabel(target),
          action,
          lang,
        }),
      };
    }

    return { valid: true };
  }

  /** Bot first, then the moderator; the refusal in `lang` (expected: a user error, not a bug). */
  static assertModerationHierarchy(moderator, target, action, { lang = 'en' } = {}) {
    const botCheck = this.validateBotHierarchy(target, action, { lang });
    if (!botCheck.valid) {
      throw new TitanBotError(botCheck.error, ErrorTypes.PERMISSION, botCheck.error, { expected: true });
    }

    const modCheck = this.validateHierarchy(moderator, target, action, { lang });
    if (!modCheck.valid) {
      throw new TitanBotError(modCheck.error, ErrorTypes.PERMISSION, modCheck.error, { expected: true });
    }
  }
}

