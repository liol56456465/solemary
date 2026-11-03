#!/usr/bin/env node
// PostToolUse: after Claude edits or writes a .js/.mjs/.cjs file inside the project, run
// `node --check` on it (CLAUDE.md: "Syntax check changed files"). Only parses, never runs
// the file. Exit 2 = syntax error, shown to Claude so it fixes it; otherwise silent.

import { execFileSync } from 'node:child_process';
import path from 'node:path';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
    let call;
    try {
        call = JSON.parse(input);
    } catch {
        process.exit(0); // nothing to check; never block on our own parse problem
    }
    const file = call.tool_input?.file_path;
    const root = process.env.CLAUDE_PROJECT_DIR || call.cwd || process.cwd();
    if (typeof file !== 'string' || !/\.(m|c)?js$/.test(file)) process.exit(0);
    const rel = path.relative(root, path.resolve(root, file));
    if (rel.startsWith('..') || path.isAbsolute(rel) || rel.split(path.sep).includes('node_modules')) process.exit(0);
    try {
        execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 15000 });
    } catch (error) {
        const detail = error.stderr?.toString().trim() || error.message;
        process.stderr.write(`node --check failed for ${rel}:\n${detail}\n`);
        process.exit(2);
    }
    process.exit(0);
});
