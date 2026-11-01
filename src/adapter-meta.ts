/** Longest serialized adapter payload an event carries, so one transport cannot bloat every event. */
export const ADAPTER_META_MAX_BYTES = 8 * 1024

/** How deep an adapter payload may nest. */
export const ADAPTER_META_MAX_DEPTH = 8

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function refuse(where: string, reason: string): never {
  throw new Error(`meta.adapter${where}: ${reason}`)
}

function checkValue(value: unknown, where: string, depth: number): void {
  if (depth > ADAPTER_META_MAX_DEPTH) refuse(where, `nests deeper than ${ADAPTER_META_MAX_DEPTH}`)
  if (value === null) return
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return
    case 'number':
      if (!Number.isFinite(value)) refuse(where, 'numbers must be finite')
      return
    case 'object':
      break
    default:
      refuse(where, `${typeof value} is not a json value`)
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => checkValue(item, `${where}[${index}]`, depth + 1))
    return
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key)) refuse(`${where}.${key}`, 'a key that can reach a prototype is refused')
    checkValue(item, `${where}.${key}`, depth + 1)
  }
}

/** Copies the payload core only carries: json-safe, bounded, and detached from the caller. */
export function adapterMetaOf(input: Record<string, unknown> | undefined): Record<string, unknown> {
  if (input === undefined) return {}
  checkValue(input, '', 0)
  const text = JSON.stringify(input)
  if (Buffer.byteLength(text, 'utf8') > ADAPTER_META_MAX_BYTES) {
    refuse('', `serializes to more than ${ADAPTER_META_MAX_BYTES} bytes`)
  }
  return JSON.parse(text) as Record<string, unknown>
}
