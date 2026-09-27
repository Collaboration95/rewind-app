/** @type {import('jest').Config} */
module.exports = {
  clearMocks: true,
  moduleNameMapper: {
    // Shared providers (language, debug mode) persist small UI preferences.
    '^@react-native-async-storage/async-storage$':
      '<rootDir>/node_modules/@react-native-async-storage/async-storage/jest/async-storage-mock',
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
