import assert from "node:assert/strict";
import test from "node:test";

import {
  checkForUpdate,
  compareVersions,
  normalizeVersion,
  pickInstallerAsset,
  releasesApiUrl,
} from "../src/web/updateCheck.js";

test("compareVersions 按数字比较，不是字符串比较", () => {
  assert.equal(compareVersions("1.1.10", "1.1.9"), 1);
  assert.equal(compareVersions("1.1.9", "1.1.10"), -1);
  assert.equal(compareVersions("v1.1.2", "1.1.2"), 0);
  assert.equal(compareVersions("1.2.0", "1.10.0"), -1);
  assert.equal(compareVersions("2.0", "1.9.9"), 1);
});

test("compareVersions 把预发布版排在正式版之前", () => {
  assert.equal(compareVersions("1.2.3-beta", "1.2.3"), -1);
  assert.equal(compareVersions("1.2.3", "1.2.3-beta"), 1);
});

test("normalizeVersion 去掉 v 前缀、构建后缀和空白", () => {
  assert.equal(normalizeVersion(" v1.1.2 "), "1.1.2");
  assert.equal(normalizeVersion("1.1.2+build.7"), "1.1.2");
  assert.equal(normalizeVersion("V1.0.0"), "1.0.0");
  assert.equal(normalizeVersion(""), "");
});

test("releasesApiUrl 从仓库地址推出 GitHub API 地址", () => {
  assert.equal(
    releasesApiUrl("https://github.com/Kukiisama/ocarina-arranger"),
    "https://api.github.com/repos/Kukiisama/ocarina-arranger/releases/latest",
  );
  assert.equal(
    releasesApiUrl("https://github.com/Kukiisama/ocarina-arranger.git"),
    "https://api.github.com/repos/Kukiisama/ocarina-arranger/releases/latest",
  );
  assert.throws(() => releasesApiUrl("https://example.com/foo"));
});

