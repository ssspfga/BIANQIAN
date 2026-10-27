'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

let win = null;

/* ================= 窗口状态（置顶 / 贴边收起） ================= */
const STRIP_W = 10;
const STRIP_H_RATIO = 5;  // 收起后的高度 = 原高度 / 5     // 收起后露出的宽度
const EDGE_TOL = 20;    // 距离屏幕边缘多少像素算贴边
const LEAVE_MS = 700;   // 鼠标离开多久后收起

const wstate = { alwaysOnTop: false, dockEnabled: true, docked: false, side: null };
let expandedBounds = null;
let wasOnTop = false;
let animTimer = null;
let animating = false;
let outsideSince = 0;
let expandArmed = false;   // 收起后必须先把鼠标移开，再靠近才弹出
let dockedAt = 0;          // 收起时刻，用于防抖

function winOut() {
  return {
    alwaysOnTop: win ? win.isAlwaysOnTop() : wstate.alwaysOnTop,
    dockEnabled: wstate.dockEnabled,
    docked: wstate.docked,
    side: wstate.side
  };
}
function emit() {
  if (win && !win.isDestroyed()) win.webContents.send('win-state', winOut());
}

function animateTo(from, to, ms, done) {
  if (animTimer) { clearInterval(animTimer); animTimer = null; }
  const steps = Math.max(1, Math.round(ms / 16));
  let i = 0;
  animating = true;
  animTimer = setInterval(() => {
    if (!win || win.isDestroyed()) {
      clearInterval(animTimer); animTimer = null; animating = false; return;
    }
    i++;
    const t = Math.min(i, steps) / steps;
    const e = 1 - Math.pow(1 - t, 2);
    win.setBounds({
      x: Math.round(from.x + (to.x - from.x) * e),
      y: Math.round(from.y + (to.y - from.y) * e),
      width: Math.max(1, Math.round(from.width + (to.width - from.width) * e)),
      height: Math.max(1, Math.round(from.height + (to.height - from.height) * e))
    });
    if (i >= steps) {
      clearInterval(animTimer); animTimer = null; animating = false;
      if (done) done();
    }
  }, 16);
}

function collapseToEdge(side) {
  if (!win || win.isDestroyed() || wstate.docked || animating) return;
  const b = win.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  expandedBounds = b;
  wstate.side = side;
  wstate.docked = true;
  expandArmed = false;
  dockedAt = Date.now();
  wasOnTop = win.isAlwaysOnTop();
  try {
    win.setMinimumSize(120, 60);
    win.setAlwaysOnTop(true, 'floating');
  } catch (e) {}
  emit();
  // 滑到屏幕外只露 STRIP_W 宽，同时高度压到原来的 1/5
  const stripH = Math.max(80, Math.round(b.height / STRIP_H_RATIO));
  const target = {
    x: side === 'right' ? wa.x + wa.width - STRIP_W : wa.x - (b.width - STRIP_W),
    y: Math.round(b.y + (b.height - stripH) / 2),
    width: b.width,
    height: stripH
  };
  animateTo(b, target, 160);
}

function expandFromEdge() {
  if (!win || win.isDestroyed() || !wstate.docked) return;
  const b = win.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  const base = expandedBounds || {};
  const width = base.width || b.width || 470;
  const height = base.height || 740;
  const x = wstate.side === 'right' ? wa.x + wa.width - width : wa.x;
  const wantY = (base.y != null ? base.y : b.y);
  const y = Math.min(Math.max(wantY, wa.y), wa.y + wa.height - height);
  wstate.docked = false;
  wstate.side = null;
  emit();
  animateTo(b, { x: x, y: y, width: width, height: height }, 170, () => {
    try {
      win.setMinimumSize(360, 460);
      win.setAlwaysOnTop(!!wasOnTop, 'floating');
    } catch (e) {}
    emit();
  });
}

/* 鼠标看门狗：贴边 + 鼠标离开就收起；停在边缘细条上就滑出 */
setInterval(() => {
  if (!win || win.isDestroyed() || animating) return;
  if (!wstate.dockEnabled) return;

  let p;
  try { p = screen.getCursorScreenPoint(); } catch (e) { return; }
  const b = win.getBounds();
  const inside = p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;

  if (wstate.docked) {
    // 鼠标先要离开细条（解锁），之后靠近细条才弹出
    const wa = screen.getDisplayMatching(b).workArea;
    const x0 = wstate.side === 'right' ? wa.x + wa.width - STRIP_W - 1 : wa.x - 1;
    const x1 = wstate.side === 'right' ? wa.x + wa.width + 1 : wa.x + STRIP_W + 1;
    const overStrip = p.x >= x0 && p.x <= x1 && p.y >= b.y && p.y <= b.y + b.height;
    if (!expandArmed) {
      if (!overStrip) expandArmed = true;
    } else if (overStrip) {
      expandFromEdge();
    }
    return;
  }

  if (!wstate.dockEnabled) return;

  if (inside) { outsideSince = 0; return; }

  const wa = screen.getDisplayMatching(b).workArea;
  const atRight = b.x + b.width >= wa.x + wa.width - EDGE_TOL;
  const atLeft = b.x <= wa.x + EDGE_TOL;
  if (!atRight && !atLeft) { outsideSince = 0; return; }

  if (!outsideSince) outsideSince = Date.now();
  if (Date.now() - outsideSince >= LEAVE_MS) {
    outsideSince = 0;
    collapseToEdge(atRight ? 'right' : 'left');
  }
}, 180);

