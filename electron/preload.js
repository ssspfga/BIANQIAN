'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('notesNative', {
  isDesktop: true,
  platform: process.platform,

  // WebDAV 交给主进程用 Node 发请求（没有跨域限制）
  dav: (req) => ipcRenderer.invoke('dav', req),

  // 导出 JSON（系统保存框）
  saveFile: (req) => ipcRenderer.invoke('save-file', req),

  // 本地备份落盘 / 打开备份目录
  localBackup: (req) => ipcRenderer.invoke('local-backup', req),
  openBackupDir: () => ipcRenderer.invoke('open-backup-dir'),

  // 窗口：置顶 / 贴边收起 / 最小化 / 关闭
  win: {
    state: () => ipcRenderer.invoke('win-state'),
    setAlwaysOnTop: (v) => ipcRenderer.invoke('win-set-always-on-top', v),
    setDock: (v) => ipcRenderer.invoke('win-set-dock', v),
    minimize: () => ipcRenderer.invoke('win-minimize'),
    close: () => ipcRenderer.invoke('win-close'),
    collapse: () => ipcRenderer.invoke('win-collapse'),
    expand: () => ipcRenderer.send('win-expand'),
    onState: (cb) => {
      ipcRenderer.on('win-state', (_e, s) => cb(s));
    }
  },

  // 开机自动启动
  autoStart: {
    state: () => ipcRenderer.invoke('autostart-state'),
    set: (v) => ipcRenderer.invoke('autostart-set', v)
  }
});
