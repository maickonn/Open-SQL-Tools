import { useTranslation } from 'react-i18next'
import { Copy, FileDown } from 'lucide-react'
import type { GridSelection } from '@glideapps/glide-data-grid'
import { PointMenu } from '../../components/ui/PointMenu'
import type { MenuItem } from '../../components/ui'
import type { ResultSet } from '../../lib/resultSet'
import { serializeRows, type CopyFormat } from '../../lib/clipboard'
import { fullText } from '../../lib/format'
import { selectedRows } from '../../components/grid/ResultGrid'
import { useUi } from '../../stores/uiStore'
import { notify } from '../../stores/toast'
import { api } from '../../gateways/api'

export interface GridMenuState {
  x: number
  y: number
  row: number
  col: number
  selection: GridSelection
}

/** Copy/export menu shared by read-only result grids. Editable grids append their own items. */
export function GridContextMenu({
  menu,
  onClose,
  result,
  sessionId,
  extra,
  tableName,
  resolveRows,
  copy: withCopy = true
}: {
  menu: GridMenuState | null
  onClose(): void
  result: ResultSet
  /** Loads values the grid only previews (LOBs) and returns these rows in order. */
  resolveRows?(rows: number[]): Promise<ResultSet>
  /** Show the copy items (off on large-object cells, which export instead). */
  copy?: boolean
  sessionId: string
  extra?: MenuItem[]
  tableName?: string
}) {
  const { t } = useTranslation()
  const rows = menu ? selectedRows(menu.selection) : []
  const target = rows.length ? rows : menu ? [menu.row] : []
  const rowsFor = async (list: number[]): Promise<{ rs: ResultSet; rows: number[] }> =>
    resolveRows ? { rs: await resolveRows(list), rows: list.map((_, i) => i) } : { rs: result, rows: list }
  const write = (text: () => Promise<string>): void => {
    text()
      .then((s) => navigator.clipboard.writeText(s))
      .catch((err) => notify.error(err))
  }
  const copy = (format: CopyFormat): void =>
    write(async () => {
      const { rs, rows: list } = await rowsFor(target)
      return serializeRows(rs, list, format, tableName)
    })
  const copyItems: MenuItem[] = [
    {
      label: t('data.copyCell'),
      icon: <Copy size={14} />,
      shortcut: api.platform === 'darwin' ? '⌘C' : 'Ctrl+C',
      onSelect: () => {
        if (!menu) return
        const { col, row } = menu
        write(async () => {
          const { rs, rows: list } = await rowsFor([row])
          return fullText(rs.get(col, list[0]))
        })
      }
    },
    {
      label: t('data.copyAs'),
      items: [
        { label: t('data.copyTsv'), onSelect: () => copy('tsv') },
        { label: t('data.copyCsv'), onSelect: () => copy('csv') },
        { label: t('data.copySql'), onSelect: () => copy('sql') },
        { label: t('data.copyMarkdown'), onSelect: () => copy('markdown') },
        { label: t('data.copyJson'), onSelect: () => copy('json') }
      ]
    }
  ]
  const items: MenuItem[] = [
    ...(withCopy ? [...copyItems, { separator: true } as MenuItem] : []),
    {
      label: t('menu.exportGrid'),
      icon: <FileDown size={14} />,
      onSelect: () => useUi.getState().openDialog({ kind: 'export', sessionId, source: { sql: result.sql }, result, title: tableName })
    },
    ...(extra?.length ? [{ separator: true } as MenuItem, ...extra] : [])
  ]
  return <PointMenu at={menu} onClose={onClose} items={items} />
}
