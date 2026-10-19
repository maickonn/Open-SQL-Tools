import { create } from 'zustand'
import type { DbObjectRef } from '@shared/model'
import type { ResultSet } from '../lib/resultSet'

export type DialogState =
  | { kind: 'settings'; section?: string }
  | { kind: 'export'; sessionId: string; source: { ref?: DbObjectRef; sql?: string; database?: string }; result?: ResultSet; title?: string }
  | { kind: 'dump'; sessionId: string; database?: string }
  | { kind: 'importSql'; sessionId: string; database?: string }
  | { kind: 'importCsv'; sessionId: string; ref?: DbObjectRef }
  | { kind: 'findText'; sessionId: string }
  | { kind: 'users'; sessionId: string }
  | { kind: 'bulkEdit'; sessionId: string; database?: string; schema?: string }
  | { kind: 'copyTable'; sessionId: string; ref: DbObjectRef }
  | { kind: 'about' }
  | { kind: 'shortcuts' }

interface UiVM {
  dialog: DialogState | null
  sidebar: boolean
  logPanel: boolean
  openDialog(d: DialogState): void
  closeDialog(): void
  toggleSidebar(): void
  toggleLog(): void
}

export const useUi = create<UiVM>((set) => ({
  dialog: null,
  sidebar: true,
  logPanel: true,
  openDialog: (dialog) => set({ dialog }),
  closeDialog: () => set({ dialog: null }),
  toggleSidebar: () => set((s) => ({ sidebar: !s.sidebar })),
  toggleLog: () => set((s) => ({ logPanel: !s.logPanel }))
}))
