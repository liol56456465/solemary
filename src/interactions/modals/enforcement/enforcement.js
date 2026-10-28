import { handleEnforcementModal } from '../../../handlers/enforcementPanel.js';
import { handleBackgroundNoteModal } from '../../../handlers/backgroundView.js';

export default [
    { name: 'enfmodal', execute: handleEnforcementModal },
    { name: 'bgnote', execute: handleBackgroundNoteModal },
];
