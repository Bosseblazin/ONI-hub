/** Start the collector when the Next.js server boots, so history accumulates even with no browser open. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getCollector } = await import("./lib/server/singleton");
    getCollector();
  }
}
