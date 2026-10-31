import { describe, expect, test } from 'vitest'
import { REPLY_TARGET_MAX, SESSION_KEY_MAX, tokenProblem } from '../src/contract.js'

describe('the tokens core takes from an adapter', () => {
  test('a printable single line token passes', () => {
    expect(tokenProblem('sessionKey', 'p2p:inst-b', SESSION_KEY_MAX)).toBeUndefined()
    expect(tokenProblem('replyTarget', 'group-12345', REPLY_TARGET_MAX)).toBeUndefined()
  })

  test('an empty or missing value is refused', () => {
    expect(tokenProblem('sessionKey', '', SESSION_KEY_MAX)).toMatch(/non-empty/)
    expect(tokenProblem('sessionKey', undefined, SESSION_KEY_MAX)).toMatch(/non-empty/)
  })

  test('a token with a line break or a space is refused', () => {
    expect(tokenProblem('replyTarget', 'two words', REPLY_TARGET_MAX)).toMatch(/one line/)
    expect(tokenProblem('replyTarget', 'a\nb', REPLY_TARGET_MAX)).toMatch(/one line/)
    expect(tokenProblem('replyTarget', 'a\tb', REPLY_TARGET_MAX)).toMatch(/one line/)
  })

  test('the length bound counts characters, not bytes', () => {
    expect(tokenProblem('sessionKey', 'a'.repeat(SESSION_KEY_MAX), SESSION_KEY_MAX)).toBeUndefined()
    expect(tokenProblem('sessionKey', 'a'.repeat(SESSION_KEY_MAX + 1), SESSION_KEY_MAX)).toMatch(/longer than 128/)
    expect(tokenProblem('replyTarget', 'a'.repeat(REPLY_TARGET_MAX + 1), REPLY_TARGET_MAX)).toMatch(/longer than 256/)
  })
})
