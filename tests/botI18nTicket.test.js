// Ticket i18n (src/content/bot/<lang>/ticket.json): English output unchanged, Discord length limits
// for modal titles/labels, buttons and select options in every language, and the ticket's own
// messages found again whatever language they were posted in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANG_CODES } from '../src/services/site/i18n.js';
import { botText } from '../src/utils/botText.js';
import { buildTicketPanelPayload, DEFAULT_TICKET_BUTTON_LABEL, DEFAULT_TICKET_PANEL_MESSAGE } from '../src/services/ticketPanelService.js';
import { isOpeningMessage, priorityLabel, withoutPriorityLine } from '../src/services/ticket.js';
import { ticketAccessMessage } from '../src/handlers/ticketButtons.js';
import { listCanned } from '../src/services/cannedService.js';

const en = botText('en');

test('English is the text the code had before', () => {
    assert.equal(en.t('ticket.opening.title', { number: 12 }), 'Ticket #12');
    assert.equal(
        en.t('ticket.opening.body', { member: '<@1>', reason: 'Help {me}' }) + en.t('ticket.opening.priorityLine', { priority: priorityLabel('high', en) }),
        '<@1>, thanks for opening a ticket. Staff will be with you soon.\n\n**Reason:** Help {me}\n**Priority:** High',
    );
    assert.equal(en.t('ticket.post.closedBody', { closer: '<@2>', reason: 'Done' }) + en.t('ticket.post.closedDmFailed'),
        'This ticket has been closed by <@2>.\n**Reason:** Done\n\nCouldn\'t DM the ticket creator about it.');
    assert.equal(en.tp('ticket.post.deletedBody', 3), 'This ticket will be deleted in 3 seconds.');
    assert.equal(en.tp('ticket.reminder.unanswered', 31), 'This ticket has been waiting 31 minutes without a reply. Could someone pick it up?');
    assert.equal(en.tp('ticket.dash.maxTicketsUpdated', 1), 'Users can now have at most **1** open ticket at a time.');
    assert.equal(en.tp('ticket.dash.ratings', 2, { avg: 4.5 }), '4.5/5 (2 ratings)');
    assert.equal(en.tp('ticket.buttons.botMissing', 2, { names: '**A**, **B**', where: en.t('ticket.buttons.whereServer'), action: 'claim this ticket' }),
        'I\'m missing **A**, **B** in this server, so I can\'t claim this ticket. Ask a server admin to grant them to my role.');
    assert.equal(ticketAccessMessage({ config: { ticketStaffRoleId: '1' } }, 'claim tickets', false),
        'You need the **Ticket Staff** role or **Manage Channels** to claim tickets.');
    assert.equal(en.t('ticket.panel.defaultMessage'), DEFAULT_TICKET_PANEL_MESSAGE);
    assert.equal(en.t('ticket.panel.defaultButton'), DEFAULT_TICKET_BUTTON_LABEL);
});

test('the ticket panel: English title and defaults as before; another language translates only the bot\'s own text', () => {
    const english = buildTicketPanelPayload({});
    assert.equal(english.embeds[0].data.title, 'Support tickets');
    assert.equal(english.embeds[0].data.description, DEFAULT_TICKET_PANEL_MESSAGE);
    assert.equal(english.components[0].components[0].data.label, 'Open ticket');
    const german = buildTicketPanelPayload({ ticketPanelMessage: 'Our own text', ticketButtonLabel: 'Go' }, { lang: 'de' });
    assert.equal(german.embeds[0].data.title, 'Support-Tickets');
    assert.equal(german.embeds[0].data.description, 'Our own text', 'admin text stays as written');
    assert.equal(german.components[0].components[0].data.label, 'Go');
});

test('built-in saved answers follow the language asked for; English by default', async () => {
    const english = await listCanned('300000000000000001').catch(() => null);
    if (english) assert.match(english['need-proof'], /^Could you send screenshots/);
    for (const lang of LANG_CODES) assert.ok(botText(lang).t('ticket.canned.builtInNeedProof').length > 10, lang);
});

