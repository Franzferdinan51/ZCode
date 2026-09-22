import { loadBootstrapModule } from "./bootstrap-loader.js";
import { loadCliDotenv } from "./env.js";
import type { RunDependencies } from "./cli-types.js";
import type { CommandCenterApiKeyOptions } from "./command-center/types.js";

export async function configureApiKeyForTui(
  deps: RunDependencies,
  options: CommandCenterApiKeyOptions,
) {
  const configure =
    deps.configureCodingPlanApiKey ?? (await loadBootstrapModule()).configureCodingPlanApiKey;
  return await configure({
    apiKey: options.apiKey,
    env: deps.env ?? process.env,
    providerId: options.providerId,
  });
}

export async function logoutForTui(deps: RunDependencies) {
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
  return await logout({ env });
}
