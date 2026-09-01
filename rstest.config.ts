import { defineConfig } from '@rstest/core';

export default defineConfig({
  include: ['tests/**/*.test.ts', 'evals/**/*.eval.ts'],
  testEnvironment: 'node',
});
