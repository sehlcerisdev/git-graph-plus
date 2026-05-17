import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/__tests__/**',
        'src/**/types.ts',
        // vscode-bound modules — covered by manual testing of the extension,
        // not unit/integration. Excluded so the % reflects testable code.
        'src/extension.ts',
        'src/panels/**',
        'src/views/**',
        'src/services/file-watcher.ts',
        'src/services/git-content-provider.ts',
        'src/utils/**',
        'src/git/vscode-git-bridge.ts',
      ],
    },
  },
});
