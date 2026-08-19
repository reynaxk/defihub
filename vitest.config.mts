import path from "node:path";
import { defineConfig } from "vitest/config";

// Mirrors tsconfig.json's "@/*" -> "./*" path alias. Without this, vitest
// (which has no built-in knowledge of tsconfig path mappings) can't resolve
// an "@/"-aliased import at all - it's not just that DB-touching modules
// threw without DATABASE_URL, "@/..." imports were unresolvable in test
// files for a second, independent reason. This is what actually makes
// lib/security/rate-limit.test.ts's real-Postgres integration tests able to
// import "@/lib/database/client" directly, alongside the "test" npm
// script's dotenv wrapper (see package.json) supplying DATABASE_URL itself.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "."),
    },
  },
});
