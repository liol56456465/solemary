// loadEnv.js — must be the first import of every entry point.
//
// `node --env-file=.env.test …` loads the test environment natively. In that
// case .env is NOT read at all, so a key missing from .env.test can never fall
// back to a production value (for example the production bot token).

import dotenv from 'dotenv';

export const usesExplicitEnvFile = process.execArgv.some((arg) => arg.startsWith('--env-file'));

if (!usesExplicitEnvFile) {
    dotenv.config();
}
