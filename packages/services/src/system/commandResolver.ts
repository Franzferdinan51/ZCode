import { accessSync, constants as fsConstants } from "node:fs";
import { delimiter as pathDelimiter, join as joinPath } from "node:path";

type ExecutableCheck = (path: string) => boolean;

function isExecutablePath(path: string, isExecutable?: ExecutableCheck): boolean {
  if (isExecutable) {
    return isExecutable(path);
  }
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a bare command name against PATH (honors PATHEXT on win32).
 * Paths are rejected so RPC callers cannot probe arbitrary filesystem locations.
 */
export function resolveCommandOnPath(
  command: string,
  options: {
    env: NodeJS.ProcessEnv;
    isExecutable?: ExecutableCheck;
    platform: NodeJS.Platform;
  },
): string | null {
  if (!/^[\w@+.-]+$/.test(command)) {
    return null;
  }
  const pathEnv = options.env.PATH;
  if (!pathEnv) {
    return null;
  }
  const extensions =
    options.platform === "win32" && !command.includes(".")
      ? (options.env.PATHEXT?.split(";").filter(Boolean) ?? [".EXE", ".CMD", ".BAT", ".COM"])
      : [""];
  for (const entry of pathEnv.split(pathDelimiter)) {
    if (!entry) {
      continue;
    }
    for (const extension of extensions) {
      const candidate = joinPath(entry, `${command}${extension}`);
      if (isExecutablePath(candidate, options.isExecutable)) {
        return candidate;
      }
    }
  }
  return null;
}
