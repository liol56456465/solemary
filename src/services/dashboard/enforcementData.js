// enforcementData.js — every enforcement function the dashboard's records and action
// pages call (Phase 3), in one object so tests can replace any of them
// (createDashboard({ enforcement })). These are the SAME functions the /enforcements
// panel, /case, /appeals, /background, /staff and the appeal buttons use.

import { executeAction, getLadder, getTargetState } from '../enforcement/enforcementService.js';
import {
    getAppealHistory, getCaseByCode, getCountedWarns, getLatestAppealStatuses, getUncountedWarns, listCasesForUser,
} from '../enforcement/caseService.js';
import { editCase, voidCase } from '../enforcement/caseEditService.js';
import { caseNotes } from '../enforcement/caseNotesService.js';
import { memberTimeline } from '../members/memberTimeline.js';
import { addEvidence, addImageEvidence, captureLinks, listEvidence, removeEvidence, resolveImageUrls } from '../enforcement/evidenceService.js';
import { decideAppeal } from '../enforcement/appealService.js';
import { precedentHint } from '../enforcement/precedentService.js';
import {
    addNoContactOrder, endNoContactOrder, getActiveOrdersFor, listActiveNoContactOrders,
} from '../enforcement/noContactService.js';
import { endWatch, listActiveWatches } from '../enforcement/watchlistService.js';
import { clearMassActionBlock, getMassActionBlock, listMassActionBlocks, recentBanKickCount } from '../enforcement/massActionGuard.js';
import { addNote, listNotes, removeNote } from '../enforcement/staffNotesService.js';
import { memberStandings } from './membersData.js';
import { activeBanCases } from './bansData.js';
import { addTempRole, endTempRole, listTempRoles } from '../members/tempRoleService.js';
import { attachFlowEvidence, completeFlowDetails } from '../enforcement/flowBuilder.js';
import { loadCoverageCounts } from '../staffCoverageService.js';
import { staffActivityForWeek } from '../staffActivityService.js';
import { giveStaffWarning, listRemovedStaffRoles, listStaffWarnings, restoreStaffRoles } from '../automod/staffGuardService.js';
import { getGuildConfig } from '../config/guildConfig.js';
import { removeVerification } from '../verificationService.js';
import { isBotOwner } from '../../config/bot.js';
import { hasOwnerPower } from '../../utils/ownerPower.js';
import { decideQuarantine, getQuarantine, isQuarantineDecider, quarantineMember, quarantineReady, releaseQuarantine } from '../enforcement/quarantineService.js';

export const defaultEnforcement = {
    // members and standing
    memberStandings, activeBanCases, addTempRole, endTempRole, listTempRoles, removeVerification, getTargetState, getLadder, getCountedWarns, getUncountedWarns, listCasesForUser, getLatestAppealStatuses, getActiveOrdersFor,
    listNotes, addNote, removeNote, precedentHint,
    // actions (same flow builder and executeAction as the panel)
    completeFlowDetails, executeAction, attachFlowEvidence, getMassActionBlock, recentBanKickCount,
    // cases
    getCaseByCode, getAppealHistory, editCase, voidCase, addEvidence, addImageEvidence, removeEvidence, captureLinks, listEvidence, resolveImageUrls,
    addCaseNote: (...args) => caseNotes.addNote(...args), setCaseTags: (...args) => caseNotes.setTags(...args),
    memberTimeline,
    // appeals
    decideAppeal,
    // no-contact orders
    listActiveNoContactOrders, addNoContactOrder, endNoContactOrder,
    // staff watchlist (shown on the No-contact page)
    listActiveWatches, endWatch,
    // staff
    listMassActionBlocks, clearMassActionBlock, loadCoverageCounts, getGuildConfig, isBotOwner,
    // OWNER_IDS override per server: only in Mewvo's own servers (utils/ownerPower.js)
    hasOwnerPower: (userId, guildId) => hasOwnerPower(userId, guildId),
    staffActivityForWeek, giveStaffWarning, listStaffWarnings, restoreStaffRoles, listRemovedStaffRoles,
    // quarantine (member page): the same service as the raid and staff guard triggers and the alert's Release
    getQuarantine, quarantineMember, quarantineReady, releaseQuarantine, decideQuarantine, isQuarantineDecider,
};
