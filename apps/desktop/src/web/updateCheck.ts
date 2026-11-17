/**
 * 检查更新：拉 GitHub 的 latest release，和当前版本号比一下。
 *
 * 设计约束（都是踩过的坑）：
 * - 必须走 Node 的 fetch（主进程内），不能靠 shell / 浏览器栈，这台机器上它们握手会失败；
 * - 必须能失败：超时、断网、404、限流，全部转成 status=unknown，绝不抛给调用方；
 * - 必须能缓存：启动自动检查 + 手动点击不重复打 GitHub（未认证限流 60 次/小时）。
 */

export type UpdateStatus = "latest" | "outdated" | "unknown";

export interface UpdateCheckResult {
  status: UpdateStatus;
  currentVersion: string;
  latestVersion: string | null;
  releaseName: string | null;
  releaseUrl: string | null;
  publishedAt: string | null;
  checkedAt: number;
  /** 失败原因码：NO_RELEASE / TIMEOUT / BAD_TAG / HTTP 4xx / 原始错误信息 */
  error: string | null;
}

export interface CheckForUpdateOptions {
  currentVersion: string;
  repoUrl: string;
  timeoutMs?: number;
  cacheTtlMs?: number;
  /** 忽略缓存，强制重新请求 */
  force?: boolean;
  /** 仅供测试注入 */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1_000;
const USER_AGENT = "ocarina-arranger-update-check";
/** tag 必须是 X.Y 或 X.Y.Z 这类纯数字版本号，否则没法比较 */
const VERSION_PATTERN = /^\d+(?:\.\d+)+$/u;

interface CacheEntry {
  at: number;
  result: UpdateCheckResult;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<UpdateCheckResult>>();

/** 去掉 v 前缀和 +build 后缀：v1.1.2+build.7 -> 1.1.2 */
export function normalizeVersion(raw: string): string {
  return String(raw ?? "")
    .trim()
    .replace(/^v/iu, "")
    .split("+")[0]
    ?.trim() ?? "";
}

function parseVersion(raw: string): { numbers: number[]; prerelease: boolean } {
  const clean = normalizeVersion(raw);
  const dashIndex = clean.indexOf("-");
  const core = dashIndex >= 0 ? clean.slice(0, dashIndex) : clean;
  const numbers = core.split(".").map((part) => {
    const value = Number.parseInt(part, 10);
    return Number.isFinite(value) ? value : 0;
  });

  while (numbers.length < 3) {
    numbers.push(0);
  }

  return { numbers, prerelease: dashIndex >= 0 };
}

/**
 * 按数字分段比较，不是字符串比较：1.1.10 > 1.1.9。
 * 返回 1 表示 a 更新，-1 表示 b 更新，0 相同。预发布版（1.2.3-beta）小于正式版。
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  const length = Math.max(left.numbers.length, right.numbers.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = left.numbers[index] ?? 0;
    const rightPart = right.numbers[index] ?? 0;

    if (leftPart !== rightPart) {
      return leftPart > rightPart ? 1 : -1;
    }
  }

  if (left.prerelease === right.prerelease) {
    return 0;
  }

  return left.prerelease ? -1 : 1;
}

/** https://github.com/owner/repo(.git) -> https://api.github.com/repos/owner/repo/releases/latest */
export function releasesApiUrl(repoUrl: string): string {
  const match = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/iu.exec(repoUrl.trim());

  if (!match?.[1] || !match[2]) {
    throw new Error(`Unsupported repository URL: ${repoUrl}`);
  }

  return `https://api.github.com/repos/${match[1]}/${match[2]}/releases/latest`;
}

const TLS_CERT_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
]);

function describeFetchError(error: unknown): string {
  if (error instanceof Error) {
    // undici 把真正的原因藏在 cause 里：证书问题单独分类，前端好给一句人话
    const causeCode = (error as { cause?: { code?: unknown } }).cause?.code;

    if (typeof causeCode === "string" && TLS_CERT_CODES.has(causeCode)) {
      return "TLS_CERT";
    }

    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return "TIMEOUT";
    }

    return error.message || "FETCH_FAILED";
  }

  return String(error);
}

async function fetchLatestRelease(input: {
  url: string;
  currentVersion: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
}): Promise<UpdateCheckResult> {
  const checkedAt = Date.now();
  const base = {
    currentVersion: input.currentVersion,
    latestVersion: null,
    releaseName: null,
    releaseUrl: null,
    publishedAt: null,
    checkedAt,
    error: null,
  } satisfies Omit<UpdateCheckResult, "status">;

  try {
    const response = await input.fetchImpl(input.url, {
      headers: { accept: "application/vnd.github+json", "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(input.timeoutMs),
    });

    if (response.status === 404) {
      return { ...base, status: "unknown", error: "NO_RELEASE" };
    }

    if (!response.ok) {
      return { ...base, status: "unknown", error: `HTTP ${response.status}` };
    }

    const payload = (await response.json()) as {
      tag_name?: unknown;
      name?: unknown;
      html_url?: unknown;
      published_at?: unknown;
    };
    const rawTag = normalizeVersion(typeof payload.tag_name === "string" ? payload.tag_name : "");
    const latestVersion = VERSION_PATTERN.test(rawTag) ? rawTag : "";

    if (!latestVersion) {
      return { ...base, status: "unknown", error: "BAD_TAG" };
    }

    return {
      status: compareVersions(latestVersion, input.currentVersion) > 0 ? "outdated" : "latest",
      currentVersion: input.currentVersion,
      latestVersion,
      releaseName: typeof payload.name === "string" ? payload.name : null,
      releaseUrl: typeof payload.html_url === "string" ? payload.html_url : null,
      publishedAt: typeof payload.published_at === "string" ? payload.published_at : null,
      checkedAt,
      error: null,
    };
  } catch (error) {
    return { ...base, status: "unknown", error: describeFetchError(error) };
  }
}

export async function checkForUpdate(options: CheckForUpdateOptions): Promise<UpdateCheckResult> {
  const currentVersion = normalizeVersion(options.currentVersion) || "0.0.0";
  const url = releasesApiUrl(options.repoUrl);
  const ttl = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const cached = cache.get(url);

  if (!options.force && cached && Date.now() - cached.at < ttl) {
    return { ...cached.result, currentVersion };
  }

  const running = inflight.get(url);
  if (running) {
    return { ...(await running), currentVersion };
  }

  const task = fetchLatestRelease({
    url,
    currentVersion,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    fetchImpl: options.fetchImpl ?? fetch,
  }).finally(() => {
    inflight.delete(url);
  });

  inflight.set(url, task);
  const result = await task;
  cache.set(url, { at: Date.now(), result });
  return { ...result, currentVersion };
}
