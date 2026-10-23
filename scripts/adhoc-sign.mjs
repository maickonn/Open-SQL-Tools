// electron-builder afterPack hook: signs the macOS bundle ad hoc (there is no Developer ID).
// Without it only the main executable carries the linker's signature and the bundle isn't sealed,
// so macOS reports a downloaded copy as "damaged"; signed ad hoc it offers "Open Anyway" instead.
// electron-builder's own ad hoc signing (identity "-") fails on Electron's helpers, hence --deep here.
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

export default async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
}
