// roleSafety.js — checks for roles the bot hands out on its own (reaction roles,
// level rewards, autorole, verification). Such roles must never carry staff powers,
// because anyone who clicks, chats or joins ends up with them.

export const DANGEROUS_ROLE_PERMISSIONS = [
    'Administrator',
    'ManageGuild',
    'ManageRoles',
    'ManageChannels',
    'ManageWebhooks',
    'BanMembers',
    'KickMembers',
    'ModerateMembers',
    'ManageMessages',
    'ManageNicknames',
    'ManageThreads',
    'MentionEveryone',
    'MuteMembers',
    'DeafenMembers',
    'MoveMembers',
    'ViewAuditLog',
    'ManageEvents',
    'ManageGuildExpressions',
];

/** The dangerous permissions this role grants (empty when none). */
export function getDangerousPermissions(role) {
    if (!role?.permissions?.has) return [];
    return DANGEROUS_ROLE_PERMISSIONS.filter((permission) => role.permissions.has(permission));
}

export function hasDangerousPermissions(role) {
    return getDangerousPermissions(role).length > 0;
}

/**
 * Why the bot must not hand out this role automatically, or null when it is safe.
 * botMember is guild.members.me; without it the hierarchy cannot be checked, so it fails closed.
 */
export function getRoleAssignmentProblem(role, botMember) {
    if (!role) {
        return 'That role no longer exists.';
    }
    if (role.id === role.guild?.id) {
        return 'The @everyone role cannot be used here.';
    }
    if (role.managed) {
        return `**${role.name}** is managed by an integration or bot and cannot be assigned.`;
    }
    const dangerous = getDangerousPermissions(role);
    if (dangerous.length > 0) {
        return `**${role.name}** has staff permissions (${dangerous.join(', ')}), so it cannot be handed out automatically.`;
    }
    const botHighest = botMember?.roles?.highest;
    if (!botHighest || role.position >= botHighest.position) {
        return `**${role.name}** is not below my highest role, so I cannot assign it.`;
    }
    return null;
}
