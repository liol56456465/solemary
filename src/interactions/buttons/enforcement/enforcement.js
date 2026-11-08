import { handleEnforcementButton } from '../../../handlers/enforcementPanel.js';
import { handleBackgroundButton } from '../../../handlers/backgroundView.js';
import { handleCaseSearchButton } from '../../../handlers/caseSearchView.js';

// opensModal: these steps answer with a form, so the 3-second safety net must not
// acknowledge them first (utils/ackSafetyNet.js).
const ENF_MODAL_ACTIONS = new Set(['unban', 'unmute']);

export default [
  {
    name: 'enf',
    execute: handleEnforcementButton,
    opensModal: (interaction, [step, , , action] = []) => step === 'details' || (step === 'act' && ENF_MODAL_ACTIONS.has(action)),
  },
  { name: 'bg', execute: handleBackgroundButton, opensModal: (interaction, [step] = []) => step === 'noteadd' || step === 'notedel' },
  { name: 'csearch', execute: handleCaseSearchButton },
];
