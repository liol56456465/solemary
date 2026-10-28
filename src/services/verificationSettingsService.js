// verificationSettingsService.js — atomic reads/writes of guildConfig.verification.
// Used by the /verification commands and the web dashboard; every write runs under
// the guild-config row lock, so concurrent edits of different fields both survive.

import { z } from 'zod';
import { getGuildConfig } from './config/guildConfig.js';
import { validateAutoVerifyCriteria } from './verificationService.js';
import { updateGuildConfigAtomic } from '../utils/database/guildConfigStorage.js';
import { nullableSnowflake, parseSettingsPatch, snowflake, stripUndefined, trimmedText } from '../utils/settingsValidation.js';

const LABELS = {
    enabled: 'Verification enabled',
    channelId: 'Verification channel',
    messageId: 'Verification panel message',
    roleId: 'Verified role',
    message: 'Verification message',
    buttonText: 'Button text',
    autoVerify: 'Auto-verify',
    'autoVerify.enabled': 'Auto-verify enabled',
    'autoVerify.criteria': 'Auto-verify criteria',
    'autoVerify.accountAgeDays': 'Account age (days)',
    'autoVerify.roleId': 'Auto-verify role',
    'autoVerify.configuredVia': 'Auto-verify source',
};

const text = (label, max) =>
    z.string({ error: `${label} must be text.` })
        .min(1, `${label} cannot be empty.`)
        .max(max, `${label} must be at most ${max} characters.`);

// Mirrors AutoVerifyConfigSchema in utils/schemas.js, with every field optional.
const AutoVerifyPatchSchema = z.strictObject({
    enabled: z.boolean({ error: `${LABELS['autoVerify.enabled']} must be true or false.` }).optional(),
    criteria: z.enum(['account_age', 'server_size', 'none'], {
        error: `${LABELS['autoVerify.criteria']} must be one of account_age, server_size, none.`,
    }).optional(),
    accountAgeDays: z
        .number({ error: `${LABELS['autoVerify.accountAgeDays']} must be a number.` })
        .int(`${LABELS['autoVerify.accountAgeDays']} must be a whole number.`)
        .min(1, `${LABELS['autoVerify.accountAgeDays']} must be between 1 and 365.`)
        .max(365, `${LABELS['autoVerify.accountAgeDays']} must be between 1 and 365.`)
        .nullable()
        .optional(),
    roleId: nullableSnowflake(LABELS['autoVerify.roleId']).optional(),
    // Written by /verification auto setup; dropped again by the guild config schema.
    configuredVia: z.string().max(32).optional(),
});

// Mirrors VerificationConfigSchema in utils/schemas.js, with every field optional.
const VerificationPatchSchema = z.strictObject({
    enabled: z.boolean({ error: `${LABELS.enabled} must be true or false.` }).optional(),
    channelId: nullableSnowflake(LABELS.channelId).optional(),
    messageId: nullableSnowflake(LABELS.messageId).optional(),
    roleId: snowflake(LABELS.roleId).optional(),
    message: text(LABELS.message, 2000).optional(),
    buttonText: trimmedText(LABELS.buttonText, 80).optional(),
    autoVerify: AutoVerifyPatchSchema.optional(),
});

function parsePatch(schema, patch, guildId) {
    return parseSettingsPatch(schema, patch, {
        service: 'verificationSettingsService',
        labels: LABELS,
        guildId,
    });
}

function cloneVerification(value) {
    return value && typeof value === 'object' ? structuredClone(value) : {};
}

export async function getVerificationSettings(client, guildId) {
    const config = await getGuildConfig(client, guildId);
    return cloneVerification(config.verification);
}

/**
 * Validates `patch` and merges it into guildConfig.verification under the row
 * lock; a nested `autoVerify` patch is merged into the stored autoVerify.
 * Returns { before, after } (verification objects). Throws TitanBotError(VALIDATION).
 */
export async function updateVerificationSettings(client, guildId, patch) {
    const parsed = stripUndefined(parsePatch(VerificationPatchSchema, patch, guildId));
    const autoVerifyPatch = parsed.autoVerify ? stripUndefined(parsed.autoVerify) : null;
    let before;

    const saved = await updateGuildConfigAtomic(client, guildId, (current) => {
        before = cloneVerification(current.verification);
        const next = { ...before, ...parsed };
        if (autoVerifyPatch) {
            const autoVerify = { ...(before.autoVerify || {}), ...autoVerifyPatch };
            if ('criteria' in autoVerifyPatch || 'accountAgeDays' in autoVerifyPatch) {
                validateAutoVerifyCriteria(autoVerify.criteria ?? 'none', autoVerify.accountAgeDays);
            }
            next.autoVerify = autoVerify;
        }
        return { ...current, verification: next };
    }, { operation: 'updateVerificationSettings' });

    return { before, after: cloneVerification(saved?.verification) };
}

/**
 * Replaces guildConfig.verification (only that key) under the row lock; used by
 * /verification setup. Returns { before, after }.
 */
export async function setVerificationSettings(client, guildId, verification) {
    const parsed = stripUndefined(parsePatch(VerificationPatchSchema, verification, guildId));
    let before;
    const saved = await updateGuildConfigAtomic(client, guildId, (current) => {
        before = cloneVerification(current.verification);
        return { ...current, verification: parsed };
    }, { operation: 'setVerificationSettings' });
    return { before, after: cloneVerification(saved?.verification) };
}
