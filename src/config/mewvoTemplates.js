// mewvoTemplates.js — announcement templates for Mewvo's own servers only (main + support,
// isMewvoServer in utils/ownerPower.js). The dashboard Messages page lists them only there, and
// the server refuses their ids anywhere else (messages.js: chosenTemplate and the send/schedule
// actions). /embedbuilder never shows them.
//
// Same shape and voice as config/messageTemplates.js, plus:
//   home: true         only in Mewvo's own servers
//   members: true      the Send form gets a member picker; {mods} becomes the picked members'
//                      mentions when posting, and only those members are pinged
//   changelog: true    {changes} is filled from the website changelog (config/site/changelog.js,
//                      content/site/<lang>/changelog.json), the admin picks which entries
//   serverCount: true  {count} is filled with the number of servers Mewvo is in
//   translations       { <lang>: { title, text } } — the text is ours, so it comes in all 8
//                      languages. Text the admin edits is posted as typed (never translated).

export const MEWVO_TEMPLATE_GROUP = Object.freeze({ key: 'mewvo', label: 'Mewvo (only in Mewvo\'s own servers)' });

/** Placeholders a home template may use (filled when chosen, {mods} when posted). */
export const HOME_PLACEHOLDERS = Object.freeze(['server', 'mods', 'changes', 'count']);

const H = (id, name, colour, en, translations, extra = {}) => Object.freeze({
    id, group: 'mewvo', name, title: en.title, text: en.text, colour, home: true, translations: Object.freeze(translations), ...extra,
});
const lines = (...parts) => parts.join('\n');

