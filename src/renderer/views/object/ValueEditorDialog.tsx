import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CellValue } from '@shared/model'
import { toHex } from '@shared/bytes'
import { Button, Dialog, SegmentedTabs, Textarea } from '../../components/ui'

type Mode = 'text' | 'hex' | 'json'

function fromHex(hex: string): Uint8Array | null {
  const clean = hex.replace(/^0x/i, '').replace(/\s+/g, '')
  if (clean.length % 2 || /[^0-9a-f]/i.test(clean)) return null
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** Editor for long text, JSON and binary values. */
export function ValueEditorDialog({ column, value, readOnly, onClose, onSave }: { column: string; value: CellValue; readOnly?: boolean; onClose(): void; onSave(v: CellValue): void }) {
  const { t } = useTranslation()
  const isBinary = value instanceof Uint8Array
  const initialMode: Mode = isBinary ? 'hex' : typeof value === 'string' && /^\s*[[{]/.test(value) ? 'json' : 'text'
  const [mode, setMode] = useState<Mode>(initialMode)
  const initialText = useMemo(() => {
    if (value === null) return ''
    if (value instanceof Uint8Array) return toHex(value).replace(/(.{2})/g, '$1 ').trim()
    if (initialMode === 'json') {
      try {
        return JSON.stringify(JSON.parse(value as string), null, 2)
      } catch {
        return String(value)
      }
    }
    return String(value)
  }, [value, initialMode])
  const [text, setText] = useState(initialText)
  const [error, setError] = useState<string | null>(null)

  const save = (): void => {
    if (mode === 'hex') {
      const bytes = fromHex(text)
      if (!bytes) return setError('Invalid hex')
      return onSave(bytes)
    }
    if (mode === 'json') {
      try {
        return onSave(JSON.stringify(JSON.parse(text)))
      } catch (e) {
        return setError((e as Error).message)
      }
    }
    onSave(text)
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`${t('data.blobEditor')} — ${column}`}
      width={760}
      height={560}
      footer={
        <>
          {error && <span className="mr-auto text-xs text-danger">{error}</span>}
          <span className="mr-auto text-xs text-muted">{isBinary ? t('data.bytes', { count: (value as Uint8Array).length }) : `${text.length} chars`}</span>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          {!readOnly && (
            <Button variant="primary" onClick={save}>
              {t('common.apply')}
            </Button>
          )}
        </>
      }
    >
      <div className="flex h-full flex-col">
        <SegmentedTabs
          value={mode}
          onChange={(m) => {
            setError(null)
            setMode(m)
          }}
          items={[
            { value: 'text', label: t('data.textMode') },
            { value: 'hex', label: t('data.hexMode') },
            { value: 'json', label: t('data.jsonMode') }
          ]}
        />
        <Textarea className="m-3 min-h-0 flex-1 resize-none" value={text} readOnly={readOnly} onChange={(e) => setText(e.target.value)} />
      </div>
    </Dialog>
  )
}
