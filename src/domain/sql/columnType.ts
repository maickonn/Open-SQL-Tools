/** MySQL numeric modifiers that follow the type arguments ("int(10) unsigned zerofill"). */
const MODIFIERS = /^(.*?)\s+((?:signed|unsigned|zerofill)(?:\s+(?:signed|unsigned|zerofill))*)$/i

/**
 * Splits a column type into base type, arguments and trailing modifiers:
 * "varchar(255)" → varchar / 255, "decimal(10,2) unsigned" → decimal / 10,2 / unsigned,
 * "timestamp(3) with time zone" → timestamp / 3 / with time zone, "double precision" → double precision.
 */
export function splitType(fullType: string): { base: string; args: string; suffix: string } {
  const type = fullType.trim()
  const withArgs = /^([^(]+?)\s*\(([^)]*)\)\s*(.*)$/.exec(type)
  if (withArgs) return { base: withArgs[1].trim(), args: withArgs[2].trim(), suffix: withArgs[3].trim() }
  const modified = MODIFIERS.exec(type)
  if (modified) return { base: modified[1].trim(), args: '', suffix: modified[2] }
  return { base: type, args: '', suffix: '' }
}

export function joinType(base: string, args: string, suffix: string): string {
  return `${base}${args.trim() ? `(${args.trim()})` : ''}${suffix.trim() ? ` ${suffix.trim()}` : ''}`
}
