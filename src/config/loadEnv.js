// loadEnv.js — must be the first import of every entry point.
//
// `node --env-file=<file> …` (the :test npm scripts use ~/.config/mewvo/env.test) loads
// that file natively. In that case .env is NOT read at all, so a key missing from the
// test file can never fall back to a production value (for example the production bot
// token). Without --env-file, a ./.env is loaded if one exists (self-hosting); the owner's
// local secrets live outside the repo, so on that machine nothing is loaded.

import dotenv from 'dotenv';

export const usesExplicitEnvFile = process.execArgv.some((arg) => arg.startsWith('--env-file'));

if (!usesExplicitEnvFile) {
    dotenv.config();
}