export const MEWVO_TEMPLATES = Object.freeze([
    H('mewvo-new-mods', 'New moderator(s)', 'green', {
        title: 'New moderators',
        text: lines('Please welcome the newest members of the Mewvo staff team: {mods}', '', 'They help with reports, tickets and appeals. Give them a little time while they settle in.'),
    }, {
        de: { title: 'Neue Moderatoren', text: lines('Begrüßt die neuen Mitglieder im Mewvo-Team: {mods}', '', 'Sie helfen bei Meldungen, Tickets und Einsprüchen. Gebt ihnen etwas Zeit, sich einzuarbeiten.') },
        fr: { title: 'Nouveaux modérateurs', text: lines('Bienvenue aux nouveaux membres de l\'équipe Mewvo : {mods}', '', 'Ils aident pour les signalements, les tickets et les appels. Laissez-leur un peu de temps pour prendre leurs marques.') },
        es: { title: 'Nuevos moderadores', text: lines('Damos la bienvenida a los nuevos miembros del equipo de Mewvo: {mods}', '', 'Ayudan con reportes, tickets y apelaciones. Dadles un poco de tiempo para adaptarse.') },
        it: { title: 'Nuovi moderatori', text: lines('Diamo il benvenuto ai nuovi membri dello staff di Mewvo: {mods}', '', 'Aiutano con segnalazioni, ticket e ricorsi. Lasciate loro un po\' di tempo per ambientarsi.') },
        pl: { title: 'Nowi moderatorzy', text: lines('Przywitajcie nowych członków zespołu Mewvo: {mods}', '', 'Pomagają przy zgłoszeniach, ticketach i odwołaniach. Dajcie im trochę czasu na wdrożenie się.') },
        'pt-BR': { title: 'Novos moderadores', text: lines('Deem as boas-vindas aos novos membros da equipe do Mewvo: {mods}', '', 'Eles ajudam com denúncias, tickets e apelações. Deem um tempo para eles se acostumarem.') },
        ru: { title: 'Новые модераторы', text: lines('Встречайте новых участников команды Mewvo: {mods}', '', 'Они помогают с жалобами, тикетами и апелляциями. Дайте им немного времени освоиться.') },
    }, { members: true }),

    H('mewvo-changelog', 'Changelog / Mewvo update', 'primary', {
        title: 'Mewvo update',
        text: lines('What changed in Mewvo:', '', '{changes}', '', 'The full list is on the Changelog page of the Mewvo website.'),
    }, {
        de: { title: 'Mewvo-Update', text: lines('Das hat sich bei Mewvo geändert:', '', '{changes}', '', 'Die ganze Liste steht auf der Seite Änderungen der Mewvo-Website.') },
        fr: { title: 'Mise à jour de Mewvo', text: lines('Ce qui a changé dans Mewvo :', '', '{changes}', '', 'La liste complète est sur la page Nouveautés du site de Mewvo.') },
        es: { title: 'Actualización de Mewvo', text: lines('Esto ha cambiado en Mewvo:', '', '{changes}', '', 'La lista completa está en la página de cambios de la web de Mewvo.') },
        it: { title: 'Aggiornamento di Mewvo', text: lines('Cosa è cambiato in Mewvo:', '', '{changes}', '', 'L\'elenco completo è nella pagina delle novità del sito di Mewvo.') },
        pl: { title: 'Aktualizacja Mewvo', text: lines('Co się zmieniło w Mewvo:', '', '{changes}', '', 'Pełna lista jest na stronie zmian na stronie Mewvo.') },
        'pt-BR': { title: 'Atualização do Mewvo', text: lines('O que mudou no Mewvo:', '', '{changes}', '', 'A lista completa está na página de novidades do site do Mewvo.') },
        ru: { title: 'Обновление Mewvo', text: lines('Что изменилось в Mewvo:', '', '{changes}', '', 'Полный список есть на странице изменений на сайте Mewvo.') },
    }, { changelog: true }),

    H('mewvo-new-feature', 'New feature', 'primary', {
        title: 'New in Mewvo: [feature]',
        text: lines('[What it does, in one or two sentences.]', '', 'How to use it: [command or dashboard page].', '', 'Questions or problems? Open a ticket in the support server.'),
    }, {
        de: { title: 'Neu in Mewvo: [Funktion]', text: lines('[Was sie macht, in ein oder zwei Sätzen.]', '', 'So nutzt du sie: [Befehl oder Dashboard-Seite].', '', 'Fragen oder Probleme? Öffne ein Ticket im Support-Server.') },
        fr: { title: 'Nouveau dans Mewvo : [fonction]', text: lines('[Ce qu\'elle fait, en une ou deux phrases.]', '', 'Comment l\'utiliser : [commande ou page du tableau de bord].', '', 'Une question ou un problème ? Ouvrez un ticket sur le serveur d\'aide.') },
        es: { title: 'Nuevo en Mewvo: [función]', text: lines('[Qué hace, en una o dos frases.]', '', 'Cómo usarla: [comando o página del panel].', '', '¿Preguntas o problemas? Abre un ticket en el servidor de soporte.') },
        it: { title: 'Novità in Mewvo: [funzione]', text: lines('[Cosa fa, in una o due frasi.]', '', 'Come usarla: [comando o pagina della dashboard].', '', 'Domande o problemi? Apri un ticket nel server di supporto.') },
        pl: { title: 'Nowość w Mewvo: [funkcja]', text: lines('[Co robi, w jednym lub dwóch zdaniach.]', '', 'Jak jej używać: [komenda lub strona panelu].', '', 'Pytania albo problemy? Otwórz ticket na serwerze wsparcia.') },
        'pt-BR': { title: 'Novo no Mewvo: [recurso]', text: lines('[O que ele faz, em uma ou duas frases.]', '', 'Como usar: [comando ou página do painel].', '', 'Dúvidas ou problemas? Abra um ticket no servidor de suporte.') },
        ru: { title: 'Новое в Mewvo: [функция]', text: lines('[Что она делает, в одном-двух предложениях.]', '', 'Как пользоваться: [команда или страница панели].', '', 'Вопросы или проблемы? Откройте тикет на сервере поддержки.') },
    }),

    H('mewvo-maintenance', 'Maintenance planned', 'yellow', {
        title: 'Planned Mewvo maintenance',
        text: lines('Mewvo will be offline on [date] from [time] to [time] ([time zone]) while we update it.', '', 'Commands, the dashboard and appeals will not work during that time. Cases and settings stay as they are.'),
    }, {
        de: { title: 'Geplante Wartung von Mewvo', text: lines('Mewvo ist am [Datum] von [Uhrzeit] bis [Uhrzeit] ([Zeitzone]) offline, weil wir es aktualisieren.', '', 'Befehle, das Dashboard und Einsprüche funktionieren in dieser Zeit nicht. Fälle und Einstellungen bleiben erhalten.') },
        fr: { title: 'Maintenance prévue de Mewvo', text: lines('Mewvo sera hors ligne le [date] de [heure] à [heure] ([fuseau horaire]) pendant une mise à jour.', '', 'Les commandes, le tableau de bord et les appels ne marcheront pas pendant ce temps. Les dossiers et les réglages sont conservés.') },
        es: { title: 'Mantenimiento previsto de Mewvo', text: lines('Mewvo estará desconectado el [fecha] de [hora] a [hora] ([zona horaria]) mientras lo actualizamos.', '', 'Los comandos, el panel y las apelaciones no funcionarán durante ese tiempo. Los casos y la configuración se mantienen.') },
        it: { title: 'Manutenzione programmata di Mewvo', text: lines('Mewvo sarà offline il [data] dalle [ora] alle [ora] ([fuso orario]) per un aggiornamento.', '', 'Comandi, dashboard e ricorsi non funzioneranno in quel periodo. Casi e impostazioni restano come sono.') },
        pl: { title: 'Planowana przerwa techniczna Mewvo', text: lines('Mewvo będzie offline [data] od [godzina] do [godzina] ([strefa czasowa]), bo je aktualizujemy.', '', 'W tym czasie komendy, panel i odwołania nie będą działać. Sprawy i ustawienia zostają bez zmian.') },
        'pt-BR': { title: 'Manutenção planejada do Mewvo', text: lines('O Mewvo ficará offline em [data] das [hora] às [hora] ([fuso horário]) para uma atualização.', '', 'Comandos, o painel e as apelações não funcionarão nesse período. Casos e configurações continuam como estão.') },
        ru: { title: 'Плановые работы Mewvo', text: lines('Mewvo будет недоступен [дата] с [время] до [время] ([часовой пояс]), пока мы его обновляем.', '', 'Команды, панель и апелляции в это время работать не будут. Дела и настройки сохранятся.') },
    }),

    H('mewvo-downtime-resolved', 'Bot downtime resolved', 'green', {
        title: 'Mewvo is back',
        text: lines('Mewvo was offline from [time] to [time] ([time zone]) because [reason]. It is working again.', '', 'Timed bans and mutes that ended while it was offline were lifted when it came back. If something still looks wrong, open a ticket.'),
    }, {
        de: { title: 'Mewvo ist wieder da', text: lines('Mewvo war von [Uhrzeit] bis [Uhrzeit] ([Zeitzone]) offline, weil [Grund]. Jetzt funktioniert es wieder.', '', 'Zeitlich begrenzte Banns und Mutes, die in der Zwischenzeit abgelaufen sind, wurden nach dem Neustart aufgehoben. Wenn noch etwas nicht stimmt, öffne ein Ticket.') },
        fr: { title: 'Mewvo est de retour', text: lines('Mewvo était hors ligne de [heure] à [heure] ([fuseau horaire]) à cause de [raison]. Il fonctionne de nouveau.', '', 'Les bannissements et mises en sourdine temporaires terminés pendant la coupure ont été levés à son retour. Si quelque chose semble encore anormal, ouvrez un ticket.') },
        es: { title: 'Mewvo ha vuelto', text: lines('Mewvo estuvo desconectado de [hora] a [hora] ([zona horaria]) por [motivo]. Ya funciona de nuevo.', '', 'Los baneos y silencios temporales que terminaron durante la caída se levantaron al volver. Si algo sigue mal, abre un ticket.') },
        it: { title: 'Mewvo è tornato', text: lines('Mewvo è stato offline dalle [ora] alle [ora] ([fuso orario]) per [motivo]. Ora funziona di nuovo.', '', 'I ban e i mute a tempo scaduti nel frattempo sono stati revocati al ritorno. Se qualcosa sembra ancora sbagliato, apri un ticket.') },
        pl: { title: 'Mewvo znowu działa', text: lines('Mewvo było offline od [godzina] do [godzina] ([strefa czasowa]) z powodu [powód]. Już działa.', '', 'Czasowe bany i wyciszenia, które skończyły się w tym czasie, zostały zdjęte po powrocie. Jeśli coś nadal wygląda źle, otwórz ticket.') },
        'pt-BR': { title: 'O Mewvo voltou', text: lines('O Mewvo ficou offline das [hora] às [hora] ([fuso horário]) por causa de [motivo]. Ele já está funcionando.', '', 'Banimentos e silenciamentos temporários que terminaram nesse período foram removidos quando ele voltou. Se algo ainda parecer errado, abra um ticket.') },
        ru: { title: 'Mewvo снова работает', text: lines('Mewvo был недоступен с [время] до [время] ([часовой пояс]) из-за [причина]. Сейчас всё работает.', '', 'Временные баны и муты, которые закончились за это время, были сняты после перезапуска. Если что-то всё ещё не так, откройте тикет.') },
    }),

    H('mewvo-premium', 'Premium news', 'purple', {
        title: 'Mewvo Premium: [what is new]',
        text: lines('[What changed in the paid plans, in one or two sentences.]', '', 'Details and prices are on the Pricing page of the Mewvo website. Questions about a payment? Open a ticket.'),
    }, {
        de: { title: 'Mewvo Premium: [Neuigkeit]', text: lines('[Was sich an den bezahlten Plänen ändert, in ein oder zwei Sätzen.]', '', 'Details und Preise stehen auf der Seite Preise der Mewvo-Website. Fragen zu einer Zahlung? Öffne ein Ticket.') },
        fr: { title: 'Mewvo Premium : [nouveauté]', text: lines('[Ce qui change dans les offres payantes, en une ou deux phrases.]', '', 'Les détails et les prix sont sur la page Tarifs du site de Mewvo. Une question sur un paiement ? Ouvrez un ticket.') },
        es: { title: 'Mewvo Premium: [novedad]', text: lines('[Qué cambia en los planes de pago, en una o dos frases.]', '', 'Los detalles y precios están en la página de precios de la web de Mewvo. ¿Dudas sobre un pago? Abre un ticket.') },
        it: { title: 'Mewvo Premium: [novità]', text: lines('[Cosa cambia nei piani a pagamento, in una o due frasi.]', '', 'Dettagli e prezzi sono nella pagina Prezzi del sito di Mewvo. Domande su un pagamento? Apri un ticket.') },
        pl: { title: 'Mewvo Premium: [nowość]', text: lines('[Co się zmienia w płatnych planach, w jednym lub dwóch zdaniach.]', '', 'Szczegóły i ceny są na stronie Cennik na stronie Mewvo. Pytania o płatność? Otwórz ticket.') },
        'pt-BR': { title: 'Mewvo Premium: [novidade]', text: lines('[O que muda nos planos pagos, em uma ou duas frases.]', '', 'Detalhes e preços estão na página de preços do site do Mewvo. Dúvidas sobre um pagamento? Abra um ticket.') },
        ru: { title: 'Mewvo Premium: [что нового]', text: lines('[Что меняется в платных тарифах, в одном-двух предложениях.]', '', 'Подробности и цены есть на странице тарифов на сайте Mewvo. Вопросы об оплате? Откройте тикет.') },
    }),

    H('mewvo-staff-changes', 'Staff team changes', 'grey', {
        title: 'Staff team changes',
        text: lines('A few changes to the Mewvo staff team:', '', '- [Name] is now [role].', '- [Name] stepped down. Thanks for all the help.', '', 'Questions for staff still go through a ticket.'),
    }, {
        de: { title: 'Änderungen im Team', text: lines('Ein paar Änderungen im Mewvo-Team:', '', '- [Name] ist jetzt [Rolle].', '- [Name] hört auf. Danke für die viele Hilfe.', '', 'Fragen an das Team gehen weiterhin über ein Ticket.') },
        fr: { title: 'Changements dans l\'équipe', text: lines('Quelques changements dans l\'équipe Mewvo :', '', '- [Nom] est maintenant [rôle].', '- [Nom] quitte l\'équipe. Merci pour toute cette aide.', '', 'Les questions pour l\'équipe passent toujours par un ticket.') },
        es: { title: 'Cambios en el equipo', text: lines('Algunos cambios en el equipo de Mewvo:', '', '- [Nombre] ahora es [rol].', '- [Nombre] deja el equipo. Gracias por toda la ayuda.', '', 'Las preguntas para el equipo siguen yendo por ticket.') },
        it: { title: 'Cambi nello staff', text: lines('Alcuni cambi nello staff di Mewvo:', '', '- [Nome] ora è [ruolo].', '- [Nome] lascia lo staff. Grazie per tutto l\'aiuto.', '', 'Le domande per lo staff passano sempre da un ticket.') },
        pl: { title: 'Zmiany w zespole', text: lines('Kilka zmian w zespole Mewvo:', '', '- [Imię] jest teraz [rola].', '- [Imię] odchodzi z zespołu. Dzięki za całą pomoc.', '', 'Pytania do zespołu nadal przez ticket.') },
        'pt-BR': { title: 'Mudanças na equipe', text: lines('Algumas mudanças na equipe do Mewvo:', '', '- [Nome] agora é [cargo].', '- [Nome] saiu da equipe. Obrigado por toda a ajuda.', '', 'Perguntas para a equipe continuam indo por ticket.') },
        ru: { title: 'Изменения в команде', text: lines('Несколько изменений в команде Mewvo:', '', '- [Имя] теперь [роль].', '- [Имя] уходит из команды. Спасибо за всю помощь.', '', 'Вопросы к команде по-прежнему через тикет.') },
    }),

    H('mewvo-server-count', 'Mewvo now in N servers', 'green', {
        title: 'Mewvo is now in {count} servers',
        text: lines('Mewvo now helps run {count} servers. Thanks to everyone who added it, reported bugs and suggested features.'),
    }, {
        de: { title: 'Mewvo ist jetzt auf {count} Servern', text: 'Mewvo hilft jetzt auf {count} Servern. Danke an alle, die es hinzugefügt, Fehler gemeldet und Ideen geschickt haben.' },
        fr: { title: 'Mewvo est maintenant sur {count} serveurs', text: 'Mewvo aide maintenant {count} serveurs. Merci à tous ceux qui l\'ont ajouté, ont signalé des bugs et proposé des idées.' },
        es: { title: 'Mewvo ya está en {count} servidores', text: 'Mewvo ya ayuda en {count} servidores. Gracias a todos los que lo añadieron, reportaron fallos y propusieron ideas.' },
        it: { title: 'Mewvo ora è in {count} server', text: 'Mewvo ora aiuta {count} server. Grazie a chi l\'ha aggiunto, ha segnalato bug e proposto idee.' },
        pl: { title: 'Mewvo jest już na {count} serwerach', text: 'Mewvo pomaga już na {count} serwerach. Dzięki wszystkim, którzy je dodali, zgłaszali błędy i podsuwali pomysły.' },
        'pt-BR': { title: 'O Mewvo agora está em {count} servidores', text: 'O Mewvo agora ajuda {count} servidores. Obrigado a todos que o adicionaram, relataram bugs e sugeriram ideias.' },
        ru: { title: 'Mewvo теперь на {count} серверах', text: 'Mewvo теперь помогает {count} серверам. Спасибо всем, кто его добавил, сообщал об ошибках и предлагал идеи.' },
    }, { serverCount: true, celebrate: true }),

    H('mewvo-translation-help', 'Translation help wanted', 'primary', {
        title: 'Help translate Mewvo',
        text: lines('Mewvo speaks 8 languages, and some of the text could read better.', '', 'If you speak [language] well and want to help, open a ticket and say which language. You do not need to know how to code.'),
    }, {
        de: { title: 'Hilf beim Übersetzen von Mewvo', text: lines('Mewvo spricht 8 Sprachen, und manche Texte könnten besser klingen.', '', 'Wenn du gut [Sprache] sprichst und helfen möchtest, öffne ein Ticket und nenne die Sprache. Programmieren musst du nicht können.') },
        fr: { title: 'Aidez à traduire Mewvo', text: lines('Mewvo parle 8 langues, et certains textes pourraient être meilleurs.', '', 'Si vous parlez bien [langue] et voulez aider, ouvrez un ticket en indiquant la langue. Pas besoin de savoir coder.') },
        es: { title: 'Ayuda a traducir Mewvo', text: lines('Mewvo habla 8 idiomas, y algunos textos podrían sonar mejor.', '', 'Si hablas bien [idioma] y quieres ayudar, abre un ticket y di qué idioma. No hace falta saber programar.') },
        it: { title: 'Aiuta a tradurre Mewvo', text: lines('Mewvo parla 8 lingue, e alcuni testi potrebbero suonare meglio.', '', 'Se parli bene [lingua] e vuoi aiutare, apri un ticket e indica la lingua. Non serve saper programmare.') },
        pl: { title: 'Pomóż tłumaczyć Mewvo', text: lines('Mewvo mówi w 8 językach, a niektóre teksty mogłyby brzmieć lepiej.', '', 'Jeśli dobrze znasz [język] i chcesz pomóc, otwórz ticket i napisz, który to język. Nie musisz umieć programować.') },
        'pt-BR': { title: 'Ajude a traduzir o Mewvo', text: lines('O Mewvo fala 8 idiomas, e alguns textos poderiam soar melhor.', '', 'Se você fala bem [idioma] e quer ajudar, abra um ticket e diga qual idioma. Não precisa saber programar.') },
        ru: { title: 'Помогите перевести Mewvo', text: lines('Mewvo говорит на 8 языках, и некоторые тексты можно сделать лучше.', '', 'Если вы хорошо знаете [язык] и хотите помочь, откройте тикет и укажите язык. Уметь программировать не нужно.') },
    }),

    H('mewvo-appeals-open', 'Appeals and staff reports open', 'primary', {
        title: 'Appeals and staff reports are open',
        text: lines(
            '**Appeals**',
            'If you think a ban, kick, mute or warning was a mistake, press Appeal on the panel in #[appeals channel]. The case code is in the DM Mewvo sent you. If you lost it, leave the code empty and we use your latest case.',
            '',
            '**Staff reports**',
            'Had a problem with a staff member? Press Report staff on the same panel. Only admins can see reports.',
            '',
            'We usually reply within 48 hours. Please open one appeal or report per issue.',
        ),
    }, {
        de: { title: 'Einsprüche und Staff-Meldungen sind offen', text: lines('**Einsprüche**', 'Wenn du denkst, dass ein Bann, Kick, Mute oder eine Verwarnung ein Fehler war, drück auf Einspruch im Panel in #[Einspruchskanal]. Der Fallcode steht in der DM, die Mewvo dir geschickt hat. Wenn du ihn verloren hast, lass das Feld leer, dann nehmen wir deinen letzten Fall.', '', '**Staff-Meldungen**', 'Ärger mit einem Teammitglied? Drück im selben Panel auf Staff melden. Nur Admins sehen Meldungen.', '', 'Wir antworten meist innerhalb von 48 Stunden. Bitte nur ein Einspruch oder eine Meldung pro Sache.') },
        fr: { title: 'Les appels et les signalements du staff sont ouverts', text: lines('**Appels**', 'Si tu penses qu\'un ban, un kick, un mute ou un avertissement était une erreur, appuie sur Faire appel dans le panneau de #[salon des appels]. Le code du dossier est dans le MP que Mewvo t\'a envoyé. Si tu l\'as perdu, laisse le code vide et on prendra ton dernier dossier.', '', '**Signalements du staff**', 'Un problème avec un membre du staff ? Appuie sur Signaler un membre du staff dans le même panneau. Seuls les admins voient les signalements.', '', 'On répond en général sous 48 heures. Ouvre un seul appel ou signalement par problème, merci.') },
        es: { title: 'Las apelaciones y los reportes al staff están abiertos', text: lines('**Apelaciones**', 'Si crees que un ban, kick, mute o advertencia fue un error, pulsa Apelar en el panel de #[canal de apelaciones]. El código del caso está en el MD que te envió Mewvo. Si lo perdiste, deja el código vacío y usamos tu último caso.', '', '**Reportes al staff**', '¿Tuviste un problema con alguien del staff? Pulsa Reportar staff en el mismo panel. Solo los admins ven los reportes.', '', 'Solemos responder en 48 horas. Abre una apelación o reporte por problema, por favor.') },
        it: { title: 'Ricorsi e segnalazioni dello staff aperti', text: lines('**Ricorsi**', 'Se pensi che un ban, kick, mute o avvertimento sia stato un errore, premi Ricorso nel pannello in #[canale ricorsi]. Il codice del caso è nel DM che ti ha mandato Mewvo. Se l\'hai perso, lascia vuoto il codice e usiamo il tuo ultimo caso.', '', '**Segnalazioni dello staff**', 'Hai avuto un problema con qualcuno dello staff? Premi Segnala staff nello stesso pannello. Solo gli admin vedono le segnalazioni.', '', 'Di solito rispondiamo entro 48 ore. Apri un ricorso o una segnalazione per problema, grazie.') },
        pl: { title: 'Odwołania i zgłoszenia na administrację są otwarte', text: lines('**Odwołania**', 'Jeśli uważasz, że ban, kick, wyciszenie albo ostrzeżenie było pomyłką, kliknij Odwołanie w panelu na #[kanał odwołań]. Kod sprawy jest w wiadomości prywatnej od Mewvo. Jeśli go zgubiłeś, zostaw pole puste i weźmiemy twoją ostatnią sprawę.', '', '**Zgłoszenia na ekipę**', 'Masz problem z kimś z ekipy? Kliknij Zgłoś członka ekipy w tym samym panelu. Zgłoszenia widzą tylko admini.', '', 'Zwykle odpowiadamy w ciągu 48 godzin. Otwórz jedno odwołanie albo zgłoszenie na jedną sprawę.') },
        'pt-BR': { title: 'Apelações e denúncias da staff estão abertas', text: lines('**Apelações**', 'Se você acha que um ban, kick, mute ou aviso foi um erro, clique em Apelar no painel em #[canal de apelações]. O código do caso está na DM que o Mewvo te mandou. Se perdeu, deixe o código vazio e usamos seu último caso.', '', '**Denúncias da staff**', 'Teve um problema com alguém da staff? Clique em Denunciar staff no mesmo painel. Só admins veem as denúncias.', '', 'Costumamos responder em até 48 horas. Abra uma apelação ou denúncia por problema, por favor.') },
        ru: { title: 'Апелляции и жалобы на персонал открыты', text: lines('**Апелляции**', 'Если вы считаете, что бан, кик, мут или предупреждение были ошибкой, нажмите «Апелляция» на панели в #[канал апелляций]. Код дела есть в личном сообщении от Mewvo. Если вы его потеряли, оставьте код пустым, и мы возьмём ваше последнее дело.', '', '**Жалобы на персонал**', 'Была проблема с кем-то из персонала? Нажмите «Жалоба на персонал» на той же панели. Жалобы видят только админы.', '', 'Обычно отвечаем в течение 48 часов. Открывайте одну апелляцию или жалобу на один случай.') },
    }),

    H('mewvo-server-event', 'Server event', 'purple', {
        title: '[Event name]',
        text: lines('Join us for [event] in {server} on [day] at [time] ([time zone]).', '', '[What happens, in one or two sentences.]', '', 'Where: #[channel]'),
    }, {
        de: { title: '[Name des Events]', text: lines('Mach mit bei [Event] in {server} am [Tag] um [Uhrzeit] ([Zeitzone]).', '', '[Was passiert, in ein oder zwei Sätzen.]', '', 'Wo: #[Kanal]') },
        fr: { title: '[Nom de l\'événement]', text: lines('Rejoignez-nous pour [événement] sur {server} le [jour] à [heure] ([fuseau horaire]).', '', '[Ce qui se passe, en une ou deux phrases.]', '', 'Où : #[salon]') },
        es: { title: '[Nombre del evento]', text: lines('Únete a [evento] en {server} el [día] a las [hora] ([zona horaria]).', '', '[Qué pasará, en una o dos frases.]', '', 'Dónde: #[canal]') },
        it: { title: '[Nome dell\'evento]', text: lines('Unisciti a noi per [evento] su {server} il [giorno] alle [ora] ([fuso orario]).', '', '[Cosa succede, in una o due frasi.]', '', 'Dove: #[canale]') },
        pl: { title: '[Nazwa wydarzenia]', text: lines('Dołącz do [wydarzenie] na {server} w [dzień] o [godzina] ([strefa czasowa]).', '', '[Co się wydarzy, w jednym lub dwóch zdaniach.]', '', 'Gdzie: #[kanał]') },
        'pt-BR': { title: '[Nome do evento]', text: lines('Participe de [evento] no {server} em [dia] às [hora] ([fuso horário]).', '', '[O que vai acontecer, em uma ou duas frases.]', '', 'Onde: #[canal]') },
        ru: { title: '[Название события]', text: lines('Присоединяйтесь к [событие] на {server} [день] в [время] ([часовой пояс]).', '', '[Что будет, в одном-двух предложениях.]', '', 'Где: #[канал]') },
    }),
]);
