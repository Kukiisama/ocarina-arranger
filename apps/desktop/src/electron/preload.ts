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
};

contextBridge.exposeInMainWorld("friendMakerWindow", windowApi);
