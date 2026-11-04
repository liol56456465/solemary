// catWords.js — the server cat's stage and mood in the page's language (leaderboard card, /trust).
//
// The cat's stage and mood come from catModel.js in English (the bot's Discord messages); the
// website words them from pages.cat.stages.<key> / moods.<mood> / sentences.<mood>. An unknown
// stage key or mood keeps the English words.
import { hasKey } from './i18n.js';

const CAT_WORD = /^[a-z]+$/;

/** A stage ({ key, name }) in the page's language: { name: "Young cat", inText: "young cat" }. */
export function catStageWords(stage, t) {
    const key = typeof stage?.key === 'string' && CAT_WORD.test(stage.key) ? `pages.cat.stages.${stage.key}` : '';
    if (key && hasKey('en', `${key}.name`)) return { name: t(`${key}.name`), inText: t(`${key}.inText`) };
    const name = String(stage?.name ?? '');
    return { name, inText: name.toLowerCase() };
}

/** The cat's stage, mood and mood sentence in the page's language. */
export function catWords(cat, t) {
    const stage = catStageWords(cat.stage, t);
    const known = typeof cat.mood === 'string' && CAT_WORD.test(cat.mood) && hasKey('en', `pages.cat.moods.${cat.mood}`);
    return {
        stage,
        mood: known ? t(`pages.cat.moods.${cat.mood}`) : cat.mood,
        sentence: known ? t(`pages.cat.sentences.${cat.mood}`, { name: cat.name }) : cat.sentence,
    };
}
