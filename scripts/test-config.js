// test-config.js — prints the effective test-mode configuration (token redacted)
// without logging in. Run: npm run test:config
import '../src/config/loadEnv.js';
import { describeTestMode, validateTestMode, testMode } from '../src/config/testMode.js';

console.log(JSON.stringify(describeTestMode(), null, 2));
const errors = validateTestMode();
console.log(errors.length ? `\nPROBLEMS:\n- ${errors.join('\n- ')}` : `\nSafety checks: passed${testMode.enabled ? '' : ' (not in test mode)'}`);
