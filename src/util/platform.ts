/**
 * The few things that differ between macOS, Windows and Linux: opening a file or a link in the
 * person's own app, and finding a program on the PATH. Nothing here goes through a shell, so a
 * path or a link is never read as a command.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { childEnv } from "../config.js";

/** The command that opens a file or a link with the person's default app. */
export function opener(target: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "/usr/bin/open", args: [target] };
  // explorer.exe opens a file with its app and a link in the default browser, with no shell in between.
  if (platform === "win32") return { command: "explorer.exe", args: [target] };
  return { command: "xdg-open", args: [target] };
}

/** Opens a file or a link. A machine that cannot is not an error: the path is printed by the caller. */
export function openExternal(target: string): void {
  const { command, args } = opener(target);
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true, env: childEnv() });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* nothing to open with */
  }
}

/**
 * The program to start for a command name. On Windows a program installed with npm is a `.cmd`
 * file, which Node cannot start without a shell; its `.exe` is found instead: on the PATH, or the
 * one the `.cmd` file itself names. Elsewhere the name is returned as it is.
 */
export function resolveExecutable(name: string, platform: NodeJS.Platform = process.platform, searchPath = process.env.PATH ?? ""): string {
  if (platform !== "win32" || path.isAbsolute(name)) return name;
  const dirs = searchPath.split(path.win32.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const exe = path.win32.join(dir, `${name}.exe`);
    if (existsSync(exe)) return exe;
  }
  for (const dir of dirs) {
    const cmd = path.win32.join(dir, `${name}.cmd`);
    if (!existsSync(cmd)) continue;
    const target = exeInShim(readFileSync(cmd, "utf8"));
    if (target) {
      const full = path.win32.join(dir, target);
      if (existsSync(full)) return full;
    }
  }
  return name;
}

/** The `.exe` an npm `.cmd` shim starts, relative to the shim's folder: `"%dp0%\node_modules\...\claude.exe"`. */
export function exeInShim(text: string): string | null {
  const m = /"%~?dp0%?\\([^"]+\.exe)"/i.exec(text);
  return m ? (m[1] as string) : null;
}
