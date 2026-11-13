import { handleQuarantineBanModal } from '../../../handlers/quarantineRelease.js';

// qban:<guildId>:<userId> — the Ban reason form of a quarantine alert (handlers/quarantineRelease.js).
export default { name: 'qban', execute: handleQuarantineBanModal };
