import { posix } from "node:path";
import { HttpError, type CustomPublishOptions, type PackageFileInfo } from "builder-util-runtime";
import {
  DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  isLocalUpdateManifestUrl,
  normalizeZCodeEndpointOrigin,
  type ElectronReleaseChannel,
} from "@zcode/shared";
import {
  Provider,
  AppImageUpdater,
  DebUpdater,
  RpmUpdater,
  PacmanUpdater,
  type AppUpdater,
  type ResolvedUpdateFileInfo,
  type UpdateFileInfo,
  type UpdateInfo,
} from "electron-updater";
import type { ProviderRuntimeOptions } from "electron-updater/out/providers/Provider.js";
import { parse as parseYaml } from "yaml";

const ELECTRON_MANIFEST_API_PATH = "/api/v1/releases/electron/manifest";

const MANIFEST_ACCEPT_HEADER = "application/x-yaml,text/yaml,text/plain,*/*";

// The fork publishes desktop updates only when desktop binaries ship. Until
// our manifest asset exists, GitHub answers 404; report a below-current
// version so electron-updater takes the normal "already up to date" path
// instead of surfacing an error. 404 anywhere else stays loud.
const LOCAL_MANIFEST_NOT_PUBLISHED_VERSION = "0.0.0";

interface ManifestUpdateProviderOptions extends CustomPublishOptions {
  endpointOrigin?: string;
  manifestUrl?: string;
  deviceMid?: string;
  releasePlatform?: string;
  releaseChannel?: ElectronReleaseChannel;
  resolveEndpointOrigin?: () => string | Promise<string>;
  resolveReleaseChannel?: () => ElectronReleaseChannel | Promise<ElectronReleaseChannel>;
}

function normalizeReleaseChannel(channel: string | null | undefined): ElectronReleaseChannel {
  return channel === "preview" ? "preview" : "stable";
}

function mapReleaseChannelToApiValue(channel: ElectronReleaseChannel): string {
  return channel === "preview" ? "3" : "1";
}

function mapElectronReleaseArch(arch: string): string {
  switch (arch) {
    case "arm64":
      return "aarch64";
    case "x64":
      return "x86_64";
    case "ia32":
      return "x86";
    default:
      return arch;
  }
}

function mapElectronReleasePlatform(platform: NodeJS.Platform): string {
  switch (platform) {
    case "win32":
      return "windows";
    case "darwin":
      return "darwin";
    case "linux":
      return "linux";
    default:
      return platform;
  }
}

export function getElectronReleasePlatform(
  platform: NodeJS.Platform = process.platform,
  arch = process.env["TEST_UPDATER_ARCH"] || process.arch,
): string {
  return `${mapElectronReleasePlatform(platform)}-${mapElectronReleaseArch(arch)}`;
}

