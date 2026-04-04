/** Max length for match session display name */
export const DISPLAY_NAME_MAX = 20
export const DISPLAY_NAME_MIN = 2

/** Allowed: letters, numbers, underscores only */
export const DISPLAY_NAME_PATTERN = /^[a-zA-Z0-9_]{2,20}$/

/**
 * Strip disallowed characters (keeps a–z, A–Z, 0–9, _)
 */
export function sanitizeDisplayNameInput(raw) {
  if (typeof raw !== 'string') return ''
  return raw.replace(/[^a-zA-Z0-9_]/g, '').slice(0, DISPLAY_NAME_MAX)
}

/**
 * Curated blocklist (lowercase). Short entries matched as whole tokens only to reduce false positives.
 */
const BAD_WORDS_LONG = [
  'fuck',
  'shit',
  'cunt',
  'dick',
  'cock',
  'piss',
  'slut',
  'whore',
  'bitch',
  'nazi',
  'rape',
  'porn',
  'anal',
  'anus',
  'cum',
  'jizz',
  'tits',
  'nude',
  'xxx',
  'fag',
  'dyke',
  'homo',
  'nigg',
  'spic',
  'chink',
  'retard',
  'kill',
  'dead',
  'pedo',
  'child',
]

const BAD_WORDS_SHORT = new Set(['ass', 'cum', 'fag'])

/**
 * Returns true if the username contains profanity / blocked terms.
 */
export function containsProfanity(username) {
  if (!username || typeof username !== 'string') return false
  const lower = username.toLowerCase()
  const compact = lower.replace(/_/g, '')

  for (const bad of BAD_WORDS_LONG) {
    if (bad.length >= 4) {
      if (lower.includes(bad) || compact.includes(bad)) return true
    }
  }

  const tokens = lower.split(/_+/).filter(Boolean)
  for (const token of tokens) {
    for (const bad of BAD_WORDS_LONG) {
      if (bad.length < 4 && token.includes(bad)) return true
    }
    for (const short of BAD_WORDS_SHORT) {
      if (token === short || token === `${short}s`) return true
    }
  }

  return false
}

export function validateDisplayName(username) {
  const trimmed = typeof username === 'string' ? username.trim() : ''
  if (trimmed.length < DISPLAY_NAME_MIN) {
    return { ok: false, message: `Use at least ${DISPLAY_NAME_MIN} characters.` }
  }
  if (trimmed.length > DISPLAY_NAME_MAX) {
    return { ok: false, message: `Use at most ${DISPLAY_NAME_MAX} characters.` }
  }
  if (!DISPLAY_NAME_PATTERN.test(trimmed)) {
    return {
      ok: false,
      message: 'Only letters, numbers, and underscores are allowed.',
    }
  }
  if (containsProfanity(trimmed)) {
    return { ok: false, message: 'That name isn’t allowed. Please choose another.' }
  }
  return { ok: true, message: '' }
}

const ADJECTIVES = [
  'Silent',
  'Neon',
  'Quantum',
  'Cosmic',
  'Shadow',
  'Cyber',
  'Velvet',
  'Frost',
  'Nova',
  'Phantom',
  'Electric',
  'Solar',
  'Lunar',
  'Crystal',
  'Golden',
]

const ANIMALS = [
  'Panda',
  'Falcon',
  'Fox',
  'Owl',
  'Wolf',
  'Lynx',
  'Tiger',
  'Raven',
  'Hawk',
  'Bear',
  'Otter',
  'Eagle',
  'Badger',
  'Cobra',
  'Moose',
]

export function generateRandomAdjectiveAnimal() {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)]
  return `${adj}${animal}`
}

/** localStorage key when user opts to remember display name */
export const REMEMBERED_DISPLAY_NAME_KEY = 'cloak_match_display_name'
