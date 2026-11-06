/**
 * Orders items so each comes after the items it depends on. Dependencies on unknown keys are
 * ignored; cycles are broken by emitting the remaining item that comes first in input order, so
 * the result is deterministic and always contains every item exactly once.
 */
export function dependencyOrder<T>(items: readonly T[], key: (item: T) => string, dependsOn: (item: T) => Iterable<string>): T[] {
  const index = new Map<string, number>()
  items.forEach((it, i) => index.set(key(it), i))
  const deps = items.map((it) => {
    const own = key(it)
    const set = new Set<number>()
    for (const d of dependsOn(it)) {
      const j = index.get(d)
      if (j !== undefined && d !== own) set.add(j)
    }
    return set
  })
  const dependents = items.map(() => [] as number[])
  const pending = deps.map((s) => s.size)
  deps.forEach((s, i) => s.forEach((j) => dependents[j].push(i)))

  const done = new Array<boolean>(items.length).fill(false)
  const out: T[] = []
  // Ready items are taken in input order (a small array scan keeps it simple and stable).
  const ready: number[] = []
  pending.forEach((n, i) => n === 0 && ready.push(i))
  const emit = (i: number): void => {
    done[i] = true
    out.push(items[i])
    for (const d of dependents[i]) {
      if (done[d]) continue
      if (--pending[d] === 0) insertSorted(ready, d)
    }
  }
  let scan = 0
  while (out.length < items.length) {
    if (ready.length) {
      emit(ready.shift()!)
      continue
    }
    // Cycle: release the first item still waiting.
    while (done[scan]) scan++
    pending[scan] = 0
    emit(scan)
  }
  return out
}

function insertSorted(a: number[], v: number): void {
  let lo = 0
  let hi = a.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (a[mid] < v) lo = mid + 1
    else hi = mid
  }
  a.splice(lo, 0, v)
}
