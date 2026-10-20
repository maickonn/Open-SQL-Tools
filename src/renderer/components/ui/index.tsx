import { forwardRef, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { clsx } from 'clsx'
import { ContextMenu as RCM, Dialog as RDialog, DropdownMenu as RDM, Menubar as RMB, Tooltip as RTooltip } from 'radix-ui'
import { Check, ChevronRight, Loader2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export const cx = clsx

/* --------------------------------- Buttons -------------------------------- */

type Variant = 'default' | 'primary' | 'ghost' | 'danger'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: 'sm' | 'md'
  icon?: ReactNode
  loading?: boolean
}

const variants: Record<Variant, string> = {
  default: 'bg-panel-2 border border-border hover:bg-hover text-fg',
  primary: 'bg-accent hover:bg-accent-hover text-accent-fg border border-transparent',
  ghost: 'bg-transparent hover:bg-hover text-fg border border-transparent',
  danger: 'bg-danger-soft text-danger border border-transparent hover:brightness-110'
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'md', icon, loading, className, children, disabled, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors select-none',
        'disabled:opacity-50 disabled:pointer-events-none',
        size === 'sm' ? 'h-7 px-2 text-xs' : 'h-8 px-3 text-[13px]',
        variants[variant],
        className
      )}
      {...rest}
    >
      {loading ? <Loader2 size={14} className="animate-spin" /> : icon}
      {children}
    </button>
  )
})

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  active?: boolean
  size?: number
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, active, className, children, size = 28, ...rest },
  ref
) {
  return (
    <Tooltip content={label}>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        style={{ width: size, height: size }}
        className={cx(
          'inline-flex items-center justify-center rounded-md text-muted hover:text-fg hover:bg-hover transition-colors',
          'disabled:opacity-40 disabled:pointer-events-none',
          active && 'bg-active text-fg',
          className
        )}
        {...rest}
      >
        {children}
      </button>
    </Tooltip>
  )
})

/* ---------------------------------- Inputs -------------------------------- */

const fieldBase =
  'w-full h-8 rounded-md bg-sunken border border-border px-2.5 text-[13px] text-fg placeholder:text-subtle outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft transition-colors disabled:opacity-60'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} spellCheck={false} className={cx(fieldBase, className)} {...rest} />
})

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} spellCheck={false} className={cx(fieldBase, 'h-auto py-2 font-mono text-xs resize-y', className)} {...rest} />
})

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <select ref={ref} className={cx(fieldBase, 'pr-7 appearance-none bg-no-repeat bg-[right_0.5rem_center] cursor-pointer', className)} style={{ backgroundImage: CHEVRON }} {...rest}>
      {children}
    </select>
  )
})

