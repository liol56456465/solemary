import { handleBackupRevert, handleNukeDiff } from '../../../handlers/backupRevert.js';

export default [
    { name: 'nukediff', execute: handleNukeDiff },
    { name: 'backuprevert', execute: handleBackupRevert },
];