function stubFetch(payload: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

test("checkForUpdate：远端更新时返回 outdated", async () => {
  const result = await checkForUpdate({
    currentVersion: "1.1.2",
    repoUrl: "https://github.com/Kukiisama/ocarina-arranger",
    force: true,
    fetchImpl: stubFetch({
      tag_name: "v1.1.3",
      name: "v1.1.3",
      html_url: "https://github.com/Kukiisama/ocarina-arranger/releases/tag/v1.1.3",
      published_at: "2026-11-20T10:00:00Z",
    }),
  });

  assert.equal(result.status, "outdated");
  assert.equal(result.latestVersion, "1.1.3");
  assert.equal(result.currentVersion, "1.1.2");
  assert.equal(result.releaseUrl, "https://github.com/Kukiisama/ocarina-arranger/releases/tag/v1.1.3");
  assert.equal(result.asset, null);
  assert.equal(result.error, null);
});

test("pickInstallerAsset：挑 .exe、优先带 win、多个取最大", () => {
  const picked = pickInstallerAsset([
    { name: "notes.txt", browser_download_url: "https://github.com/a/b/releases/download/v1/notes.txt", size: 10 },
    { name: "Ocarina Arranger-1.2.0-win-x64.exe", browser_download_url: "https://github.com/a/b/releases/download/v1/x64.exe", size: 90_000_000 },
    { name: "Ocarina Arranger-1.2.0-win-arm64.exe", browser_download_url: "https://github.com/a/b/releases/download/v1/arm64.exe", size: 95_000_000 },
    { name: "setup-linux.AppImage", browser_download_url: "https://github.com/a/b/releases/download/v1/app.AppImage", size: 99_000_000 },
  ]);

  assert.equal(picked?.name, "Ocarina Arranger-1.2.0-win-arm64.exe");
  assert.equal(picked?.size, 95_000_000);
});

test("pickInstallerAsset：没有 exe 或地址不是 https 时返回 null", () => {
  assert.equal(pickInstallerAsset([{ name: "a.zip", browser_download_url: "https://x/a.zip", size: 1 }]), null);
  assert.equal(
    pickInstallerAsset([{ name: "a.exe", browser_download_url: "http://x/a.exe", size: 1 }]),
    null,
  );
  assert.equal(pickInstallerAsset(null), null);
});

test("checkForUpdate：把 release 里的安装包带出来", async () => {
  const result = await checkForUpdate({
    currentVersion: "1.2.0",
    repoUrl: "https://github.com/Kukiisama/ocarina-arranger",
    force: true,
    fetchImpl: stubFetch({
      tag_name: "v1.2.1",
      html_url: "https://github.com/Kukiisama/ocarina-arranger/releases/tag/v1.2.1",
      assets: [
        {
          name: "Ocarina Arranger-1.2.1-win-x64.exe",
          browser_download_url: "https://github.com/Kukiisama/ocarina-arranger/releases/download/v1.2.1/setup.exe",
          size: 88_000_000,
        },
      ],
    }),
  });

  assert.equal(result.status, "outdated");
  assert.equal(result.asset?.name, "Ocarina Arranger-1.2.1-win-x64.exe");
  assert.match(result.asset?.url ?? "", /releases\/download\/v1\.2\.1\/setup\.exe$/u);
});

test("checkForUpdate：远端同版本返回 latest", async () => {
  const result = await checkForUpdate({
    currentVersion: "1.1.2",
    repoUrl: "https://github.com/Kukiisama/ocarina-arranger",
    force: true,
    fetchImpl: stubFetch({ tag_name: "v1.1.2", html_url: "https://example.com/tag" }),
  });

  assert.equal(result.status, "latest");
});

test("checkForUpdate：没有 release 时降级为 unknown，不抛错", async () => {
  const result = await checkForUpdate({
    currentVersion: "1.1.2",
    repoUrl: "https://github.com/Kukiisama/ocarina-arranger",
    force: true,
    fetchImpl: stubFetch({ message: "Not Found" }, 404),
  });

  assert.equal(result.status, "unknown");
  assert.equal(result.error, "NO_RELEASE");
});

test("checkForUpdate：网络异常时降级为 unknown，不抛错", async () => {
  const failingFetch = (async () => {
    throw new Error("getaddrinfo ENOTFOUND api.github.com");
  }) as unknown as typeof fetch;

  const result = await checkForUpdate({
    currentVersion: "1.1.2",
    repoUrl: "https://github.com/Kukiisama/ocarina-arranger",
    force: true,
    fetchImpl: failingFetch,
  });

  assert.equal(result.status, "unknown");
  assert.match(result.error ?? "", /ENOTFOUND/u);
});

test("checkForUpdate：tag 不是数字版本号时报 BAD_TAG，而不是误判成最新", async () => {
  const result = await checkForUpdate({
    currentVersion: "1.1.2",
    repoUrl: "https://github.com/Kukiisama/ocarina-arranger",
    force: true,
    fetchImpl: stubFetch({ tag_name: "test-release", name: "随便写的标题" }),
  });

  assert.equal(result.status, "unknown");
  assert.equal(result.error, "BAD_TAG");
});

test("checkForUpdate：force 忽略缓存重新请求", async () => {
  const repoUrl = "https://github.com/Kukiisama/ocarina-arranger";

  const first = await checkForUpdate({
    currentVersion: "1.1.2",
    repoUrl,
    force: true,
    fetchImpl: stubFetch({ tag_name: "v1.1.3" }),
  });
  assert.equal(first.status, "outdated");

  // 不 force 时命中缓存，仍是上次的结果
  const cached = await checkForUpdate({
    currentVersion: "1.1.2",
    repoUrl,
    fetchImpl: stubFetch({ tag_name: "v1.1.2" }),
  });
  assert.equal(cached.status, "outdated");

  // force 时重新请求，拿到新结果
  const refreshed = await checkForUpdate({
    currentVersion: "1.1.2",
    repoUrl,
    force: true,
    fetchImpl: stubFetch({ tag_name: "v1.1.2" }),
  });
  assert.equal(refreshed.status, "latest");
});
