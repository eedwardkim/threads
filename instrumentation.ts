export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Fail fast on misconfiguration: the database client validates DATABASE_URL and TLS settings
    // without opening a connection or running migrations.
    const { getDatabase } = await import("./lib/db/client");
    getDatabase();
  }
}
