import { defineConfig } from 'tsdown'

const entry = (path: string) => ({
  entry: [path],
  outDir: 'lib',
  format: ['esm'] as const,
  platform: 'node' as const,
  target: 'es2024' as const,
  fixedExtension: false,
  dts: false,
  clean: false,
})

/** Build the service root and the memory tool plugin as independent Loader entries. */
export default defineConfig([
  entry('lib/types/index.js'),
  entry('lib/types/tools.js'),
])
