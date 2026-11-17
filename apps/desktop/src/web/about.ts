import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 「关于」页的全部文案都在这个文件里。
 *
 * 想改简介、作者、项目地址、许可证：只改下面的 ABOUT_INFO 就好，
 * 页面会通过 GET /api/about 自动读到，不用碰 HTML / JS。
 * 版本号不在这里写死，由 package.json 或 Electron 提供。
 */
export interface AboutInfo {
  /** 产品名，显示在标题位置 */
  productName: string;
  /** 一句话简介 */
  tagline: string;
  /** 功能要点，每条一行 */
  description: string[];
  /** 制作人 */
  author: string;
  /** 许可证 */
  license: string;
  /** 项目地址（点击会用系统浏览器打开） */
  repoUrl: string;
  /** 项目地址的显示文字 */
  repoLabel: string;
}

export const ABOUT_INFO: AboutInfo = {
  productName: "时之笛 · 乐谱编排器&演奏器",
  tagline: "在钢琴卷帘上编谱 → 输出手柄键位 → ESP32 模拟 Switch Pro 手柄演奏。",
  description: [
    "曲谱编排：钢琴卷帘放置音符，支持 JSON / 文本 / MIDI 导入与导出。",
    "设备与测试：串口演奏、按键与摇杆调试、断连与回连。",
    "固件刷入：一键编译并上传 ESP32 固件。",
  ],
  author: "Kukiisama",
  license: "GPL-3.0",
  repoUrl: "https://github.com/Kukiisama/ocarina-arranger",
  repoLabel: "github.com/Kukiisama/ocarina-arranger",
};

// dev 下 dist/apps/desktop/src/web 往上 4 层是 dist，5 层才是项目根；
// 打包后 package.json 在 app.asar 根，往上 5 层能命中。多试几层就不必关心具体环境。
const PACKAGE_JSON_SEARCH_DEPTHS = [4, 5, 6] as const;

/**
 * 版本号：优先用 Electron 传进来的 app.getVersion()；
 * 独立跑 ui:dev / CLI 时退回读 package.json。
 */
export function resolveAppVersion(explicitVersion?: string): string {
  const explicit =
    typeof explicitVersion === "string" ? explicitVersion.trim().replace(/^v/iu, "") : "";

  if (explicit) {
    return explicit;
  }

  const currentDir = path.dirname(fileURLToPath(import.meta.url));

  for (const depth of PACKAGE_JSON_SEARCH_DEPTHS) {
    const candidate = path.resolve(
      currentDir,
      ...Array.from({ length: depth }, () => ".."),
      "package.json",
    );

    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { version?: unknown };
      if (typeof parsed.version === "string" && parsed.version.trim()) {
        return parsed.version.trim();
      }
    } catch {
      // 这一层没有 package.json，继续往上找
    }
  }

  return "0.0.0";
}
