import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, Upload } from 'lucide-react'
import type { CellValue } from '@shared/model'
import { toHex } from '@shared/bytes'
import { binaryText, bytesText, textBytes, type FileType } from '@domain/fileType'
import { Button, Dialog, SegmentedTabs, Textarea } from '../../components/ui'
import { asFile, exportValueFile, importValueFile } from '../../lib/valueFiles'
import { notify } from '../../stores/toast'
import { formatBytes } from '../../lib/format'

type Mode = 'preview' | 'hex' | 'text'

function fromHex(hex: string): Uint8Array | null {
  const clean = hex.replace(/^0x/i, '').replace(/\s+/g, '')
  if (clean.length % 2 || /[^0-9a-f]/i.test(clean)) return null
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
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

/** A known file is only bytes; anything else may be read as text too. */
const hasText = (file: ReturnType<typeof asFile>): boolean => !file?.type

/**
 * Opening view: the preview of a file, the text of text values and empty cells, the bytes of
 * anything else — and of every value of a BLOB column, which holds bytes even when they read as text.
 */
function modeFor(value: CellValue, file: ReturnType<typeof asFile>, charset: string | undefined, blob: boolean): Mode {
  if (file?.type?.preview) return 'preview'
  if (value === null) return 'text'
  if (file?.type || blob || typeof value !== 'string' || binaryText(value, charset)) return 'hex'
  return 'text'
}

const hexOf = (bytes: Uint8Array): string => toHex(bytes).replace(/(.{2})/g, '$1 ').trim()

/** Bytes behind a value: the file, the binary value, or the text in the column charset (UTF-8 otherwise). */
function bytesOf(value: CellValue, file: ReturnType<typeof asFile>, charset: string | undefined): Uint8Array {
  if (file) return file.bytes
  if (value instanceof Uint8Array) return value
  return textBytes(String(value ?? ''), charset) ?? new TextEncoder().encode(String(value ?? ''))
}

function textOf(value: CellValue, mode: Mode, file: ReturnType<typeof asFile>, charset: string | undefined): string {
  if (value === null) return ''
  if (mode === 'hex') return hexOf(bytesOf(value, file, charset))
  return value instanceof Uint8Array ? bytesText(value, charset) : String(value)
}

/** Editor for long text and binary values, with a preview of images and PDFs. */
export function ValueEditorDialog({
  column,
  value,
  charset,
  storesBytes,
  blob = false,
  readOnly,
  onClose,
  onSave
}: {
  column: string
  value: CellValue
  /** Column charset: text values holding a file are encoded back with it. */
  charset?: string
  /** The column keeps bytes as they are: imported files are stored raw instead of as text. */
  storesBytes?: boolean
  /** A BLOB column: values open on their bytes. */
  blob?: boolean
  readOnly?: boolean
  onClose(): void
  onSave(v: CellValue): void
}) {
  const { t } = useTranslation()
  /** The value being edited: the cell's, or a file imported in this dialog. */
  const [current, setCurrent] = useState<CellValue>(value)
  const isBinary = current instanceof Uint8Array
  const file = useMemo(() => asFile(current, charset), [current, charset])
  const [mode, setMode] = useState<Mode>(() => modeFor(current, file, charset, blob))
  const [dimensions, setDimensions] = useState<string | null>(null)
  const [text, setText] = useState(() => textOf(current, mode, file, charset))
  const [error, setError] = useState<string | null>(null)

  const importValue = async (): Promise<void> => {
    try {
      const next = await importValueFile(!!storesBytes)
      if (next === undefined) return
      const nextFile = asFile(next, charset)
      const nextMode = modeFor(next, nextFile, charset, blob)
      setCurrent(next)
      setDimensions(null)
      setMode(nextMode)
      setText(textOf(next, nextMode, nextFile, charset))
      setError(null)
    } catch (err) {
      notify.error(err)
    }
  }

  /**
   * The value with the edits of the open tab, which is the source of truth: the other tabs are
   * rendered from it. Keeps the value's kind (text stays text, bytes stay bytes). Null on invalid hex.
   */
  const commit = (): { value: CellValue } | null => {
    // Untouched: the value as it came (a text value isn't turned into bytes by the hex view).
    if (mode === 'preview' || text === textOf(current, mode, file, charset)) return { value: current }
    if (mode === 'hex') {
      const bytes = fromHex(text)
      if (!bytes) {
        setError(t('data.invalidHex'))
        return null
      }
      return { value: typeof current === 'string' ? bytesText(bytes, charset) : bytes }
    }
    return { value: current instanceof Uint8Array ? (textBytes(text, charset) ?? new TextEncoder().encode(text)) : text }
  }

  const switchTo = (next: Mode): void => {
    const committed = commit()
    if (!committed) return
    const nextFile = asFile(committed.value, charset)
    setError(null)
    setCurrent(committed.value)
    // An edit can turn the value into a previewable file, or into something that no longer is.
    const target = next === 'preview' && !nextFile?.type?.preview ? 'hex' : next
    setMode(target)
    setText(textOf(committed.value, target, nextFile, charset))
  }

  const save = (): void => {
    const committed = commit()
    if (committed) onSave(committed.value)
  }

  const exportValue = (): void => {
    const committed = commit()
    if (committed) void exportValueFile(column, committed.value, charset).catch((err) => notify.error(err))
  }

  const info = file
    ? [file.type?.label, dimensions, formatBytes(file.bytes.length)].filter(Boolean).join(' · ')
    : isBinary
      ? t('data.bytes', { count: (current as Uint8Array).length })
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
          {!readOnly && (
            <Button icon={<Upload size={14} />} onClick={() => void importValue()}>
              {t('data.importValue')}
            </Button>
          )}
          {current !== null && (
            <Button icon={<Download size={14} />} onClick={exportValue}>
              {t('data.exportValue')}
            </Button>
          )}
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
          onChange={switchTo}
          items={[
            ...(file?.type?.preview ? [{ value: 'preview' as const, label: t('data.previewMode') }] : []),
            { value: 'hex', label: t('data.hexMode') },
            ...(hasText(file) ? [{ value: 'text' as const, label: t('data.textMode') }] : [])
          ]}
        />
        {mode === 'preview' && file?.type?.preview ? (
          <Preview bytes={file.bytes} type={file.type} onSize={setDimensions} />
        ) : (
          // Padding on a wrapper: a margin on the full-width textarea overflowed the dialog sideways.
          <div className="flex min-h-0 flex-1 p-3">
            <Textarea className="h-full resize-none" value={text} readOnly={readOnly} onChange={(e) => setText(e.target.value)} />
          </div>
        )}
      </div>
    </Dialog>
  )
}
