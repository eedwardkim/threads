import { parseArgs } from "node:util";
import { connectDatabase, migrationDatabaseUrl } from "../lib/db/client";
import { importSqlite } from "../lib/import/sqlite";

// Usage: npm run db:import-sqlite -- --sqlite /path/to/threads.sqlite --user <auth user uuid> [--dry-run] [--skip-hydrated-demos]
// Uses DIRECT_DATABASE_URL (or DATABASE_URL). The source database is opened read-only and never modified.
async function main() {
  const { values } = parseArgs({
    options: {
      sqlite: { type: "string" },
      user: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "skip-hydrated-demos": { type: "boolean", default: false },
      "allow-unknown-user": { type: "boolean", default: false },
    },
  });
  if (!values.sqlite || !values.user) {
    console.error("Required: --sqlite <path> --user <destination auth user uuid>. Add --dry-run to validate without writing.");
    process.exit(2);
  }
  const handle = connectDatabase(migrationDatabaseUrl(), { max: 1, prepare: false });
  try {
    const report = await importSqlite({
      sqlitePath: values.sqlite, userId: values.user, handle, dryRun: values["dry-run"],
      skipHydratedDemos: values["skip-hydrated-demos"], requireAuthUser: values["allow-unknown-user"] ? false : undefined,
    });
    console.log(JSON.stringify(report, null, 2));
    if (report.errors.length) {
      console.error(`Import ${report.dryRun ? "dry run" : ""} failed validation; nothing was written.`);
      process.exit(1);
    }
    console.log(report.dryRun ? "Dry run complete; nothing was written." : "Import committed and verified.");
  } finally {
    await handle.close();
  }
}

main().catch((error) => {
  console.error("Import failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
