import { matchGuess } from './guess-matcher';

describe('matchGuess', () => {
  describe('exact matches', () => {
    it('accepts an exact match', () => {
      expect(matchGuess('Drake', 'Drake')).toBe(true);
    });

    it('is case-insensitive', () => {
      expect(matchGuess('drake', 'Drake')).toBe(true);
    });

    it('ignores surrounding whitespace', () => {
      expect(matchGuess('  Drake  ', 'Drake')).toBe(true);
    });
  });

  describe('missing articles', () => {
    it('accepts the answer without a leading "The"', () => {
      expect(matchGuess('weeknd', 'The Weeknd')).toBe(true);
    });

    it('accepts the answer with a leading "The"', () => {
      expect(matchGuess('The Weeknd', 'Weeknd')).toBe(true);
    });

    it('accepts "The Beatles" without the article', () => {
      expect(matchGuess('beatles', 'The Beatles')).toBe(true);
    });
  });

  describe('typos', () => {
    it('accepts a single typo in a short title', () => {
      expect(matchGuess('the weekend', 'The Weeknd')).toBe(true);
    });

    it('accepts a missing accent', () => {
      expect(matchGuess('Beyonce', 'Beyoncé')).toBe(true);
    });

    it('accepts a small typo in a longer title', () => {
      expect(matchGuess('bohemian rapsody', 'Bohemian Rhapsody')).toBe(true);
    });
  });

  describe('featuring artists', () => {
    it('accepts the primary artist when the answer features another', () => {
      expect(matchGuess('Drake', 'Drake feat. Rihanna')).toBe(true);
    });

    it('accepts the primary artist when the answer uses "feat"', () => {
      expect(matchGuess('Calvin Harris', 'Calvin Harris feat Rihanna')).toBe(true);
    });
  });

  describe('stop words', () => {
    it('rejects a guess made only of stop words', () => {
      expect(matchGuess('the', 'The Weeknd')).toBe(false);
    });

    it('rejects "love" against a title containing it', () => {
      expect(matchGuess('love', 'Crazy in Love')).toBe(false);
    });

    it('rejects a stop-word-only guess against a longer title', () => {
      expect(matchGuess('a the of', 'The Lord of the Rings')).toBe(false);
    });
  });

  describe('superstrings', () => {
    it('rejects a long wrong guess that contains the answer', () => {
      expect(matchGuess('not drake at all', 'Drake')).toBe(false);
    });

    it('rejects a guess that merely contains the answer as a substring', () => {
      expect(matchGuess('the weeknd is great', 'The Weeknd')).toBe(false);
    });
  });

  describe('unrelated guesses', () => {
    it('rejects a completely different title', () => {
      expect(matchGuess('Taylor Swift', 'Drake')).toBe(false);
    });

    it('rejects an empty guess', () => {
      expect(matchGuess('', 'Drake')).toBe(false);
    });
  });
});
