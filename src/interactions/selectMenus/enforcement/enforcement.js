import { handleEnforcementSelect } from '../../../handlers/enforcementPanel.js';

// opensModal: picking a reason or a warn answers with a form (exempt from the safety net).
export default {
  name: 'enfsel',
  execute: handleEnforcementSelect,
  opensModal: (interaction, [step] = []) => step === 'reason' || step === 'warn',
};
