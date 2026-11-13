import { execSync } from 'node:child_process'
import { defineConfig, type Plugin } from 'vite'

/**
 * Which build this is: the commit's short SHA, with `-dirty` when tracked files had changes
 * that are not in it - so a build from uncommitted work can never pass for that commit.
 * Untracked files (plans, scratch projects) do not count. Outside a git checkout: 'dev'.
 */
function release(): string {
  try {
    const sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
    const dirty = execSync('git status --porcelain --untracked-files=no', { encoding: 'utf8' }).trim() !== ''
    return dirty ? `${sha}-dirty` : sha
  } catch {
    return 'dev'
  }
}

const RELEASE = release()

/** Also written as dist/version.txt, so what is deployed can be read with curl. */
const versionFile = (): Plugin => ({
  name: 'warren-version-file',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'version.txt', source: `${RELEASE}\n` })
  },
})

export default defineConfig({
  base: './',
  define: { __WARREN_RELEASE__: JSON.stringify(RELEASE) },
  plugins: [versionFile()],
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  server: { open: true },
})
