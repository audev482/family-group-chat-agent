import { defineConfig } from 'vitest/config'

/**
 * Workspace test runner.
 *
 * Package specs live under `<pkg>/tests/` (dsh convention) and import their
 * package sources by relative path, so no alias table is needed;
 * `@deepseek-ai/*` test dependencies resolve from node_modules after
 * `pnpm install`.
 *
 * Specs under the root `tests/` directory cover invariants that hold *between*
 * packages and so cannot belong to any one of them — see `tests/bundles.spec.ts`.
 */
export default defineConfig({
  test: {
    include: ['*/tests/**/*.spec.ts', 'tests/**/*.spec.ts'],
    environment: 'node',
  },
})
