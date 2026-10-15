// Transcript sanity checks shared by the server (when a transcript lands) and
// the clients (when an older record is shown). No dependencies, so the same
// file runs in Node and in the browser.

/**
 * Whisper's failure mode on short or noisy clips is a loop ("çabukla çabukla
 * çabukla …"). Flags text where one token repeats four or more times in a row,
 * where fewer than 40% of eight or more words are distinct, or (on longer
 * text) where fewer than half of the word trigrams are distinct.
 */
export function looksRepetitive(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/(\S+)(?:\s+\1){3,}(?!\S)/iu.test(t)) return true;
  const words = t.toLowerCase().split(/\s+/);
  if (words.length >= 8 && new Set(words).size / words.length < 0.4) return true;
  if (t.length >= 200 && words.length >= 12) {
    const tri = new Set();
    for (let i = 0; i + 2 < words.length; i++) tri.add(words[i] + ' ' + words[i + 1] + ' ' + words[i + 2]);
    if (tri.size / (words.length - 2) < 0.5) return true;
  }
  return false;
}

// Phrases Whisper produces for silence or room noise: subtitle credits and
// sign-offs learned from captioned video. A transcript that is only one of
// these (repeated or not) heard no speech.
const HALLUCINATIONS = [
  /^bu dizinin (betimlemesi|altyaz[ıi]lar[ıi]) .*(yapt[ıi]r[ıi]lm[ıi][sş]t[ıi]r|taraf[ıi]ndan)/,
  /^altyaz[ıi] m\.?k\.?$/, /^altyaz[ıi]lar(?:\s*:)?.*$/, /^izledi[ğg]iniz i[çc]in te[şs]ekk[üu]r(ler| ederim)/, /^abone olmay[ıi] unutmay[ıi]n/,
  /^thanks? (you )?for watching/, /^thank you\.?$/, /^subtitles? by/, /^subtitles? (created|provided) by/, /^amara\.org/, /^transcribed by/, /^you$/,
  /^untertitel (der|von|im auftrag)/, /^sous-titres? (réalisés|par)/, /^subtítulos (realizados|por)/, /^sottotitoli (a cura|creati)/,
];
export function looksLikeSilence(text) {
  const t = String(text || '').trim().toLowerCase().replace(/[“”"']/g, '');
  if (!t) return false;
  // collapse a repeated phrase ("Thank you. Thank you.") to one instance
  const parts = t.split(/(?<=[.!?…])\s+/).filter(Boolean);
  const first = parts[0];
  if (!parts.every((p) => p === first)) return false;
  return HALLUCINATIONS.some((re) => re.test(first));
}

/** 'repetition' | 'silence' | null: why a transcript should not be shown as speech. */
export function unclearReason(text) {
  if (!String(text || '').trim()) return null;
  if (looksLikeSilence(text)) return 'silence';
  if (looksRepetitive(text)) return 'repetition';
  return null;
}

export const UNCLEAR_TEXT = {
  repetition: 'unclear: the model repeated itself; try again closer to the microphone',
  silence: 'nothing heard: the microphone picked up no speech',
};

// Human name for an ISO language code in the page's language ("Türkçe" in a
// Turkish page, "Turkish" in an English one); falls back to the code.
export function langName(code, locale) {
  if (!code) return '';
  try { return new Intl.DisplayNames([locale || (typeof navigator !== 'undefined' && navigator.language) || 'en'], { type: 'language' }).of(code) || code; } catch { return code; }
}
