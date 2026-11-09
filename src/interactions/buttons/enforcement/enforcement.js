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
    // `unban:ladder` (an automatic ladder ban) first shows a choice, so it is acknowledged normally;
    // its "Unban only" button (unbanonly) is the step that opens the unban form.
    opensModal: (interaction, [step, , , action, extra] = []) => step === 'details' || step === 'unbanonly'
      || (step === 'act' && ENF_MODAL_ACTIONS.has(action) && extra !== 'ladder'),
  },
  { name: 'bg', execute: handleBackgroundButton, opensModal: (interaction, [step] = []) => step === 'noteadd' || step === 'notedel' },
  { name: 'csearch', execute: handleCaseSearchButton },
];
