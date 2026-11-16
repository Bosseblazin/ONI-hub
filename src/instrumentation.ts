/** Start the collector and Operations Agent when the Next.js server boots, so history accumulates even with no browser open. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { home } = await import("./lib/server/singleton");
    home();
  }
}
