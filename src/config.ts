/* eslint-disable @typescript-eslint/no-explicit-any */
type AnySchema = ((data?: any, options?: any) => any) & { dict?: Record<string, unknown> | undefined }
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Raised when a config object fails validation. */
export class ConfigError extends Error {
  readonly path: readonly (string | number)[]
  readonly fields: readonly string[]

  constructor(
    message: string,
    path: readonly (string | number)[] = [],
    fields: readonly string[] = [],
  ) {
    const where = path.length > 0 ? ` (at ${path.join('.')})` : ''
    super(`${message}${where}`)
    this.name = 'ConfigError'
    this.path = path
    this.fields = fields
  }
}

function unknownFieldError(fields: readonly string[]): ConfigError {
  return new ConfigError(`unknown config fields: ${fields.join(', ')}`, [], fields)
}

function declaredKeys(schema: AnySchema): Set<string> {
  return new Set(Object.keys(schema.dict ?? {}))
}

function assertKnown(schema: AnySchema, value: object): void {
  const declared = declaredKeys(schema)
  const unknown = Object.keys(value).filter((key) => !declared.has(key))
  if (unknown.length > 0) throw unknownFieldError(unknown)
}

/** Addresses that expose a listener on every interface. */
export const WILDCARD_HOSTS: readonly string[] = ['0.0.0.0', '::', '[::]', '*']

/** Rejects a wildcard bind address so the port is never exposed on every interface. */
export function assertBindHost(host: string, path: readonly (string | number)[] = ['listen', 'host']): void {
  if (WILDCARD_HOSTS.includes(host.trim())) {
    throw new ConfigError(
      `listen host must be a concrete address, wildcard bind is refused: ${host}`,
      path,
    )
  }
}

/** Rejects unknown fields so a misconfigured profile fails to mount. */
export function validateConfig<T>(schema: AnySchema, config: unknown): T {
  const parsed = schema(config) as object
  assertKnown(schema, parsed)
  return parsed as T
}

/** Wraps a schema so undeclared keys are rejected during validation. */
export function strict<T>(inner: AnySchema): AnySchema & ((data?: unknown) => T) {
  const wrapper = ((data?: unknown) => validateConfig<T>(inner, data ?? {})) as AnySchema &
    ((data?: unknown) => T)
  if (inner.dict) wrapper.dict = inner.dict
  return wrapper
}
