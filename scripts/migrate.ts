import { connectDatabase, migrationDatabaseUrl } from "../lib/db/client";
import { pendingMigrations, runMigrations } from "../lib/db/migrate";

// Usage: npm run db:migrate [-- --check]
// Uses DIRECT_DATABASE_URL (session pooler or direct connection) when set, otherwise DATABASE_URL.
async function main() {
  const check = process.argv.includes("--check");
  const handle = connectDatabase(migrationDatabaseUrl(), { max: 1, prepare: false });
  try {
    if (check) {
      const pending = await pendingMigrations(handle.sql);
      console.log(pending.length ? `Pending migrations: ${pending.join(", ")}` : "Database schema is up to date.");
      process.exitCode = pending.length ? 1 : 0;
      return;
    }
    const result = await runMigrations(handle.sql);
    console.log(`Applied: ${result.applied.join(", ") || "none"}; already present: ${result.skipped.join(", ") || "none"}`);
  } finally {
    await handle.close();
  }
}

main().catch((error) => {
  console.error("Migration failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
