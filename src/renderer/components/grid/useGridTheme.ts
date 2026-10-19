import { useEffect, useMemo, useState } from 'react'
import type { Theme } from '@glideapps/glide-data-grid'

function readVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/** Re-renders when the document theme attribute changes. */
function useThemeAttribute(): string {
  const [theme, setTheme] = useState(document.documentElement.dataset.theme ?? 'dark')
  useEffect(() => {
    const obs = new MutationObserver(() => setTheme(document.documentElement.dataset.theme ?? 'dark'))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [])
  return theme
}

export interface GridColors {
  null: string
  number: string
  date: string
  danger: string
  dangerSoft: string
  editedBg: string
}

/** Builds a Glide theme from the CSS design tokens. */
export function useGridTheme(fontSize: number): { theme: Partial<Theme>; colors: GridColors } {
  const mode = useThemeAttribute()
  return useMemo(() => {
    const v = readVar
    const theme: Partial<Theme> = {
      accentColor: v('--accent'),
      accentFg: v('--accent-fg'),
      accentLight: v('--selection'),
      textDark: v('--text'),
      textMedium: v('--muted'),
      textLight: v('--subtle'),
      textBubble: v('--text'),
      bgIconHeader: v('--muted'),
      fgIconHeader: v('--panel'),
      textHeader: v('--muted'),
      textHeaderSelected: v('--accent-fg'),
      bgCell: v('--bg'),
      bgCellMedium: v('--panel'),
      bgHeader: v('--panel'),
      bgHeaderHasFocus: v('--hover'),
      bgHeaderHovered: v('--hover'),
      bgBubble: v('--panel-2'),
      bgBubbleSelected: v('--accent'),
      bgSearchResult: 'rgba(229, 184, 92, 0.35)',
      borderColor: v('--border'),
      horizontalBorderColor: v('--border'),
      headerBottomBorderColor: v('--border-strong'),
      drilldownBorder: v('--border-strong'),
      linkColor: v('--accent'),
      cellHorizontalPadding: 8,
      cellVerticalPadding: 3,
      headerFontStyle: `600 ${fontSize}px`,
      baseFontStyle: `${fontSize}px`,
      markerFontStyle: `${Math.max(10, fontSize - 1)}px`,
      fontFamily: "'JetBrains Mono Variable', 'Cascadia Code', Consolas, monospace",
      editorFontSize: `${fontSize}px`,
      lineHeight: 1.4,
      resizeIndicatorColor: v('--accent')
    }
    const colors: GridColors = {
      null: v('--null'),
      number: v('--kw-number'),
      date: v('--kw-date'),
      danger: v('--danger'),
      dangerSoft: v('--danger-soft'),
      editedBg: v('--accent-soft')
    }
    return { theme, colors }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, fontSize])
}
