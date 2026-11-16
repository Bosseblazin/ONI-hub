/**
 * Set (or change) the commander passphrase for remote access. Run on the home PC:
 *   npm run setup
 * Changing it signs out every device. Non-interactive (CI/tests): IC_SETUP_PASSPHRASE=... npm run setup
 */
import path from "node:path";
import readline from "node:readline";
import { AuthService } from "../src/lib/auth/auth";

const dataDir = process.env.IC_DATA_DIR || path.join(process.cwd(), "data");

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
  const auth = new AuthService(dataDir);
  console.log("Interplanetary Command — remote access setup");
  console.log(`Data directory: ${dataDir}`);
  console.log(auth.passphraseSet() ? "A passphrase is already set. Setting a new one signs out all devices.\n" : "No passphrase set yet.\n");
  let pass = process.env.IC_SETUP_PASSPHRASE ?? "";
  if (!pass) {
    pass = await ask("New commander passphrase (min 12 characters; a few random words is ideal): ");
    const again = await ask("Repeat passphrase: ");
    if (pass !== again) {
      console.error("Passphrases do not match.");
      process.exit(1);
    }
  }
  auth.setPassphrase(pass);
  console.log("Passphrase saved (scrypt hash only). All existing sessions were signed out.");
  console.log("Next: see docs/REMOTE_ACCESS.md to reach the dashboard from your phone over Tailscale.");
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
