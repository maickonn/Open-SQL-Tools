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
  tableName
}: {
  menu: GridMenuState | null
  onClose(): void
  result: ResultSet
  sessionId: string
  extra?: MenuItem[]
  tableName?: string
}) {
  const { t } = useTranslation()
  const rows = menu ? selectedRows(menu.selection) : []
  const copy = (format: CopyFormat): void => void navigator.clipboard.writeText(serializeRows(result, rows.length ? rows : [menu!.row], format, tableName))
  const items: MenuItem[] = [
    {
      label: t('data.copyCell'),
      icon: <Copy size={14} />,
      shortcut: 'Ctrl+C',
      onSelect: () => menu && void navigator.clipboard.writeText(fullText(result.get(menu.col, menu.row)))
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
    },
    { separator: true },
    {
      label: t('menu.exportGrid'),
      icon: <FileDown size={14} />,
      onSelect: () => useUi.getState().openDialog({ kind: 'export', sessionId, source: { sql: result.sql }, result, title: tableName })
    },
    ...(extra?.length ? [{ separator: true } as MenuItem, ...extra] : [])
  ]
  return <PointMenu at={menu} onClose={onClose} items={items} />
}
