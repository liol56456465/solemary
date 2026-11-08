import { handleLoggingMenuSelect } from '../../../handlers/loggingButtons.js';

export default {
  name: 'log_dash_menu',
  execute: handleLoggingMenuSelect,
  // "set:<destination>" answers with a channel form (exempt from the safety net).
  opensModal: (interaction) => String(interaction.values?.[0] || '').startsWith('set:'),
};
