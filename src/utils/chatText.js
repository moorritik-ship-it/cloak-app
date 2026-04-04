/** Max grapheme clusters per chat message (matches server). */
export const CHAT_MAX_CHARS = 500

/**
 * Count user-perceived characters (emoji-safe).
 * @param {string} text
 */
export function countGraphemes(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    return [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)].length
  }
  return Array.from(text).length
}

/**
 * Truncate to at most CHAT_MAX_CHARS graphemes.
 * @param {string} text
 */
export function clampChatInput(text) {
  if (typeof text !== 'string') return ''
  const n = countGraphemes(text)
  if (n <= CHAT_MAX_CHARS) return text
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const seg = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)]
    return seg.slice(0, CHAT_MAX_CHARS).map((s) => s.segment).join('')
  }
  return Array.from(text).slice(0, CHAT_MAX_CHARS).join('')
}
