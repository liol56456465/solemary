// welcome.js

import { logger } from './logger.js';

const DEFAULT_TEMPLATES = {
    welcome: 'Welcome to {server}, {user}.',
    goodbye: '{user.tag} left the server.'
};

function replaceAll(message, token, value) {
    if (value === undefined || value === null) {
        return message;
    }
    return message.split(token).join(String(value));
}

export function truncateForEmbedField(value, maxLength = 1024) {
    const text = String(value ?? '').trim();
    if (!text) {
        return '-';
    }
    return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

/**
 * {inviter} (a mention), {inviter.name}, {invite.code}, {inviter.invites} from an invite
 * attribution ({ inviterId, inviterName, code, inviterInvites }); pure.
 */
export function inviteTokens(invite, fallback = {}) {
    const someone = fallback?.inviter || 'someone';
    const aLink = fallback?.code || 'a link';
    const inviterId = invite?.inviterId && /^\d{17,20}$/.test(String(invite.inviterId)) ? String(invite.inviterId) : null;
    const code = typeof invite?.code === 'string' ? invite.code.replace(/[^\w-]/g, '').slice(0, 32) : '';
    // Names in a message: no Discord markup or mentions from the name itself.
    const name = typeof invite?.inviterName === 'string' ? invite.inviterName.replace(/[\\*_~`|<>@#{}]/g, '').slice(0, 64) : '';
    return {
        '{inviter}': inviterId ? `<@${inviterId}>` : someone,
        '{inviter.name}': name || someone,
        '{invite.code}': code || aLink,
        '{inviter.invites}': inviterId && Number.isFinite(invite?.inviterInvites) ? String(invite.inviterInvites) : '0',
    };
}

export function formatWelcomeMessage(message, data) {
    
    if (typeof message !== 'string') return '';
    if (!message) return '';
    if (!data || typeof data !== 'object') return message;

    const user = data?.user;
    const guild = data?.guild;

    if (!user || typeof user !== 'object') {
        logger.warn('Invalid user object passed to formatWelcomeMessage');
    }
    if (!guild || typeof guild !== 'object') {
        logger.warn('Invalid guild object passed to formatWelcomeMessage');
    }

    const tokens = {
        '{user}': user?.toString?.() || 'User',
        '{user.mention}': user?.toString?.() || 'User',
        '{user.tag}': user?.tag || 'Unknown#0000',
        '{user.username}': user?.username || 'Unknown',
        '{username}': user?.username || 'Unknown',
        '{user.discriminator}': user?.discriminator || '0000',
        '{user.id}': user?.id || 'unknown',
        '{server}': guild?.name || 'Server',
        '{server.name}': guild?.name || 'Server',
        '{guild.name}': guild?.name || 'Server',
        '{guild.id}': guild?.id || 'unknown',
        '{guild.memberCount}': guild?.memberCount?.toString?.() || '0',
        '{memberCount}': guild?.memberCount?.toString?.() || '0',
        '{membercount}': guild?.memberCount?.toString?.() || '0',
        // Invite tracking (services/invites/inviteTracker.js; only filled where it is on). Last, so
        // a member's name can't smuggle in another placeholder. Unknown: the caller's words for
        // "someone" / "a link" (data.inviteFallback, in the post's language), else English.
        ...inviteTokens(data?.invite, data?.inviteFallback)
    };

    let result = message;
    for (const [token, value] of Object.entries(tokens)) {
        if (value === undefined || value === null) continue;
        result = replaceAll(result, token, String(value));
    }

    return result;
}

export function getDefaultWelcomeMessage() {
    return DEFAULT_TEMPLATES.welcome;
}

export function getDefaultGoodbyeMessage() {
    return DEFAULT_TEMPLATES.goodbye;
}