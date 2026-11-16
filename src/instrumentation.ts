/** Start the collector and Operations Agent when the Next.js server boots, so history accumulates even with no browser open. */
export async function register() {
  // In cloud mode (Vercel) nothing persistent runs here: monitoring lives in the home agent (`npm run agent`).
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.IC_MODE !== "cloud") {
    const { home } = await import("./lib/server/singleton");
    home();
  }
}
