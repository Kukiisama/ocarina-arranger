import assert from "node:assert/strict";
import test from "node:test";

import { loadScoreFile, loadScoreIndex, resolveScoreSources } from "../src/web/scoreLibrary.js";

function stubFetchByUrl(map: Record<string, { status?: number; body: unknown }>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    // 强制刷新时会带 ?t= 时间戳，匹配时忽略查询串
    const parsed = new URL(url);
    const key = parsed.origin + parsed.pathname;
    const hit = map[key];

    if (!hit) {
      return new Response("not found", { status: 404 });
    }

    return new Response(JSON.stringify(hit.body), { status: hit.status ?? 200 });
  }) as unknown as typeof fetch;
}

test("loadScoreIndex：过滤掉缺少字段或 id 非法的条目", async () => {
  const result = await loadScoreIndex({
    fetchImpl: stubFetchByUrl({
      "https://mirror.test/index.json": {
        body: [
          { id: "ok-1", title: "正常谱面", author: "Kukiisama", file: "scores/ok-1.json", notes: 12 },
          { id: "../evil", title: "路径穿越", author: "x", file: "scores/evil.json" },
          { id: "no-title", author: "x", file: "scores/x.json" },
          { id: "no-file", title: "缺文件", author: "x" },
        ],
      },
    }),
    sources: ["https://mirror.test"],
    force: true,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.scores.length, 1);
  assert.equal(result.scores[0]?.id, "ok-1");
  assert.equal(result.scores[0]?.notes, 12);
});

test("loadScoreIndex：第一个镜像失败时自动换下一个", async () => {
  const result = await loadScoreIndex({
    fetchImpl: stubFetchByUrl({
      "https://backup.test/index.json": {
        body: { scores: [{ id: "s1", title: "备源谱面", author: "A", file: "scores/s1.json" }] },
      },
    }),
    sources: ["https://dead.test", "https://backup.test"],
    force: true,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.source, "https://backup.test");
  assert.equal(result.scores[0]?.title, "备源谱面");
});

test("loadScoreIndex：所有镜像都失败时返回 error，不抛异常", async () => {
  const result = await loadScoreIndex({
    fetchImpl: stubFetchByUrl({}),
    sources: ["https://dead-a.test", "https://dead-b.test"],
    force: true,
  });

  assert.equal(result.ok, false);
});

test("loadScoreFile：按索引里的 file 路径取谱面", async () => {
  const result = await loadScoreFile({
    entry: { id: "s1", title: "谱面", author: "A", file: "scores/s1.json", notes: 2 },
    fetchImpl: stubFetchByUrl({
      "https://mirror.test/scores/s1.json": { body: { app: "oot-ocarina-arranger", cols: 16, notes: [] } },
    }),
    sources: ["https://mirror.test"],
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.text, /oot-ocarina-arranger/u);
});

test("resolveScoreSources：API、CDN、raw 三个源，API 优先", () => {
  const sources = resolveScoreSources();
  assert.equal(sources.length, 3);
  assert.match(sources[0] ?? "", /^api:https:\/\/api\.github\.com\/repos\//u);
  assert.match(sources[1] ?? "", /^https:\/\/cdn\.jsdelivr\.net\/gh\//u);
  assert.match(sources[2] ?? "", /^https:\/\/raw\.githubusercontent\.com\//u);
});

test("loadScoreIndex：API 源走 contents 接口并要 raw 内容", async () => {
  const seen: Array<{ url: string; accept: string }> = [];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({ url, accept: headers.accept ?? "" });

    return new Response(JSON.stringify([{ id: "s1", title: "标题", author: "A", file: "scores/s1.json" }]), {
      status: 200,
    });
  }) as unknown as typeof fetch;

  const result = await loadScoreIndex({
    fetchImpl,
    sources: ["api:https://api.github.com/repos/O/R/contents@main"],
    force: true,
  });

  assert.equal(result.ok, true);
  assert.equal(seen[0]?.accept, "application/vnd.github.raw");
  assert.match(seen[0]?.url ?? "", /^https:\/\/api\.github\.com\/repos\/O\/R\/contents\/index\.json\?ref=main&t=/u);
});
