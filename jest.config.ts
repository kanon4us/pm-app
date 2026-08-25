import path from 'path'
import type { Config } from 'jest'

// Worktrees created under .claude/ are separate checkouts with their own copy of
// the suite, so a run from the main checkout must skip them. But a run from
// *inside* one must not skip itself — its own rootDir contains `.claude`, and a
// bare '/.claude/' pattern would exclude every test it owns.
const insideDotClaude = __dirname.split(path.sep).includes('.claude')
const testPathIgnorePatterns = insideDotClaude ? ['/node_modules/'] : ['/node_modules/', '/.claude/']

// NOTE: deliberately not '<rootDir>/__tests__/...'. Jest expands <rootDir> and
// then converts separators with `replaceAll(/\\(?![$()+.?^{}])/g, '/')`, which
// leaves the backslash before a dot-segment intact as a glob escape. Under
// .claude/ that yields 'D:/repo\.claude/wt/__tests__/**' — where the pattern's
// `\.` matches a bare dot, not the `\.` in the path — so nothing matches and the
// suite silently reports "0 tests". These globs stay rootDir-relative instead;
// `roots` already confines the crawl to rootDir.
const testMatch = (ext: string) => [`**/__tests__/**/*.test.${ext}`]

const config: Config = {
  testPathIgnorePatterns,
  watchPathIgnorePatterns: insideDotClaude ? [] : ['/.claude/'],
  projects: [
    {
      displayName: 'node',
      preset: 'ts-jest',
      testEnvironment: 'node',
      moduleNameMapper: { '^@/(.*)$': '<rootDir>/$1' },
      testMatch: testMatch('ts'),
      testPathIgnorePatterns,
    },
    {
      displayName: 'jsdom',
      preset: 'ts-jest',
      testEnvironment: 'jsdom',
      moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/$1',
        '^antd$': '<rootDir>/__mocks__/antd.tsx',
      },
      testMatch: testMatch('tsx'),
      testPathIgnorePatterns,
      setupFilesAfterEnv: ['<rootDir>/jest.setup.tsx'],
    },
  ],
}

export default config
