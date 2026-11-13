import { handleQuarantineDecision, handleQuarantineRelease } from '../../../handlers/quarantineRelease.js';

// Quarantine alert buttons (enforcement/quarantineService.js, handlers/quarantineRelease.js):
// qdecide:<release|kick|kickok|cancel|ban|keep>:<guildId>:<userId>, and qrelease (first alerts).
// opensModal: Ban answers with its reason form, so the 3-second safety net must not ack it first.
export default [
    { name: 'qdecide', execute: handleQuarantineDecision, opensModal: (interaction, [step] = []) => step === 'ban' },
    { name: 'qrelease', execute: handleQuarantineRelease },
];
