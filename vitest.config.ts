import { configDefaults, defineConfig } from "vitest/config";

// `npm run build` writes compiled copies of the tests into dist/. Without this,
// CI (which builds before testing) would run every test twice.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, "dist/**"] },
});