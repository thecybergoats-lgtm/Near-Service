module.exports = {
  rootDir: '..',
  testEnvironment: 'node',
  transform: { '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  testMatch: ['<rootDir>/test/**/*.spec.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  collectCoverageFrom: ['src/common/**/*.ts', 'src/modules/**/services/*.ts', 'src/modules/**/domain/*.ts'],
};