function buildElectronManifestUrl(options: {
  endpointOrigin: string;
  manifestUrl?: string;
  platform: string;
  deviceMid?: string;
  channel: ElectronReleaseChannel;
}): URL {
  const url = options.manifestUrl?.trim()
    ? new URL(options.manifestUrl.trim())
    : new URL(ELECTRON_MANIFEST_API_PATH, normalizeZCodeEndpointOrigin(options.endpointOrigin));
  url.searchParams.set("platform", options.platform);
  if (options.deviceMid?.trim()) {
    url.searchParams.set("device_mid", options.deviceMid.trim());
  }
  url.searchParams.set("channel", mapReleaseChannelToApiValue(options.channel));
  return url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function readManifestFileList(updateInfo: UpdateInfo): UpdateFileInfo[] {
  if (Array.isArray(updateInfo.files) && updateInfo.files.length > 0) {
    return updateInfo.files;
  }

  const legacyInfo = updateInfo as UpdateInfo & {
    path?: unknown;
    sha2?: unknown;
    sha512?: unknown;
  };
  if (typeof legacyInfo.path === "string") {
    return [
      {
        url: legacyInfo.path,
        ...(typeof legacyInfo.sha2 === "string" ? { sha2: legacyInfo.sha2 } : {}),
        ...(typeof legacyInfo.sha512 === "string" ? { sha512: legacyInfo.sha512 } : {}),
      } as UpdateFileInfo,
    ];
  }

  throw new Error("Manifest update info does not contain files or path");
}

function resolveManifestUrl(pathname: string, baseUrl: URL): URL {
  return new URL(pathname, baseUrl);
}

function getLinuxUpdateExtensions(updater: AppUpdater): readonly string[] | null {
  // The real Linux updater depends on the installed package type; deb/rpm/pacman
  // must not be deleted as "unsupported". Reuse the existing updater instance
  // so install-type reads cannot disagree.
  if (updater instanceof AppImageUpdater) return [".appimage"];
  if (updater instanceof DebUpdater) return [".deb"];
  if (updater instanceof RpmUpdater) return [".rpm"];
  if (updater instanceof PacmanUpdater) return [".pkg.tar.zst", ".pacman"];
  return null;
}

function resolveManifestFiles(
  updateInfo: UpdateInfo,
  baseUrl: URL,
  linuxExtensions: readonly string[] | null,
): ResolvedUpdateFileInfo[] {
  const updateFiles = readManifestFileList(updateInfo).filter((file) => {
    const pathname = resolveManifestUrl(file.url, baseUrl).pathname.toLowerCase();
    return !linuxExtensions || linuxExtensions.some((extension) => pathname.endsWith(extension));
  });
  // When the current format is missing, upstream findFile falls back to other
  // packages or returns undefined, then fails with an illegal cache path /
  // TypeError. Fail at the parse boundary instead: cross-format updates are forbidden.
  if (updateFiles.length === 0) {
    throw new Error(`Manifest contains no update file for ${linuxExtensions?.join(" / ")}`);
  }
  const resolved: ResolvedUpdateFileInfo[] = updateFiles.map((fileInfo) => {
    if (!fileInfo.sha512 && !("sha2" in fileInfo && fileInfo.sha2)) {
      throw new Error(`Manifest file is missing checksum: ${fileInfo.url}`);
    }

    const url = resolveManifestUrl(fileInfo.url, baseUrl);
    // PacmanUpdater still recognizes cache names by the .pacman suffix; .pkg.tar.zst
    // falls back to info.url. Hand the cache a bare file name so a full URL is
    // never spliced into pending/temp-https:/....
    const info = linuxExtensions?.includes(".pkg.tar.zst")
      ? { ...fileInfo, url: posix.basename(decodeURIComponent(url.pathname)) }
      : fileInfo;
    return {
      url,
      info,
    } satisfies ResolvedUpdateFileInfo;
  });

  const packages = isRecord((updateInfo as { packages?: unknown }).packages)
    ? ((updateInfo as { packages?: Record<string, PackageFileInfo> }).packages ?? null)
    : null;
  const packageInfo = packages?.[process.arch] ?? packages?.ia32;
  if (packageInfo && resolved[0]) {
    resolved[0].packageInfo = {
      ...packageInfo,
      path: resolveManifestUrl(packageInfo.path, baseUrl).href,
    };
  }

  return resolved;
}

export class ManifestUpdateProvider extends Provider<UpdateInfo> {
  private readonly options: ManifestUpdateProviderOptions;
  private readonly releasePlatform: string;
  private readonly linuxExtensions: readonly string[] | null;
  private resolveBaseUrl = new URL(DEFAULT_ZCODE_ENDPOINT_ORIGIN);

  constructor(
    options: ManifestUpdateProviderOptions,
    updater: AppUpdater,
    runtimeOptions: ProviderRuntimeOptions,
  ) {
    super(runtimeOptions);
    this.options = options;
    this.linuxExtensions = getLinuxUpdateExtensions(updater);
    this.releasePlatform = options.releasePlatform?.trim() || getElectronReleasePlatform();
    this.resolveBaseUrl = new URL(
      normalizeZCodeEndpointOrigin(options.endpointOrigin ?? DEFAULT_ZCODE_ENDPOINT_ORIGIN),
    );
  }

  override get isUseMultipleRangeRequest(): boolean {
    return false;
  }

  override async getLatestVersion(): Promise<UpdateInfo> {
    const endpointOrigin = await this.resolveEndpointOrigin();
    const releaseChannel = await this.resolveReleaseChannel();
    const manifestUrl = buildElectronManifestUrl({
      endpointOrigin,
      manifestUrl: this.options.manifestUrl,
      platform: this.releasePlatform,
      deviceMid: this.options.deviceMid,
      channel: releaseChannel,
    });
    this.resolveBaseUrl = new URL("/", manifestUrl);
    const releaseChannelApiValue = mapReleaseChannelToApiValue(releaseChannel);

    let raw: string | null;
    try {
      raw = await this.httpRequest(manifestUrl, {
        accept: MANIFEST_ACCEPT_HEADER,
        "X-Platform": this.releasePlatform,
        "X-Release-Channel": releaseChannelApiValue,
        ...(this.options.deviceMid?.trim()
          ? { "X-Device-Mid": this.options.deviceMid.trim() }
          : {}),
      });
    } catch (error) {
      if (
        error instanceof HttpError &&
        error.statusCode === 404 &&
        isLocalUpdateManifestUrl(manifestUrl)
      ) {
        return {
          version: LOCAL_MANIFEST_NOT_PUBLISHED_VERSION,
          zcodeReleaseChannel: releaseChannel,
        } as UpdateInfo;
      }
      throw error;
    }
    if (!raw) {
      throw new Error(`Empty electron update manifest: ${manifestUrl.toString()}`);
    }

    const parsed = parseYaml(raw);
    if (!isRecord(parsed) || typeof parsed.version !== "string") {
      throw new Error(`Invalid electron update manifest: ${manifestUrl.toString()}`);
    }

    return {
      ...(parsed as UpdateInfo),
      // When switching preview/stable, an old manifest request may resolve after the
      // new one. electron-updater's update-available event carries no request channel,
      // so main cannot spot stale results; carry this request's channel back with the
      // UpdateInfo to keep a stale channel from overwriting the update dialog.
      zcodeReleaseChannel: releaseChannel,
    } as UpdateInfo;
  }

  override resolveFiles(updateInfo: UpdateInfo): ResolvedUpdateFileInfo[] {
    return resolveManifestFiles(updateInfo, this.resolveBaseUrl, this.linuxExtensions);
  }

  private async resolveEndpointOrigin(): Promise<string> {
    const resolved =
      (await this.options.resolveEndpointOrigin?.()) ??
      this.options.endpointOrigin ??
      DEFAULT_ZCODE_ENDPOINT_ORIGIN;
    return normalizeZCodeEndpointOrigin(resolved);
  }

  private async resolveReleaseChannel(): Promise<ElectronReleaseChannel> {
    const resolved =
      (await this.options.resolveReleaseChannel?.()) ?? this.options.releaseChannel ?? "stable";
    return normalizeReleaseChannel(resolved);
  }
}
