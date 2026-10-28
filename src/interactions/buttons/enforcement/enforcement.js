import { handleEnforcementButton } from '../../../handlers/enforcementPanel.js';
import { handleBackgroundButton } from '../../../handlers/backgroundView.js';
import { handleCaseSearchButton } from '../../../handlers/caseSearchView.js';

export default [
  { name: 'enf', execute: handleEnforcementButton },
  { name: 'bg', execute: handleBackgroundButton },
  { name: 'csearch', execute: handleCaseSearchButton },
];
