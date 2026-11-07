// The /jointocreate config settings modal (name template, user limit, bitrate).
import { handleSettingsModalSubmit, MODAL_PREFIX } from '../../../commands/JoinToCreate/modules/settingsModal.js';

export default { name: MODAL_PREFIX, execute: (interaction, client) => handleSettingsModalSubmit(interaction, client) };