const CHEVRON = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`

export function Checkbox({ checked, onChange, label, disabled, className, block }: { checked: boolean; onChange(v: boolean): void; label?: ReactNode; disabled?: boolean; className?: string; block?: boolean }) {
  const labelId = useId()
  return (
    <label className={cx(block ? 'flex' : 'inline-flex', 'items-center gap-2 cursor-pointer select-none text-[13px]', disabled && 'opacity-50 pointer-events-none', className)}>
      <span
        role="checkbox"
        aria-checked={checked}
        aria-disabled={disabled || undefined}
        aria-labelledby={label ? labelId : undefined}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault()
            onChange(!checked)
          }
        }}
        onClick={(e) => {
          e.preventDefault()
          onChange(!checked)
        }}
        className={cx(
          'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors',
          checked ? 'bg-accent border-accent text-accent-fg' : 'border-border-strong bg-sunken'
        )}
      >
        {checked && <Check size={12} strokeWidth={3} />}
      </span>
      {label && <span id={labelId} onClick={() => onChange(!checked)}>{label}</span>}
    </label>
  )
}

export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx('flex flex-col gap-1', className)}>
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-subtle">{hint}</span>}
    </label>
  )
}

/* --------------------------------- Overlays ------------------------------- */

export function Tooltip({ content, children, side = 'bottom' }: { content: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <RTooltip.Root delayDuration={400}>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content side={side} sideOffset={6} className="z-50 rounded-md bg-panel-2 border border-border px-2 py-1 text-xs text-fg shadow-pop">
          {content}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  )
}

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <RTooltip.Provider>{children}</RTooltip.Provider>
}

export interface DialogProps {
  open: boolean
  onOpenChange(open: boolean): void
  title: ReactNode
  children: ReactNode
  footer?: ReactNode
  width?: number | string
  height?: number | string
  className?: string
}

export function Dialog({ open, onOpenChange, title, children, footer, width = 560, height, className }: DialogProps) {
  const { t } = useTranslation()
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[1px]" />
        <RDialog.Content
          style={{ width, height, maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 48px)' }}
          className={cx('fixed left-1/2 top-1/2 z-40 -translate-x-1/2 -translate-y-1/2 flex flex-col rounded-xl border border-border bg-panel shadow-pop outline-none', className)}
          aria-describedby={undefined}
          // Focus the content, not the close button (which would pop its tooltip on open).
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            const el = e.currentTarget as HTMLElement
            // Keep fields that focused themselves (autoFocus); otherwise focus the dialog.
            if (!el.contains(document.activeElement)) el.focus()
          }}
          tabIndex={-1}
        >
          <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-4">
            <RDialog.Title className="text-sm font-semibold">{title}</RDialog.Title>
            <RDialog.Close asChild>
              <IconButton label={t('common.close')}>
                <X size={16} />
              </IconButton>
            </RDialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">{children}</div>
          {footer && <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-4 py-3">{footer}</div>}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  )
}

/* ---------------------------------- Menus --------------------------------- */

export interface MenuItem {
  label?: ReactNode
  icon?: ReactNode
  shortcut?: string
  onSelect?: () => void
  disabled?: boolean
  danger?: boolean
  checked?: boolean
  separator?: boolean
  items?: MenuItem[]
}

const itemClass =
  'relative flex h-7 cursor-default select-none items-center gap-2 rounded-md pl-7 pr-2 text-[13px] outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-fg data-[disabled]:opacity-40'
const contentClass = 'z-50 min-w-[200px] rounded-lg border border-border bg-panel p-1 shadow-pop'

function renderItems(items: MenuItem[], P: typeof RDM | typeof RCM | typeof RMB): ReactNode {
  return items.map((it, i) => {
    if (it.separator) return <P.Separator key={i} className="my-1 h-px bg-border" />
    if (it.items) {
      return (
        <P.Sub key={i}>
          <P.SubTrigger className={itemClass} disabled={it.disabled}>
            <span className="absolute left-2 flex w-4 justify-center">{it.icon}</span>
            {it.label}
            <ChevronRight size={14} className="ml-auto" />
          </P.SubTrigger>
          <P.Portal>
            <P.SubContent className={contentClass} sideOffset={4}>
              {renderItems(it.items, P)}
            </P.SubContent>
          </P.Portal>
        </P.Sub>
      )
    }
    return (
      <P.Item key={i} className={cx(itemClass, it.danger && 'text-danger')} disabled={it.disabled} onSelect={() => it.onSelect?.()}>
        <span className="absolute left-2 flex w-4 justify-center">{it.checked ? <Check size={14} /> : it.icon}</span>
        {it.label}
        {it.shortcut && <span className="ml-auto pl-6 text-[11px] opacity-60">{it.shortcut}</span>}
      </P.Item>
    )
  })
}

export function DropdownMenu({ trigger, items, align = 'start' }: { trigger: ReactNode; items: MenuItem[]; align?: 'start' | 'end' }) {
  return (
    <RDM.Root modal={false}>
      <RDM.Trigger asChild>{trigger}</RDM.Trigger>
      <RDM.Portal>
        <RDM.Content className={contentClass} sideOffset={4} align={align}>
          {renderItems(items, RDM)}
        </RDM.Content>
      </RDM.Portal>
    </RDM.Root>
  )
}

/** Application menu bar: once a menu is open, hovering another trigger switches to it. */
export function Menubar({ menus, className, onOpenChange }: { menus: { label: ReactNode; items: MenuItem[] }[]; className?: string; onOpenChange?(open: boolean): void }) {
  return (
    <RMB.Root className={cx('flex items-center gap-1', className)} onValueChange={(v) => onOpenChange?.(v !== '')}>
      {menus.map((m, i) => (
        <RMB.Menu key={i}>
          <RMB.Trigger className="h-7 rounded-md px-2.5 text-[13px] text-muted outline-none hover:bg-hover hover:text-fg data-[highlighted]:bg-hover data-[state=open]:bg-hover data-[state=open]:text-fg">
            {m.label}
          </RMB.Trigger>
          <RMB.Portal>
            <RMB.Content className={contentClass} sideOffset={4} align="start">
              {renderItems(m.items, RMB)}
            </RMB.Content>
          </RMB.Portal>
        </RMB.Menu>
      ))}
    </RMB.Root>
  )
}

export function ContextMenu({ children, items }: { children: ReactNode; items: MenuItem[] | (() => MenuItem[]) }) {
  return (
    <RCM.Root modal={false}>
      <RCM.Trigger asChild>{children}</RCM.Trigger>
      <RCM.Portal>
        <RCM.Content className={contentClass}>{renderItems(typeof items === 'function' ? items() : items, RCM)}</RCM.Content>
      </RCM.Portal>
    </RCM.Root>
  )
}

/* ---------------------------------- Misc ---------------------------------- */

export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return <Loader2 size={size} className={cx('animate-spin text-muted', className)} />
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-border bg-sunken px-1.5 py-0.5 font-mono text-[10px] text-muted">{children}</kbd>
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-muted">
      {icon && <div className="text-subtle">{icon}</div>}
      <div className="text-sm font-medium text-fg/80">{title}</div>
      {children}
    </div>
  )
}

export function SegmentedTabs<T extends string>({ value, onChange, items, className }: { value: T; onChange(v: NoInfer<T>): void; items: { value: NoInfer<T>; label: ReactNode; icon?: ReactNode }[]; className?: string }) {
  return (
    <div className={cx('flex h-9 shrink-0 items-end gap-0.5 border-b border-border px-2', className)}>
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          onClick={() => onChange(it.value)}
          className={cx(
            '-mb-px flex h-8 items-center gap-1.5 border-b-2 px-3 text-[13px] transition-colors',
            value === it.value ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg'
          )}
        >
          {it.icon}
          {it.label}
        </button>
      ))}
    </div>
  )
}

export function Badge({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'accent' | 'warning' | 'danger' | 'success' }) {
  const tones = {
    default: 'bg-hover text-muted',
    accent: 'bg-accent-soft text-accent',
    warning: 'bg-warning/15 text-warning',
    danger: 'bg-danger-soft text-danger',
    success: 'bg-success/15 text-success'
  }
  return <span className={cx('inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium', tones[tone])}>{children}</span>
}

/** Simple promise-based prompt/confirm dialogs rendered by <DialogHost/>. */
export type PromptRequest =
  | { kind: 'confirm'; title: string; message: ReactNode; danger?: boolean; resolve(v: boolean): void }
  | { kind: 'prompt'; title: string; label: string; value: string; checkbox?: string; resolve(v: { value: string; checked: boolean } | null): void }
