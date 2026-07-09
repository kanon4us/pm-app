// figma-plugin/build.mjs — bundles the main-thread code to a single code.js.
import { build } from 'esbuild'

await build({
  entryPoints: ['figma-plugin/src/code.ts'],
  bundle: true,
  target: 'es2020',
  format: 'iife',
  outfile: 'figma-plugin/code.js',
  logLevel: 'info',
})
