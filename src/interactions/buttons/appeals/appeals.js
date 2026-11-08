import { handleAppealButton } from '../../../handlers/appealsHandler.js';

// opensModal: "open" and "report" answer with a form (exempt from the safety net).
export default { name: 'appeal', execute: handleAppealButton, opensModal: (interaction, [step] = []) => step === 'open' || step === 'report' };
