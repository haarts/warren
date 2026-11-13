let counter = 0

export function newId(prefix: string): string {
  counter += 1
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`
}

/** The id prefix each kind of item has always been given, so a copy looks like an original. */
export function idPrefix(kind: string): string {
  return kind === 'marker' ? 'mk' : kind
}
