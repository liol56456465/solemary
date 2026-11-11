// staffRoles.js — the ticket staff roles (tickets, staff reports, modmail, appeal reminders).
// Stored as `ticketStaffRoleIds` (a list, up to MAX_TICKET_STAFF_ROLES). The old single
// `ticketStaffRoleId` is still read when no list was ever saved, and every write keeps it
// equal to the first role in the list, so older code and a rollback still see one role.

export const MAX_TICKET_STAFF_ROLES = 10;

/** The staff role ids for this guild config (de-duplicated, in saved order). */
export function ticketStaffRoleIds(config) {
    const source = Array.isArray(config?.ticketStaffRoleIds)
        ? config.ticketStaffRoleIds
        : [config?.ticketStaffRoleId];
    return [...new Set(source.filter((id) => typeof id === 'string' && id !== ''))];
}

/** True when the member holds at least one of the staff roles. */
export function memberHasTicketStaffRole(member, config) {
    const cache = member?.roles?.cache;
    if (!cache?.has) return false;
    return ticketStaffRoleIds(config).some((id) => cache.has(id));
}

/** "<@&a> <@&b>" for a ping or a display ('' when none). */
export function ticketStaffMentions(config) {
    return ticketStaffRoleIds(config).map((id) => `<@&${id}>`).join(' ');
}
