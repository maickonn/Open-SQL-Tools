import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import './i18n'
import { App } from './App'
import { useSettings } from './stores/settingsStore'
import { initTabPersistence } from './lib/tabPersistence'

// Settings decide the theme; load them before the first paint.
void useSettings
  .getState()
  .load()
  .finally(() => {
    initTabPersistence()
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <App />
      </StrictMode>
    )
  })
