export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getRepository } = await import("./lib/db/repository");
    getRepository();
  }
}
