// rulesLibrary.js — ready-made server rules for the dashboard Rules page ("Add from the
// library"). Each entry is a normal rule once added (title, text, consequence; editable and
// deletable like any other) plus `preset` = its key here, so the page can grey out the ones
// already added. `reason` is the prebuilt /enforcements reason (config/enforcement.js) the
// rule is linked to on add, when that reason is not linked to another rule yet.
//
// The consequence is only text: it is shown in the posted rules, on /rules and as a hint in
// the /enforcements confirm step. It never punishes anyone by itself.

export const RULES_LIBRARY = Object.freeze([
    { key: 'respect', title: 'Be respectful', reason: 'harassment', consequence: 'Warning',
        text: 'Treat everyone with respect. No insults, name-calling or starting fights.' },
    { key: 'swearing', title: 'No swearing or cussing', reason: 'slurs', consequence: '1-hour mute',
        text: 'Keep the language clean. Swearing, cussing and crude words are not allowed, also not with symbols or misspellings.' },
    { key: 'hate', title: 'No hate speech or slurs', reason: 'slurs', consequence: 'Permanent ban',
        text: 'No slurs or attacks on anyone for their race, religion, nationality, gender, sexuality or disability. Not even as a joke.' },
    { key: 'harassment', title: 'No harassment', reason: 'harassment', consequence: '24-hour mute, then a ban',
        text: 'Do not bully, threaten, stalk or keep messaging someone who asked you to stop, here or in DMs.' },
    { key: 'spam', title: 'No spam', reason: 'spam', consequence: 'Warning',
        text: 'No message floods, walls of emoji, repeated messages or mass mentions.' },
    { key: 'advertising', title: 'No advertising', reason: 'advertising', consequence: 'Warning',
        text: 'No server invites, self-promotion or ads, in channels or in DMs to members, unless staff allowed it.' },
    { key: 'nsfw', title: 'No NSFW content', reason: 'nsfw', consequence: 'Permanent ban',
        text: 'No sexual, gory or shocking content anywhere: messages, images, names, avatars or status.' },
    { key: 'doxxing', title: 'No sharing personal information', reason: 'harassment', consequence: 'Permanent ban',
        text: 'Never share anyone\'s real name, address, photos, phone number or other private details without their permission.' },
    { key: 'scams', title: 'No scams or phishing', reason: 'scamming', consequence: 'Permanent ban',
        text: 'No fake giveaways, phishing links, account trading or anything meant to trick members.' },
    { key: 'raiding', title: 'No raiding', reason: 'raiding', consequence: 'Permanent ban',
        text: 'Do not organise or take part in raids, here or on other servers.' },
    { key: 'channels', title: 'Use the right channels', reason: null, consequence: 'Warning',
        text: 'Post in the channel that fits the topic. Read the channel description first.' },
    { key: 'impersonation', title: 'No impersonation', reason: null, consequence: 'Permanent ban',
        text: 'Do not pretend to be staff, a bot or another member, with your name, avatar or messages.' },
    { key: 'tos', title: 'Follow the Discord rules', reason: null, consequence: 'Permanent ban',
        text: 'Follow the Discord Terms of Service and Community Guidelines (discord.com/guidelines). You must be at least 13.' },
    { key: 'staff', title: 'Listen to staff', reason: 'staff_disrespect', consequence: 'Warning',
        text: 'Follow what moderators ask. If you disagree, talk to them calmly in a ticket, not in public chat.' },
].map((entry) => Object.freeze(entry)));

export function libraryRule(key) {
    return RULES_LIBRARY.find((entry) => entry.key === key) || null;
}
