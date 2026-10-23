import type { CellValue } from '@shared/model'
import { detectFileType, textBytes, type FileType } from '@domain/fileType'
import { api } from '../gateways/api'
import i18n from '../i18n'
import { notify } from '../stores/toast'

/** The value as a file: binary values, or text values holding a known file (e.g. an image in a text BLOB). */
export function asFile(value: CellValue, charset: string | undefined): { bytes: Uint8Array; type: FileType | null } | null {
  if (value instanceof Uint8Array) return { bytes: value, type: detectFileType(value) }
  if (typeof value !== 'string') return null
  const bytes = textBytes(value, charset)
  const type = bytes && detectFileType(bytes)
  return bytes && type ? { bytes, type } : null
}

/**
 * Asks for a file and returns it as a cell value: raw bytes where the column keeps them as they are
 * (binary, or text in a single-byte charset), UTF-8 text otherwise. Null when cancelled.
 */
export async function importValueFile(storesBytes: boolean): Promise<CellValue | undefined> {
  const source = await api.invoke('dialog:openFile', { title: i18n.t('data.importValue'), filters: [{ name: '*', extensions: ['*'] }] })
  if (!source) return undefined
  const bytes = await api.invoke('fs:readBytes', source)
  notify.info(i18n.t('data.imported', { file: source.split(/[\\/]/).pop() }))
  return storesBytes ? bytes : new TextDecoder().decode(bytes)
}

/** Saves a value to a file named after the column: the detected file, raw bytes, or the text. */
export async function exportValueFile(column: string, value: CellValue, charset: string | undefined): Promise<void> {
  const file = asFile(value, charset)
  const ext = file?.type?.extension ?? (value instanceof Uint8Array ? 'bin' : 'txt')
  const target = await api.invoke('dialog:saveFile', {
    title: i18n.t('data.exportValue'),
    defaultPath: `${column}.${ext}`,
    filters: [{ name: file?.type?.label ?? ext.toUpperCase(), extensions: [ext] }, { name: '*', extensions: ['*'] }]
  })
  if (!target) return
  if (file) await api.invoke('fs:writeBytes', target, file.bytes)
  else await api.invoke('fs:writeText', target, typeof value === 'string' ? value : String(value ?? ''))
  notify.success(i18n.t('data.exported', { file: target }))
}
