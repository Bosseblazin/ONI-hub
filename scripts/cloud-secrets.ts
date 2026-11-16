/**
 * Generate the secrets for a Vercel deployment:
 *   IC_PASSPHRASE_HASH — scrypt hash of the commander passphrase (the passphrase itself is never stored)
 *   IC_AGENT_SECRET    — shared HMAC secret between the home agent and the deployment
 *
 *   npm run cloud:secrets
 * Non-interactive: IC_SETUP_PASSPHRASE=... npm run cloud:secrets
 */
import { randomBytes } from "node:crypto";
import readline from "node:readline";
import { hashPassphrase, MIN_PASSPHRASE } from "../src/lib/auth/crypto";

function ask(q: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    let muted = false;
    out._writeToOutput = (s: string) => {
      if (!muted || s.includes(q)) out.output.write(s);
      else if (s !== "\r\n" && s !== "\n") out.output.write("*");
    };
    rl.question(q, (a) => {
      rl.close();
      process.stdout.write("\n");
      resolve(a);
    });
    muted = true;
  });
}

async function main() {
  let pass = process.env.IC_SETUP_PASSPHRASE ?? "";
  if (!pass) {
    pass = await ask(`Commander passphrase (min ${MIN_PASSPHRASE} chars): `);
    if (pass !== (await ask("Repeat: "))) throw new Error("Passphrases do not match.");
  }
  const hash = hashPassphrase(pass);
  const secret = randomBytes(32).toString("hex");
  console.log(`
Add these to the Vercel project (Settings → Environment Variables → Production), marked Sensitive:

  IC_MODE=cloud
  IC_PASSPHRASE_HASH=${hash}
  IC_AGENT_SECRET=${secret}

Add these to .env.local on the HOME PC:

  IC_RELAY_URL=https://<your-project>.vercel.app
  IC_AGENT_SECRET=${secret}

Keep IC_AGENT_SECRET private: anyone holding it can impersonate your home agent.
To change the passphrase later: rerun this, update IC_PASSPHRASE_HASH in Vercel and redeploy.
Existing sessions stay valid until you revoke them in Home → Signed-in devices.
`);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
