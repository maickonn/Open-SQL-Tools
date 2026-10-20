import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { thirdPartyNotices } from './scripts/thirdPartyNotices.mjs'

const alias = {
  '@shared': resolve(__dirname, 'src/shared'),
  '@domain': resolve(__dirname, 'src/domain'),
  '@application': resolve(__dirname, 'src/application'),
  '@infrastructure': resolve(__dirname, 'src/infrastructure'),
  '@renderer': resolve(__dirname, 'src/renderer')
}

export default defineConfig({
  main: {
    resolve: { alias },
    plugins: [thirdPartyNotices()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // Utility process: one per database session (drivers stay out of main/renderer).
          connectionWorker: resolve(__dirname, 'src/infrastructure/db/worker/connectionWorker.ts'),
          // Child process hosting a SQLite connection (node:sqlite is synchronous, killed to cancel).
          sqliteProcess: resolve(__dirname, 'src/infrastructure/db/sqlite/sqliteProcess.mts')
        }
      }
    }
  },
  preload: {
    resolve: { alias },
    plugins: [thirdPartyNotices()],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias },
    plugins: [react(), tailwindcss(), thirdPartyNotices(['tailwindcss', '@fontsource-variable/inter', '@fontsource-variable/jetbrains-mono'])],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          // Startup window that checks for updates (Windows installs).
          splash: resolve(__dirname, 'src/renderer/splash.html')
        }
      }
    }
  }
})
