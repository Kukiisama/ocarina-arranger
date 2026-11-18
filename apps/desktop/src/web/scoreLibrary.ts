/**
 * 谱面库：从 GitHub 仓库读 index.json 和单个谱面文件。
 *
 * 三个源，按顺序尝试：
 *   1. GitHub Contents API（不走 CDN，永远是最新的提交内容）
 *   2. jsDelivr CDN（快，但分支文件有小时级缓存，可能滞后）
 *   3. raw.githubusercontent.com（没有长时间缓存，但部分网络环境不通）
 *
 * 目录结构（ocarina-scores 仓库）：
 *   index.json              [ { id, title, author, file, notes? }, ... ]
 *   scores/<id>.json        编辑器导出的原样 JSON
 */

export interface ScoreEntry {
  id: string;
  title: string;
  author: string;
  file: string;
  notes: number | null;
}

export type ScoreIndexResult =
  | { ok: true; scores: ScoreEntry[]; source: string }
  | { ok: false; error: string };

const DEFAULT_REPO = "Kukiisama/ocarina-scores";
const DEFAULT_BRANCH = "main";
const DEFAULT_TIMEOUT_MS = 5_000;
const INDEX_CACHE_TTL_MS = 10 * 60 * 1_000;
const FILE_CACHE_TTL_MS = 30 * 60 * 1_000;

interface CacheEntry<T> {
  at: number;
  value: T;
}

interface RequestTarget {
  url: string;
  accept: string;
  label: string;
}

const indexCache = new Map<string, CacheEntry<{ scores: ScoreEntry[]; source: string }>>();
const fileCache = new Map<string, CacheEntry<string>>();

/**
 * 可用源，按优先级排。`api:` 前缀表示走 GitHub Contents API，
 * 后面跟 `@分支`。OCARINA_SCORES_BASE_URL 可整体替换（本地调试用）。
 */
export function resolveScoreSources(): string[] {
  const explicit = process.env.OCARINA_SCORES_BASE_URL?.trim();
  if (explicit) {
    return [explicit.replace(/\/+$/u, "")];
  }

  const repo = process.env.OCARINA_SCORES_REPO?.trim() || DEFAULT_REPO;
  const branch = process.env.OCARINA_SCORES_BRANCH?.trim() || DEFAULT_BRANCH;

  return [
    `api:https://api.github.com/repos/${repo}/contents@${branch}`,
    `https://cdn.jsdelivr.net/gh/${repo}@${branch}`,
    `https://raw.githubusercontent.com/${repo}/${branch}`,
  ];
}

function encodePath(relativePath: string): string {
  return relativePath
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

/** 把「源 + 相对路径」拼成真正要请求的 URL，并带上对应的 Accept。 */
function targetFor(source: string, relativePath: string, buster: string): RequestTarget {
  if (source.startsWith("api:")) {
    const rest = source.slice(4);
    const at = rest.lastIndexOf("@");
    const base = at >= 0 ? rest.slice(0, at) : rest;
    const branch = at >= 0 ? rest.slice(at + 1) : DEFAULT_BRANCH;
    const query = "ref=" + encodeURIComponent(branch) + (buster ? "&" + buster : "");

    return {
      url: base + "/" + encodePath(relativePath) + "?" + query,
      accept: "application/vnd.github.raw",
      label: "GitHub API",
    };
  }

  return {
    url: source + "/" + encodePath(relativePath) + (buster ? "?" + buster : ""),
    accept: "application/json",
    label: source,
  };
}

function normalizeEntry(raw: unknown): ScoreEntry | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const item = raw as Record<string, unknown>;
  const id = typeof item.id === "string" ? item.id.trim() : "";
  const title = typeof item.title === "string" ? item.title.trim() : "";
  const author = typeof item.author === "string" ? item.author.trim() : "";
  const file = typeof item.file === "string" ? item.file.trim() : "";
  const notes = typeof item.notes === "number" && Number.isFinite(item.notes) ? item.notes : null;

  // id 只允许安全字符：它会被拼进 URL 和缓存键
  if (!id || !title || !file || !/^[\w.-]+$/u.test(id)) {
    return null;
  }

  return { id, title, author: author || "未知作者", file, notes };
}

function normalizeIndex(payload: unknown): ScoreEntry[] {
  const rawList = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { scores?: unknown }).scores)
      ? (payload as { scores: unknown[] }).scores
      : [];

  return rawList
    .map((item) => normalizeEntry(item))
    .filter((item): item is ScoreEntry => item !== null);
}

async function fetchText(
  target: RequestTarget,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  try {
    const response = await fetchImpl(target.url, {
      headers: { accept: target.accept, "user-agent": "ocarina-arranger" },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }

    return { ok: true, text: await response.text() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

/**
 * 读目录。多个源依次尝试，第一个成功的缓存 10 分钟。
 */
export async function loadScoreIndex(options: {
  fetchImpl: typeof fetch;
  sources: string[];
  force?: boolean;
  timeoutMs?: number;
}): Promise<ScoreIndexResult> {
  const key = options.sources.join("|");
  const cached = indexCache.get(key);

  if (!options.force && cached && Date.now() - cached.at < INDEX_CACHE_TTL_MS) {
    return { ok: true, scores: cached.value.scores, source: cached.value.source };
  }

  const errors: string[] = [];
  const buster = options.force ? `t=${Date.now()}` : "";

  for (const source of options.sources) {
    const target = targetFor(source, "index.json", buster);
    const result = await fetchText(target, options.fetchImpl, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    if (!result.ok) {
      errors.push(result.error);
      continue;
    }

    let payload: unknown = null;
    try {
      payload = JSON.parse(result.text);
    } catch {
      errors.push("index.json 不是合法 JSON");
      continue;
    }

    const scores = normalizeIndex(payload);
    indexCache.set(key, { at: Date.now(), value: { scores, source: target.label } });
    return { ok: true, scores, source: target.label };
  }

  return {
    ok: false,
    error: errors.length ? errors[0] ?? "读取失败" : "没有可用的源",
  };
}

/**
 * 读单个谱面文件（原样文本，交给前端 JSON.parse）。
 */
export async function loadScoreFile(options: {
  entry: ScoreEntry;
  fetchImpl: typeof fetch;
  sources: string[];
  timeoutMs?: number;
}): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const cacheKey = `${options.sources[0] ?? ""}|${options.entry.file}`;
  const cached = fileCache.get(cacheKey);

  if (cached && Date.now() - cached.at < FILE_CACHE_TTL_MS) {
    return { ok: true, text: cached.value };
  }

  const errors: string[] = [];

  for (const source of options.sources) {
    const target = targetFor(source, options.entry.file, "");
    const result = await fetchText(target, options.fetchImpl, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    if (result.ok) {
      fileCache.set(cacheKey, { at: Date.now(), value: result.text });
      return { ok: true, text: result.text };
    }

    errors.push(result.error);
  }

  return { ok: false, error: errors[0] ?? "读取失败" };
}
