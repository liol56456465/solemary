import { handleBackupRevert, handleNukeDiff, handleNukePanic, handleNukeRevert } from '../../../handlers/backupRevert.js';

export default [
    { name: 'nukediff', execute: handleNukeDiff },
    { name: 'nukerevert', execute: handleNukeRevert },
    { name: 'nukepanic', execute: handleNukePanic },
    { name: 'backuprevert', execute: handleBackupRevert },
];
