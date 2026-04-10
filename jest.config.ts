import type { Config } from 'jest'

const config: Config = {
  projects: [
    {
      displayName: 'node',
      preset: 'ts-jest',
      testEnvironment: 'node',
      moduleNameMapper: { '^@/(.*)$': '<rootDir>/$1' },
      testMatch: ['<rootDir>/__tests__/**/*.test.ts'],
    },
    {
      displayName: 'jsdom',
      preset: 'ts-jest',
      testEnvironment: 'jsdom',
      moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/$1',
        '^antd$': '<rootDir>/__mocks__/antd.tsx',
      },
      testMatch: ['<rootDir>/__tests__/**/*.test.tsx'],
      setupFilesAfterEnv: ['<rootDir>/jest.setup.tsx'],
    },
  ],
}

export default config
