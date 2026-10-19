import { useEffect, useRef, useState, type ReactNode } from 'react'
import { create } from 'zustand'
import { useTranslation } from 'react-i18next'
import { Button, Checkbox, Dialog, Field, Input, type PromptRequest } from './index'

const usePrompts = create<{ queue: PromptRequest[] }>(() => ({ queue: [] }))

const push = (r: PromptRequest): void => usePrompts.setState((s) => ({ queue: [...s.queue, r] }))
const shift = (): void => usePrompts.setState((s) => ({ queue: s.queue.slice(1) }))

export function confirmDialog(title: string, message: ReactNode, danger = false): Promise<boolean> {
  return new Promise((resolve) => push({ kind: 'confirm', title, message, danger, resolve }))
}

export function promptDialog(title: string, label: string, value = '', checkbox?: string): Promise<{ value: string; checked: boolean } | null> {
  return new Promise((resolve) => push({ kind: 'prompt', title, label, value, checkbox, resolve }))
}

/** Renders the head of the prompt queue. Mounted once at the app root. */
export function PromptHost() {
  const { t } = useTranslation()
  const req = usePrompts((s) => s.queue[0])
  const [value, setValue] = useState('')
  const [checked, setChecked] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (req?.kind === 'prompt') {
      setValue(req.value)
      setChecked(false)
      setTimeout(() => inputRef.current?.select(), 30)
    }
  }, [req])

  if (!req) return null

  const close = (result: boolean): void => {
    if (req.kind === 'confirm') req.resolve(result)
    else req.resolve(result && value.trim() ? { value: value.trim(), checked } : null)
    shift()
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && close(false)}
      title={req.title}
      width={440}
      footer={
        <>
          <Button onClick={() => close(false)}>{t('common.cancel')}</Button>
          <Button variant={req.kind === 'confirm' && req.danger ? 'danger' : 'primary'} onClick={() => close(true)}>
            {t('common.ok')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3 p-4"
        onSubmit={(e) => {
          e.preventDefault()
          close(true)
        }}
      >
        {req.kind === 'confirm' ? (
          <div className="text-[13px] leading-relaxed">{req.message}</div>
        ) : (
          <>
            <Field label={req.label}>
              <Input ref={inputRef} value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
            </Field>
            {req.checkbox && <Checkbox checked={checked} onChange={setChecked} label={req.checkbox} />}
          </>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}
