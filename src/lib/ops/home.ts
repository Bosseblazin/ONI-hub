import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function run(cmd: string, args: string[], timeoutMs = 8000): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? ((err as unknown as { code: number }).code) : -1) : 0;
      resolve({ code, stdout: String(stdout ?? "") });
    });
  });
}

/**
 * Is Oxygen Not Included running on this PC? Read-only process listing; never touches the game.
 * Returns "unknown" if the platform tool is unavailable.
 */
export async function detectGameProcess(platform = process.platform): Promise<"running" | "stopped" | "unknown"> {
  try {
    if (platform === "win32") {
      const r = await run("tasklist", ["/FI", "IMAGENAME eq OxygenNotIncluded.exe", "/NH", "/FO", "CSV"]);
      if (r.code !== 0) return "unknown";
      return /OxygenNotIncluded\.exe/i.test(r.stdout) ? "running" : "stopped";
    }
    const r = await run("pgrep", ["-f", "-i", "OxygenNotIncluded|Oxygen Not Included"]);
    if (r.code === 0) return "running";
    if (r.code === 1) return "stopped"; // pgrep: no match
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Opt-in desktop screenshots (the OniMcp screenshot resource moves the camera and draws overlays,
 * so it is NOT used). This captures the primary display with OS tools and keeps the newest N files.
 * Captures the whole desktop — only enable on a PC where that is acceptable.
 */
export class ScreenshotService {
  lastCaptureAt: number | null = null;
  lastError: string | null = null;
  constructor(private dir: string, private keep = 24) {}

  async capture(platform = process.platform): Promise<string | null> {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, `screen-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
    let r: { code: number };
    if (platform === "win32") {
      const ps = [
        "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;",
        "$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;",
        "$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;",
        "$g=[System.Drawing.Graphics]::FromImage($bmp);",
        "$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);",
        `$bmp.Save('${file.replace(/'/g, "''")}',[System.Drawing.Imaging.ImageFormat]::Png)`,
      ].join(" ");
      r = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], 20_000);
    } else if (platform === "darwin") {
      r = await run("screencapture", ["-x", file], 20_000);
    } else {
      r = await run("import", ["-window", "root", file], 20_000);
    }
    if (r.code !== 0 || !fs.existsSync(file)) {
      this.lastError = "Screen capture failed (no display, or the OS tool is unavailable).";
      return null;
    }
    this.lastCaptureAt = Date.now();
    this.lastError = null;
    this.prune();
    return file;
  }

  latest(): string | null {
    try {
      const f = fs.readdirSync(this.dir).filter((x) => x.endsWith(".png")).sort();
      return f.length ? path.join(this.dir, f[f.length - 1]!) : null;
    } catch {
      return null;
    }
  }

  private prune() {
    const f = fs.readdirSync(this.dir).filter((x) => x.endsWith(".png")).sort();
    for (const x of f.slice(0, Math.max(0, f.length - this.keep))) fs.unlinkSync(path.join(this.dir, x));
  }
}
