import { DropdownMenu as RDM } from 'radix-ui'
import { Check, ChevronRight } from 'lucide-react'
import type { MenuItem } from './index'
import { cx } from './index'

const itemClass =
  'relative flex h-7 cursor-default select-none items-center gap-2 rounded-md pl-7 pr-2 text-[13px] outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-fg data-[disabled]:opacity-40'
const contentClass = 'z-50 min-w-[200px] rounded-lg border border-border bg-panel p-1 shadow-pop'

function Items({ items }: { items: MenuItem[] }) {
  return (
    <>
      {items.map((it, i) => {
        if (it.separator) return <RDM.Separator key={i} className="my-1 h-px bg-border" />
        if (it.items) {
          return (
            <RDM.Sub key={i}>
              <RDM.SubTrigger className={itemClass}>
                <span className="absolute left-2 flex w-4 justify-center">{it.icon}</span>
                {it.label}
                <ChevronRight size={14} className="ml-auto" />
              </RDM.SubTrigger>
              <RDM.Portal>
                <RDM.SubContent className={contentClass} sideOffset={4}>
                  <Items items={it.items} />
                </RDM.SubContent>
              </RDM.Portal>
            </RDM.Sub>
          )
        }
        return (
          <RDM.Item key={i} className={cx(itemClass, it.danger && 'text-danger')} disabled={it.disabled} onSelect={() => it.onSelect?.()}>
            <span className="absolute left-2 flex w-4 justify-center">{it.checked ? <Check size={14} /> : it.icon}</span>
            {it.label}
            {it.shortcut && <span className="ml-auto pl-6 text-[11px] opacity-60">{it.shortcut}</span>}
          </RDM.Item>
        )
      })}
    </>
  )
}

/** Context menu opened at arbitrary viewport coordinates (e.g. inside a canvas grid). */
export function PointMenu({ at, items, onClose }: { at: { x: number; y: number } | null; items: MenuItem[]; onClose(): void }) {
  return (
    <RDM.Root open={!!at} onOpenChange={(o) => !o && onClose()} modal={false}>
      <RDM.Trigger asChild>
        <div style={{ position: 'fixed', left: at?.x ?? 0, top: at?.y ?? 0, width: 0, height: 0 }} />
      </RDM.Trigger>
      <RDM.Portal>
        {/* The trigger is only an anchor point: returning focus to it would pull focus out of an open dialog. */}
        <RDM.Content className={contentClass} align="start" sideOffset={2} onCloseAutoFocus={(e) => e.preventDefault()}>
          <Items items={items} />
        </RDM.Content>
      </RDM.Portal>
    </RDM.Root>
  )
}
