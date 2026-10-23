import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download } from 'lucide-react'
import type { CellValue } from '@shared/model'
import { toHex } from '@shared/bytes'
import { detectFileType, textBytes, type FileType } from '@domain/fileType'
import { Button, Dialog, SegmentedTabs, Textarea } from '../../components/ui'
import { api } from '../../gateways/api'
import { notify } from '../../stores/toast'
import { formatBytes } from '../../lib/format'

type Mode = 'preview' | 'text' | 'hex' | 'json'

function fromHex(hex: string): Uint8Array | null {
  const clean = hex.replace(/^0x/i, '').replace(/\s+/g, '')
  if (clean.length % 2 || /[^0-9a-f]/i.test(clean)) return null
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** The value as a file: binary values, or text values holding a known file (e.g. an image in a text BLOB). */
function asFile(value: CellValue, charset: string | undefined): { bytes: Uint8Array; type: FileType | null } | null {
  if (value instanceof Uint8Array) return { bytes: value, type: detectFileType(value) }
  if (typeof value !== 'string') return null
  const bytes = textBytes(value, charset)
  const type = bytes && detectFileType(bytes)
  return bytes && type ? { bytes, type } : null
}

function Preview({ bytes, type, onSize }: { bytes: Uint8Array; type: FileType; onSize(size: string): void }) {
  // Created and revoked by the same effect: StrictMode's extra cleanup would revoke a memoized URL.
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    const u = URL.createObjectURL(new Blob([bytes as BlobPart], { type: type.mime }))
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [bytes, type])
  if (!url) return null
  if (type.preview === 'pdf') return <iframe title={type.label} src={url} className="min-h-0 flex-1 border-0" />
  return (
    <div className="ost-checkerboard m-3 flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-md border border-border">
      <img
        src={url}
        alt=""
        className="max-h-full max-w-full object-contain"
        draggable={false}
        onLoad={(e) => onSize(`${e.currentTarget.naturalWidth}×${e.currentTarget.naturalHeight}`)}
      />
    </div>
  )
}

/** Editor for long text, JSON and binary values, with a preview of images and PDFs. */
export function ValueEditorDialog({
  column,
  value,
  charset,
  readOnly,
  onClose,
  onSave
}: {
  column: string
  value: CellValue
  /** Column charset: text values holding a file are encoded back with it. */
  charset?: string
  readOnly?: boolean
  onClose(): void
  onSave(v: CellValue): void
}) {
  const { t } = useTranslation()
  const isBinary = value instanceof Uint8Array
  const file = useMemo(() => asFile(value, charset), [value, charset])
  const initialMode: Mode = file?.type?.preview ? 'preview' : isBinary ? 'hex' : typeof value === 'string' && /^\s*[[{]/.test(value) ? 'json' : 'text'
  const [mode, setMode] = useState<Mode>(initialMode)
  const [dimensions, setDimensions] = useState<string | null>(null)
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

  /** Saves the value to a file: the detected file, raw bytes, or the text. */
  const exportValue = async (): Promise<void> => {
    const ext = file?.type?.extension ?? (isBinary ? 'bin' : 'txt')
    const target = await api.invoke('dialog:saveFile', {
      title: t('data.exportValue'),
      defaultPath: `${column}.${ext}`,
      filters: [{ name: file?.type?.label ?? ext.toUpperCase(), extensions: [ext] }, { name: '*', extensions: ['*'] }]
    })
    if (!target) return
    try {
      if (file) await api.invoke('fs:writeBytes', target, file.bytes)
      else await api.invoke('fs:writeText', target, typeof value === 'string' ? value : String(value ?? ''))
      notify.success(t('data.exported', { file: target }))
    } catch (err) {
      notify.error(err)
    }
  }

  const info = file
    ? [file.type?.label, dimensions, formatBytes(file.bytes.length)].filter(Boolean).join(' · ')
    : isBinary
      ? t('data.bytes', { count: (value as Uint8Array).length })
      : `${text.length} chars`

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
          <span className="mr-auto text-xs text-muted">{info}</span>
          {value !== null && (
            <Button icon={<Download size={14} />} onClick={() => void exportValue()}>
              {t('data.exportValue')}
            </Button>
          )}
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          {!readOnly && mode !== 'preview' && (
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
            ...(file?.type?.preview ? [{ value: 'preview' as const, label: t('data.previewMode') }] : []),
            { value: 'text', label: t('data.textMode') },
            { value: 'hex', label: t('data.hexMode') },
            { value: 'json', label: t('data.jsonMode') }
          ]}
        />
        {mode === 'preview' && file?.type?.preview ? (
          <Preview bytes={file.bytes} type={file.type} onSize={setDimensions} />
        ) : (
          <Textarea className="m-3 min-h-0 flex-1 resize-none" value={text} readOnly={readOnly} onChange={(e) => setText(e.target.value)} />
        )}
      </div>
    </Dialog>
  )
}
