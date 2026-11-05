import { defineConfig } from 'rolldown'

export default defineConfig({
  input: {
    index: 'src/index.ts',
    registry: 'src/registry.ts',
    'system-one': 'src/system-one.ts',
    llm: 'src/llm.ts',
  },
  output: {
    dir: 'dist',
    format: 'esm',
    sourcemap: process.env.SOURCE_MAP === '1',
  },
  external: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/schemastery', 'ws', /^node:/],
})
