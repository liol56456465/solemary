// emailSender.js — sends the account emails (confirm, reset, notices) through Resend's
// HTTPS API (https://api.resend.com/emails). Injectable for tests (createFakeEmailSender).
//
// Without RESEND_API_KEY nothing is sent: the sender only logs "email to j***@example.com:
// <subject>". The body is never logged, because the links in it are secrets.

import { logger as defaultLogger } from '../../utils/logger.js';
import { maskEmail } from './accountCore.js';

const RESEND_URL = 'https://api.resend.com/emails';
const TIMEOUT_MS = 10000;

/** { apiKey, from } from env. `from` like "Mewvo <no-reply@mewvo.com>". */
export function emailSettings(env = process.env) {
    return {
        apiKey: String(env.RESEND_API_KEY || '').trim(),
        from: String(env.EMAIL_FROM || '').trim(),
    };
}

/**
 * send({ to, subject, text, html }) → { sent: boolean }. Throws only when Resend refuses or
 * cannot be reached (the caller decides what to tell the person).
 */
export function createEmailSender({ apiKey = '', from = '', fetchImpl = globalThis.fetch, logger = defaultLogger } = {}) {
    const live = Boolean(apiKey && from);
    async function send({ to, subject, text, html }) {
        if (!live) {
            logger.info(`Email to ${maskEmail(to)}: ${subject} (not sent: RESEND_API_KEY or EMAIL_FROM is not set)`);
            return { sent: false };
        }
        const response = await fetchImpl(RESEND_URL, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from, to: [to], subject, text, ...(html ? { html } : {}) }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`Resend answered ${response.status}`);
        logger.info(`Email sent to ${maskEmail(to)}: ${subject}`);
        return { sent: true };
    }
    return { send, live };
}

/** For tests: keeps every email in `sent`. */
export function createFakeEmailSender() {
    const sent = [];
    return {
        sent,
        live: true,
        async send(message) {
            sent.push(message);
            return { sent: true };
        },
        last: () => sent[sent.length - 1] || null,
    };
}
