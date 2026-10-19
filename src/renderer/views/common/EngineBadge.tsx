import type { DbEngine } from '@shared/model'
import { ENGINE_LABELS } from '@shared/model'

const STYLES: Record<DbEngine, { bg: string; text: string }> = {
  mysql: { bg: '#00758f', text: 'My' },
  mariadb: { bg: '#a0522d', text: 'Ma' },
  postgres: { bg: '#336791', text: 'Pg' },
  firebird: { bg: '#d4502b', text: 'Fb' }
}

export function EngineBadge({ engine, size = 16 }: { engine: DbEngine; size?: number }) {
  const s = STYLES[engine]
  return (
    <span
      title={ENGINE_LABELS[engine]}
      className="inline-flex shrink-0 items-center justify-center rounded font-bold text-white"
      style={{ background: s.bg, width: size, height: size, fontSize: size * 0.5 }}
    >
      {s.text}
    </span>
  )
}
