import { handleQuizButton } from '../../../handlers/verificationQuiz.js';

export default { name: 'vquiz', execute: (interaction, client, args) => handleQuizButton(interaction, client, args) };
