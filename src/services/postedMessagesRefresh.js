// postedMessagesRefresh.js — rewrites the panels Mewvo already posted in a server, in place
// (edit, never a repost), in the server's current language (owner, 2026-11-10). Runs from the
// dashboard Bot language page ("Refresh posted messages") and after the bot language is saved.
//
// Covered: the verification panel, the ticket panel, the appeal panels (and the Support one for
// the main server), every reaction role panel and the quarantine info message. Text the admins typed (titles, descriptions,
// rules) is kept as typed; only Mewvo's own words change. A public panel is one message for
// everyone, so it follows the server language; each member's own language is used in the
// private replies when they press a button.
//
// Never throws: each part is tried on its own and counted.

import { logger } from '../utils/logger.js';
import { getVerificationSettings } from './verificationSettingsService.js';
import { refreshVerificationPanel } from './verificationPanelService.js';
import { refreshTicketPanel } from './ticketPanelService.js';
import { refreshAppealPanels } from './enforcement/appealPanelService.js';
import { getAllReactionRoleMessages, rebuildLivePanelMessage } from './reactionRoleService.js';
import { refreshQuarantineInfo } from './enforcement/quarantineService.js';

const step = async (name, run) => {
    try {
        return await run();
    } catch (error) {
        logger.warn(`Refresh posted messages (${name}) failed: ${error.message}`);
        return 0;
    }
};

/** @returns {Promise<{ verification: number, tickets: number, appeals: number, reactionRoles: number, quarantineInfo: number, total: number }>} */
export async function refreshPostedMessages(client, guild, deps = {}) {
    const {
        verification = async () => Number(await refreshVerificationPanel(guild, await getVerificationSettings(client, guild.id))),
        tickets = async () => Number(await refreshTicketPanel(client, guild)),
        appeals = () => refreshAppealPanels(client, guild),
        reactionRoles = async () => {
            const panels = await getAllReactionRoleMessages(client, guild.id);
            for (const panel of panels) await rebuildLivePanelMessage(guild, { ...panel, roles: Array.isArray(panel.roles) ? panel.roles : Object.values(panel.roles || {}) });
            return panels.length;
        },
        quarantineInfo = () => refreshQuarantineInfo(client, guild),
    } = deps;
    const result = {
        verification: await step('verification', verification),
        tickets: await step('tickets', tickets),
        appeals: await step('appeals', appeals),
        reactionRoles: await step('reaction roles', reactionRoles),
        quarantineInfo: await step('quarantine info', quarantineInfo),
    };
    result.total = result.verification + result.tickets + result.appeals + result.reactionRoles + result.quarantineInfo;
    return result;
}
