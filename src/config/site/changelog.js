// changelog.js: what changed in Mewvo, newest first, for the website's /changelog page.
// Written by hand in plain words for members and staff; internal fixes are left out.
// Add a new entry at the top: { date: 'YYYY-MM-DD', items: ['...'] }.

export const CHANGELOG = Object.freeze([
    {
        date: '2026-11-01',
        items: [
            'Custom automod rules: add your own words and phrases to block, with /automod custom or on the dashboard. You can change the words of a rule later. Part of the Normal, Pro and Max plans.',
            '/remind: set a reminder for yourself. Mewvo sends it to you in a DM, or in the channel if your DMs are closed.',
            '/profile: your level, rank, next role reward, birthday and plan on one card.',
            '/appeal status: see your appeals and whether someone on staff is looking at them.',
            'Punishment DMs can link to My record, where you see your full record on the website.',
            'Dashboard: the Overview page starts with a short getting-started list, and every settings page explains its options in plain words.',
            'Dashboard: an Activity page with messages, joins and cases per day for the last 30 days.',
            'Dashboard: a settings backup you can download and load back after a check.',
            'Dashboard: private staff notes and tags on cases, actions on many cases at once, and saved searches.',
            'Dashboard: a note for the next staff shift on the Overview page.',
            'A weekly summary of the server in the mod log every Monday.',
            'Pro and Max: Mewvo can use its own nickname and avatar in your server, and staff can download cases as a spreadsheet.',
            'Dashboard themes: Light, Dark, Dim and High contrast.',
        ],
    },
    {
        date: '2026-10-31',
        items: [
            'Privacy Policy and Terms and Conditions.',
            'My record: download all the data Mewvo has about you as a file.',
            'Paid plans now do something: supporter roles, /premium, gifts and redeem keys.',
        ],
    },
    {
        date: '2026-10-29',
        items: [
            'The bot is now called Mewvo (it was Meowist).',
            'Server rules on the website. Punishment DMs name the rule that was broken and link to it.',
            'Appeals are decided by someone other than the moderator who gave the punishment.',
            'My record on the website: members can see their own moderation record.',
            'Scheduled and repeating messages from the dashboard.',
            'Dashboard: an Inbox for appeals, tickets, modmail and automod reviews, with replies from the web.',
            'Website pages for the leaderboard, status, features, pricing, docs and FAQ.',
        ],
    },
    {
        date: '2026-10-28',
        items: [
            'Dashboard: a Members page with filters, roles, nicknames and timeouts, also for many members at once.',
            'Temporary roles that are taken away by themselves after a set time.',
            'Dashboard: a Banned page with everyone who is banned and why.',
            'Dashboard: purge, lock and unlock channels, and post messages, polls and countdowns as the bot.',
            'Ban and kick appeals talk with the member in the support server.',
            'Mutes count toward the limit that stops one moderator from punishing many people in a short time.',
        ],
    },
]);
