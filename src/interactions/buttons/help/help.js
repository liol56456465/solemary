import {
  helpBackButton,
  helpBugReportButton,
  helpPageButton,
  helpPaginationButton,
  LEGACY_PAGINATION_IDS,
} from '../../../handlers/help/helpButtons.js';

// help-page:<view>:<action>:<page> routes to helpPageButton (customId.split(':')[0]). The old ids
// (help-page_first etc.) stay registered for help messages posted before the page was in the id.
const legacyPaginationInteractions = LEGACY_PAGINATION_IDS.map((name) => ({
  name,
  execute: helpPaginationButton.execute,
}));

export default [helpBackButton, helpBugReportButton, helpPageButton, ...legacyPaginationInteractions];
