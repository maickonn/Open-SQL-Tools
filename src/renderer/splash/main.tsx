import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles.css'
import '../i18n'
import { SplashView } from './SplashView'

// The main process sets nativeTheme.themeSource from the settings before opening the splash.
const media = window.matchMedia('(prefers-color-scheme: dark)')
const applyTheme = (): void => {
  document.documentElement.dataset.theme = media.matches ? 'dark' : 'light'
}
applyTheme()
media.addEventListener('change', applyTheme)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SplashView />
  </StrictMode>
)