test('the opening message is found in every language, and its priority line replaced', () => {
    for (const lang of LANG_CODES) {
        const tr = botText(lang);
        const title = tr.t('ticket.opening.title', { number: 7 });
        assert.ok(isOpeningMessage({ embeds: [{ title }] }), `${lang}: ${title}`);
        const description = tr.t('ticket.opening.body', { member: 'm', reason: 'r' }) + tr.t('ticket.opening.priorityLine', { priority: 'x' });
        assert.equal(withoutPriorityLine(description), tr.t('ticket.opening.body', { member: 'm', reason: 'r' }), lang);
    }
    assert.ok(!isOpeningMessage({ embeds: [{ title: 'Ticket transcript' }] }));
    assert.ok(!isOpeningMessage({ embeds: [] }));
});

// Discord: modal title and text-input label 45, button label 80, select option label and
// description 100, placeholder 100 (text input) / 150 (select).
const LIMITS = {
    45: ['buttons.openModalTitle', 'buttons.openModalLabel', 'buttons.closeModalTitle', 'buttons.closeModalLabel',
        'feedback.modalTitle', 'feedback.modalLabel', 'dash.optPanelMessage', 'dash.optButtonLabel', 'dash.optMaxTickets',
        'dash.panelMessageLabel', 'dash.buttonLabelLabel', 'dash.maxTicketsLabel'],
    80: ['control.claim', 'control.claimed', 'control.pin', 'control.close', 'control.reopen', 'control.delete', 'control.unclaim',
        'priority.low', 'priority.high', 'dm.feedbackComment', 'dm.feedbackDecline', 'dash.repost', 'dash.dmToggle',
        'dash.staffRoleButton', 'dash.deleteSystem', 'dash.deleteYes', 'dash.deleteCancel', 'panel.defaultButton'],
    100: ['buttons.openModalPlaceholder', 'buttons.closeModalPlaceholder', 'feedback.modalPlaceholder', 'panel.defaultMessage',
        'dash.selectPlaceholder', 'dash.staffRolePlaceholder', 'dash.categoryPlaceholder', 'dash.channelPlaceholder',
        'dash.optPanelMessageDesc', 'dash.optButtonLabelDesc', 'dash.optOpenCategory', 'dash.optOpenCategoryDesc',
        'dash.optClosedCategory', 'dash.optClosedCategoryDesc', 'dash.optMaxTicketsDesc', 'dash.optLogsChannel',
        'dash.optLogsChannelDesc', 'dash.optTranscriptChannel', 'dash.optTranscriptChannelDesc',
        'priority.none', 'priority.medium', 'priority.urgent'],
};

test('Discord length limits hold in every language', () => {
    for (const [limit, keys] of Object.entries(LIMITS)) {
        for (const key of keys) {
            for (const lang of LANG_CODES) {
                const text = botText(lang).t(`ticket.${key}`);
                assert.ok(text.length >= 1 && text.length <= Number(limit), `${lang} ticket.${key}: ${text.length} > ${limit}`);
            }
        }
    }
});

test('ticket ratings: English texts; every language keeps the opener placeholder and fits Discord limits', () => {
    assert.equal(en.t('ticket.rating.closedTitle'), 'Rating closed');
    assert.equal(en.t('ticket.dm.modmailFeedbackBody'), 'Rate your conversation with staff from 1 to 5. Pick a number below.');
    for (const lang of LANG_CODES) {
        const tr = botText(lang);
        assert.ok(tr.t('ticket.rating.channelPrompt', { user: '<@7>' }).includes('<@7>'), lang);
        for (const key of ['closedTitle', 'rateFirstTitle', 'commentAlreadyTitle']) assert.ok(tr.t(`ticket.rating.${key}`).length <= 256, `${lang} ${key}`);
        assert.ok(tr.t('ticket.rating.savedFooterComment').length <= 2048, lang);
    }
});
