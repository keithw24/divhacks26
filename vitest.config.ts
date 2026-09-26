import { configDefaults, defineConfig } from "vitest/config";

// The DeepSpace backend (backend/) and the website (frontend/) are separate
// packages with their own dependencies and test runners.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "backend/**", "frontend/**"],
  },
});
