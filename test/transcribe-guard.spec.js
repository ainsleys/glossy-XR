// The repetition guard on transcripts: no browser, just the function.
import { test, expect } from '@playwright/test';
import { looksRepetitive } from '../server/transcribe.js';

test('flags Whisper loops and leaves real speech alone', () => {
  expect(looksRepetitive('Bence bu çabukla bir çabukla çabukla çabukla çabukla çabukla çabukla çabukla çabukla çabukla')).toBe(true);
  expect(looksRepetitive('the the the the the')).toBe(true);
  expect(looksRepetitive('Thank you. Thank you. Thank you. Thank you. Thank you. Thank you. Thank you. Thank you.')).toBe(true);
  expect(looksRepetitive('pekmez kazanı avluda, asmanın altında dururdu.')).toBe(false);
  expect(looksRepetitive('çok çok güzel bir yerdi')).toBe(false);                       // a doubled word is normal speech
  expect(looksRepetitive('The lamp on the table is broken and has been since the summer the family left.')).toBe(false);
  expect(looksRepetitive('')).toBe(false);
  expect(looksRepetitive(null)).toBe(false);
});
