/** @type {import('jest').Config} */
module.exports = {
  clearMocks: true,
  // Half the CPUs: the suite is wall-bound by its slowest file (~26 s), which two
  // workers already reach, so more workers only cost memory. Overridden per run
  // with --maxWorkers (scripts/run-fast-tests.mjs does this).
  maxWorkers: '50%',
  moduleNameMapper: {
    '^expo-notifications$': '<rootDir>/tests/mocks/expo-notifications.ts',
    '^expo-network$': '<rootDir>/tests/mocks/expo-network.ts',
    '^expo-video$': '<rootDir>/tests/mocks/expo-video.tsx',
  },
  preset: 'jest-expo',
  testMatch: ['<rootDir>/tests/**/*.test.ts', '<rootDir>/tests/**/*.test.tsx'],
  collectCoverageFrom: ['App.tsx', 'src/**/*.{ts,tsx}', '!src/**/*.d.ts'],
  coverageReporters: ['text-summary', 'json-summary'],
  coverageThreshold: { global: { statements: 70 } },
};
