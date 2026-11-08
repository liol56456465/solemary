import { handleContestButton } from '../../../handlers/automodContest.js';

// opensModal: the contest button answers with a form (exempt from the safety net).
export default { name: 'amcontest', execute: handleContestButton, opensModal: true };
