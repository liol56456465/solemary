// enforcementData.js — every enforcement function the dashboard's records and action
// pages call (Phase 3), in one object so tests can replace any of them
// (createDashboard({ enforcement })). These are the SAME functions the /enforcements
// panel, /case, /appeals, /background, /staff and the appeal buttons use.

import { executeAction, getLadder, getTargetState } from '../enforcement/enforcementService.js';
import {
    getAppealHistory, getCaseByCode, getCountedWarns, getLatestAppealStatuses, listCasesForUser,
} from '../enforcement/caseService.js';
import { editCase, voidCase } from '../enforcement/caseEditService.js';
import { addEvidence, addImageEvidence, captureLinks, listEvidence, removeEvidence, resolveImageUrls } from '../enforcement/evidenceService.js';
import { decideAppeal } from '../enforcement/appealService.js';
import { precedentHint } from '../enforcement/precedentService.js';
import {
    addNoContactOrder, endNoContactOrder, getActiveOrdersFor, listActiveNoContactOrders,
} from '../enforcement/noContactService.js';
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

export const defaultEnforcement = {
    // members and standing
    memberStandings, activeBanCases, addTempRole, endTempRole, listTempRoles, removeVerification, getTargetState, getLadder, getCountedWarns, listCasesForUser, getLatestAppealStatuses, getActiveOrdersFor,
    listNotes, addNote, removeNote, precedentHint,
    // actions (same flow builder and executeAction as the panel)
    completeFlowDetails, executeAction, attachFlowEvidence, getMassActionBlock, recentBanKickCount,
    // cases
    getCaseByCode, getAppealHistory, editCase, voidCase, addEvidence, addImageEvidence, removeEvidence, captureLinks, listEvidence, resolveImageUrls,
    // appeals
    decideAppeal,
    // no-contact orders
    listActiveNoContactOrders, addNoContactOrder, endNoContactOrder,
    // staff
    listMassActionBlocks, clearMassActionBlock, loadCoverageCounts, getGuildConfig, isBotOwner,
    staffActivityForWeek, giveStaffWarning, listStaffWarnings, restoreStaffRoles, listRemovedStaffRoles,
};
