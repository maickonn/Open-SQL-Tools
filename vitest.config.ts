import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const alias = {
  '@shared': resolve(__dirname, 'src/shared'),
  '@domain': resolve(__dirname, 'src/domain'),
  '@application': resolve(__dirname, 'src/application'),
  '@infrastructure': resolve(__dirname, 'src/infrastructure')
}

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: { name: 'unit', include: ['tests/unit/**/*.test.ts'], environment: 'node' }
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 60_000,
          hookTimeout: 120_000,
          fileParallelism: false
        }
      }
    ]
  }
})
