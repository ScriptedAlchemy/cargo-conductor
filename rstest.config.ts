import { defineConfig } from '@rstest/core';

export default defineConfig({
  include: ['tests/**/*.test.ts', 'tests/**/*.eval.ts'],
  testEnvironment: 'node',
});
