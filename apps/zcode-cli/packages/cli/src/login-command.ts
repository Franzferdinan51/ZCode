import { formatJson } from "@zcode/core";
import type { GlobalOptions, RunContext } from "@zcode/shared-types";
import { loadBootstrapModule } from "./bootstrap-loader.js";
import { loadCliDotenv } from "./env.js";
import type { RunDependencies } from "./cli-types.js";

export async function runLogoutCommand(
  ctx: RunContext,
  options: GlobalOptions,
  deps: RunDependencies,
): Promise<number> {
  try {
    const env = deps.env ?? process.env;
    const workingDirectory = (deps.cwd ?? process.cwd)();
    const dotenvResult = (deps.loadDotenv ?? loadCliDotenv)({
      cwd: workingDirectory,
      env,
    });

    if (dotenvResult.error) {
      throw new Error(`Failed to load environment file: ${dotenvResult.path}`, {
        cause: dotenvResult.error,
      });
    }

    const logout = deps.logoutZCodeCli ?? (await loadBootstrapModule()).logoutZCodeCli;
    const result = await logout({ env });

    if (options.json) {
      ctx.stdout.write(
        formatJson({
          status: "logged_out",
          provider: "zai",
          credentialsPath: result.credentialsPath,
        }),
      );
      return 0;
    }

    ctx.stdout.write(
      `Logged out from Coding Plan accounts. Credentials: ${result.credentialsPath}\n`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`Error: ${message}\n`);
    if (options.verbose && error instanceof Error && error.stack) {
      ctx.stderr.write(`${error.stack}\n`);
    }
    return 1;
  }
}

