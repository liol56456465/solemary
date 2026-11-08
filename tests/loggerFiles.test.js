import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logger, resolveLogToFile } from '../src/utils/logger.js';

test('LOG_TO_FILE: explicit value wins; unset → on, except NODE_ENV=test and node --test', () => {
    assert.equal(resolveLogToFile({ nodeEnv: 'production' }), true);
    assert.equal(resolveLogToFile({ nodeEnv: 'development' }), true);
    assert.equal(resolveLogToFile({ nodeEnv: 'test' }), false);
    assert.equal(resolveLogToFile({ nodeEnv: 'production', underTestRunner: true }), false);
    assert.equal(resolveLogToFile({ nodeEnv: 'production', logToFile: 'false' }), false);
    assert.equal(resolveLogToFile({ nodeEnv: 'test', logToFile: 'true' }), true);
    assert.equal(resolveLogToFile({ nodeEnv: 'production', logToFile: ' TRUE ' }), true);
});

test('under node --test the logger writes no files and does not exit on errors', () => {
    const fileTransports = logger.transports.filter((t) => t.constructor?.name === 'DailyRotateFile');
    assert.equal(fileTransports.length, 0);
    assert.equal(logger.exitOnError, false);
});
