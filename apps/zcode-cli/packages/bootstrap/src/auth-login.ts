import {
  createSharedZCodeCredentialStore,
  SHARED_ZCODE_CREDENTIAL_KEYS,
  type SharedZCodeCredentialStore,
} from "@zcode/adapters";
import type { EnvRecord } from "@zcode/adapters/model";
import {
  NodeModelSelectionConfigRepository,
  NodePersonalProviderConfigRepository,
  PERSONAL_PROVIDER_CONFIG_FILE_NAME,
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV,
} from "@zcode/provider-node";
import { readLegacyCliPersonalProviderConfig } from "./app/legacy-cli-personal-provider-config-importer.js";
import { dirname, join } from "node:path";
import {
  createStandaloneAccountIdentityFromSecret,
  hasStandaloneCodingPlanAccess,
  readStandaloneCodingPlanProviders,
  resolveStandaloneCodingPlanProvider,
  standaloneAccountIdentityCredentialKey,
  standaloneAccountProviderCredentialKey,
} from "./app/standalone-account-provider-runtime.js";

export type CodingPlanProviderId = "bigmodel" | "zai";

export interface ConfigureCodingPlanApiKeyOptions {
  apiKey: string;
  credentialStore?: SharedZCodeCredentialStore;
  env?: EnvRecord;
  personalProviderConfigPath?: string;
  providerId: CodingPlanProviderId;
}

export interface ConfigureCodingPlanApiKeyResult {
  configPath: string;
  model: string;
  providerId: CodingPlanProviderId;
}

export interface LogoutZCodeCliOptions {
  credentialStore?: SharedZCodeCredentialStore;
  env?: EnvRecord;
}

export interface LogoutZCodeCliResult {
  credentialsPath: string;
}

export async function hasConfiguredStandaloneCodingPlan(
  options: {
    credentialStore?: SharedZCodeCredentialStore;
    env?: EnvRecord;
  } = {},
): Promise<boolean> {
  const credentialStore =
    options.credentialStore ?? createSharedZCodeCredentialStore({ env: options.env });
  return hasStandaloneCodingPlanAccess(credentialStore, options.env ?? process.env);
}

export class ZCodeCliLoginError extends Error {
  readonly code:
    | "auth_failed"
    | "auth_timeout"
    | "config_update_failed"
    | "credential_write_failed";

  constructor(
    code: ZCodeCliLoginError["code"],
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "ZCodeCliLoginError";
    this.code = code;
  }
}

export async function configureCodingPlanApiKey(
  options: ConfigureCodingPlanApiKeyOptions,
): Promise<ConfigureCodingPlanApiKeyResult> {
  const apiKey = options.apiKey.trim();
  if (!apiKey) {
    throw new ZCodeCliLoginError("config_update_failed", "API key must not be empty.");
  }
  const credentialStore =
    options.credentialStore ?? createSharedZCodeCredentialStore({ env: options.env });
  const configPatch = await persistStandaloneCodingPlanConnection({
    accountIdentity: createStandaloneAccountIdentityFromSecret(apiKey),
    apiKey,
    credentialStore,
    env: options.env ?? process.env,
    personalProviderConfigPath: options.personalProviderConfigPath,
    providerId: options.providerId,
  });
  return {
    configPath: configPatch.path,
    model: configPatch.mainModel,
    providerId: options.providerId,
  };
}

export async function logoutZCodeCli(
  options: LogoutZCodeCliOptions = {},
): Promise<LogoutZCodeCliResult> {
  const credentialStore =
    options.credentialStore ?? createSharedZCodeCredentialStore({ env: options.env });
  const providerIds = (await readStandaloneCodingPlanProviders(options.env ?? process.env)).map(
    ({ providerId }) => providerId,
  );
  const identityKeys = providerIds.map(standaloneAccountIdentityCredentialKey);
  const identities = await credentialStore.loadMany(identityKeys);
  const dynamicApiKeyKeys = providerIds.flatMap((providerId) => {
    const identity = identities[standaloneAccountIdentityCredentialKey(providerId)]?.trim();
    return identity
      ? [
          standaloneAccountProviderCredentialKey({
            providerId,
            accountIdentity: identity,
          }),
        ]
      : [];
  });
  const keys = [
    ...Object.values(SHARED_ZCODE_CREDENTIAL_KEYS),
    ...identityKeys,
    ...dynamicApiKeyKeys,
  ];
  const current = await credentialStore.loadMany(keys);
  await credentialStore.deleteIfValues(
    Object.fromEntries(
      Object.entries(current).flatMap(([key, value]) => (value === null ? [] : [[key, value]])),
    ),
  );
  return {
    credentialsPath: credentialStore.filePath,
  };
}

interface StandaloneCodingPlanPersistenceResult {
  readonly mainModel: string;
  readonly path: string;
}

async function persistStandaloneCodingPlanConnection(input: {
  readonly accountIdentity: string;
  readonly apiKey: string;
  readonly credentialStore: SharedZCodeCredentialStore;
  readonly env: EnvRecord;
  readonly personalProviderConfigPath?: string;
  readonly providerId: CodingPlanProviderId;
}): Promise<StandaloneCodingPlanPersistenceResult> {
  const configuredProvider = await resolveStandaloneCodingPlanProvider(input.providerId, input.env);
  const providerId = configuredProvider.providerId;
  const modelId = configuredProvider.modelId;
  const credentialKey = standaloneAccountProviderCredentialKey({
    providerId,
    accountIdentity: input.accountIdentity,
  });
  await input.credentialStore.saveMany({
    [standaloneAccountIdentityCredentialKey(providerId)]: input.accountIdentity,
    [credentialKey]: input.apiKey,
  });
  const path =
    input.personalProviderConfigPath ??
    input.env[ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]?.trim() ??
    join(dirname(input.credentialStore.filePath), PERSONAL_PROVIDER_CONFIG_FILE_NAME);
  // 登录与运行时共享文件和事务；首次写入仍先保留旧用户 Provider，不能仅写默认值。
  const personalRepository = new NodePersonalProviderConfigRepository({
    filePath: path,
    importLegacy: () => readLegacyCliPersonalProviderConfig({}),
    pollingIntervalMs: false,
  });
  const repository = new NodeModelSelectionConfigRepository({ personalRepository });
  try {
    await repository.saveConfiguredDefault({ providerId, modelId });
  } finally {
    repository.dispose();
    personalRepository.dispose();
  }
  return {
    mainModel: `${providerId}/${modelId}`,
    path,
  };
}
