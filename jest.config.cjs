/** @type {import('jest').Config} */
module.exports = {
  clearMocks: true,
  moduleNameMapper: {
    '^expo-notifications$': '<rootDir>/tests/mocks/expo-notifications.ts',
    '^expo-video$': '<rootDir>/tests/mocks/expo-video.tsx',
  },
  preset: 'jest-expo',
  testMatch: ['<rootDir>/tests/**/*.test.ts', '<rootDir>/tests/**/*.test.tsx'],
};