/* ================= 主窗口 ================= */
function createWindow() {
  win = new BrowserWindow({
    width: 470,
    height: 740,
    minWidth: 360,
    minHeight: 460,
    frame: false,
    backgroundColor: '#eef1f6',
    title: '便签',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.loadFile(path.join(__dirname, '..', 'www', 'index.html'));

  win.once('ready-to-show', () => win.show());

  // 从任务栏点回来时，如果正处于收起状态就滑出
  win.on('focus', () => {
    if (wstate.docked && !animating && Date.now() - dockedAt > 500) expandFromEdge();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

/* ================= 窗口控制 IPC ================= */
ipcMain.handle('win-state', () => winOut());

ipcMain.handle('win-set-always-on-top', (_e, v) => {
  if (win && !win.isDestroyed()) {
    win.setAlwaysOnTop(!!v, 'floating');
    if (!wstate.docked) wasOnTop = !!v;
  }
  emit();
  return winOut();
});

ipcMain.handle('win-set-dock', (_e, v) => {
  wstate.dockEnabled = !!v;
  if (!wstate.dockEnabled && wstate.docked) expandFromEdge();
  outsideSince = 0;
  emit();
  return winOut();
});

ipcMain.handle('win-minimize', () => {
  if (win && !win.isDestroyed()) win.minimize();
});

ipcMain.handle('win-close', () => {
  if (win && !win.isDestroyed()) win.close();
});

ipcMain.on('win-expand', () => { if (wstate.docked && !animating && Date.now() - dockedAt > 300) expandFromEdge(); });

ipcMain.handle('win-collapse', () => {
  if (!win || win.isDestroyed()) return winOut();
  const b = win.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  const side = b.x + b.width / 2 > wa.x + wa.width / 2 ? 'right' : 'left';
  collapseToEdge(side);
  return winOut();
});

/* ================= 开机自动启动 ================= */
function autoStartPath() {
  // 便携版运行在临时解压目录，必须用最初的双击 exe 路径
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
}
function autoStartState() {
  try {
    if (!app.isPackaged) return { supported: false, enabled: false };
    const s = app.getLoginItemSettings({ path: autoStartPath() });
    return { supported: true, enabled: !!s.openAtLogin };
  } catch (e) {
    return { supported: false, enabled: false, error: String((e && e.message) || e) };
  }
}
ipcMain.handle('autostart-state', () => autoStartState());
ipcMain.handle('autostart-set', (_e, v) => {
  try {
    if (!app.isPackaged) return { supported: false, enabled: false };
    app.setLoginItemSettings({ openAtLogin: !!v, path: autoStartPath() });
    return autoStartState();
  } catch (e) {
    return { supported: false, enabled: false, error: String((e && e.message) || e) };
  }
});
/* ================= WebDAV：主进程发请求，避免跨域 ================= */
function davRequest({ url, method, headers, body }) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return resolve({ status: 0, text: '', error: 'URL 无效' });
    }

    const lib = u.protocol === 'http:' ? http : https;
    const hdrs = Object.assign({}, headers || {});
    let payload = null;

    if (body != null && body !== '') {
      payload = Buffer.from(String(body), 'utf8');
      hdrs['Content-Length'] = payload.length;
      if (!hdrs['Content-Type']) hdrs['Content-Type'] = 'application/json; charset=utf-8';
    } else {
      hdrs['Content-Length'] = 0;
    }

    const req = lib.request(u, { method: method || 'GET', headers: hdrs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') });
      });
    });

    req.setTimeout(30000, () => req.destroy(new Error('请求超时')));
    req.on('error', (err) => resolve({ status: 0, text: '', error: err.message }));

    if (payload) req.write(payload);
    req.end();
  });
}

ipcMain.handle('dav', async (_e, payload) => {
  try {
    return await davRequest(payload || {});
  } catch (err) {
    return { status: 0, text: '', error: String((err && err.message) || err) };
  }
});

/* ================= 文件导出 / 本地备份 ================= */
function safeName(name) {
  return String(name || 'export.json').replace(/[\\/:*?"<>|]/g, '_');
}
function backupDir() {
  return path.join(app.getPath('userData'), 'backups');
}

ipcMain.handle('save-file', async (_e, { name, text } = {}) => {
  const parent = BrowserWindow.getFocusedWindow() || win || BrowserWindow.getAllWindows()[0];
  const res = await dialog.showSaveDialog(parent, {
    title: '保存文件',
    defaultPath: path.join(app.getPath('documents'), safeName(name)),
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  try {
    await fs.promises.writeFile(res.filePath, String(text == null ? '' : text), 'utf8');
    return { ok: true, path: res.filePath };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('local-backup', async (_e, { name, text } = {}) => {
  try {
    const dir = backupDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, safeName(name)), String(text || ''), 'utf8');

    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    files.slice(20).forEach((x) => {
      try { fs.unlinkSync(path.join(dir, x.f)); } catch (_) {}
    });

    return { ok: true, dir };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('open-backup-dir', async () => {
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });
  await shell.openPath(dir);
  return { ok: true, dir };
});

