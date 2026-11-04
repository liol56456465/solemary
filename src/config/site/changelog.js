// changelog.js: what changed in Mewvo, newest first, for the website's /changelog page.
// Written by hand in plain words for members and staff; internal fixes are left out.
// The text lives in src/content/site/<lang>/changelog.json under entries.<date>.<item>; this list
// only keeps the order. Add a new entry at the top: { date: 'YYYY-MM-DD', items: ['itemKey', ...] }
// and its text in en/changelog.json.

export const CHANGELOG = Object.freeze([
    {
        date: '2026-11-01',
        items: ['customAutomodRules', 'remind', 'profile', 'appealStatus', 'recordLinkInDms', 'gettingStartedList', 'activityPage', 'settingsBackup', 'caseNotesAndTags', 'shiftNote', 'weeklySummary', 'proMaxBranding', 'dashboardThemes'],
    },
    {
        date: '2026-10-31',
        items: ['legalPages', 'dataDownload', 'paidPlans'],
    },
    {
        date: '2026-10-29',
        items: ['rename', 'serverRules', 'independentAppeals', 'myRecord', 'scheduledMessages', 'inbox', 'websitePages'],
    },
    {
        date: '2026-10-28',
        items: ['membersPage', 'temporaryRoles', 'bannedPage', 'channelTools', 'appealsInSupportServer', 'mutesInMassGuard'],
    },
]);

/** The catalog key of one changelog item. */
export const changelogKey = (date, item) => `changelog.entries.${date}.${item}`;
