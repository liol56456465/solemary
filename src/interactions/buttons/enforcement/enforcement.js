import { handleEnforcementButton } from '../../../handlers/enforcementPanel.js';
import { handleBackgroundButton } from '../../../handlers/backgroundView.js';

export default [
  { name: 'enf', execute: handleEnforcementButton },
  { name: 'bg', execute: handleBackgroundButton },
];
