import { contextBridge, ipcRenderer } from "electron";

const windowApi = {
  platform: process.platform,
  minimize: async (): Promise<void> => {
    await ipcRenderer.invoke("friend-maker-window:minimize");
  },
  toggleMaximize: async (): Promise<boolean> => {
    return Boolean(await ipcRenderer.invoke("friend-maker-window:toggle-maximize"));
  },
  close: async (): Promise<void> => {
    await ipcRenderer.invoke("friend-maker-window:close");
  },
  /** 把当前页面按打印样式导出成 PDF（主进程直接写文件，不走打印对话框） */
  exportPdf: async (defaultFileName: string): Promise<{
    ok: boolean;
    filePath?: string;
    canceled?: boolean;
    error?: string;
  }> => {
    return ipcRenderer.invoke("ocarina:export-pdf", defaultFileName);
  },

  /**
   * 应用内更新：主进程弹窗询问 → 需要的话下载安装包 → 自动启动安装程序。
   * 返回 { action: "installed" | "later" | "manual" | "busy" | "error", error? }
   */
  promptUpdate: async (info: {
    version: string;
    currentVersion: string;
    releaseUrl: string;
    assetUrl: string | null;
    assetName: string | null;
  }): Promise<{ action: string; error?: string; filePath?: string }> => {
    return ipcRenderer.invoke("ocarina:update-flow", info);
  },

  /** 订阅下载进度，返回取消订阅函数 */
  onUpdateProgress: (
    callback: (progress: { version: string; received: number; total: number; percent: number | null }) => void,
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      progress: { version: string; received: number; total: number; percent: number | null },
    ): void => {
      callback(progress);
    };

    ipcRenderer.on("ocarina:update-progress", listener);
    return () => {
      ipcRenderer.off("ocarina:update-progress", listener);
    };
  },
};

contextBridge.exposeInMainWorld("friendMakerWindow", windowApi);
