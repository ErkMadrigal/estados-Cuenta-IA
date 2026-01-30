// main.js ✅ robusto: puerto real + error visible si no levantó
const { app, BrowserWindow, ipcMain, shell, dialog } = require("electron");
const path = require("path");
const fs = require("fs");

let mainWindow = null;
let startServer, stopServer;
let currentPort = null;

function getConfigPath() {
  return path.join(app.getPath("userData"), "config.json");
}

function readConfig() {
  try {
    const p = getConfigPath();
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

function writeConfig(cfg) {
  const p = getConfigPath();
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), "utf8");
  return true;
}

// IPC
ipcMain.handle("config:get", async () => {
  const cfg = readConfig();
  const hasKey = !!(cfg.OPENAI_API_KEY && String(cfg.OPENAI_API_KEY).trim());
  return { ok: true, config: { hasKey } };
});

ipcMain.handle("config:setApiKey", async (_e, apiKey) => {
  apiKey = String(apiKey || "").trim();
  if (!apiKey) return { ok: false, error: "API Key vacía." };

  const cfg = readConfig();
  cfg.OPENAI_API_KEY = apiKey;
  writeConfig(cfg);

  process.env.OPENAI_API_KEY = apiKey;
  return { ok: true };
});

ipcMain.handle("config:openFolder", async () => {
  const folder = app.getPath("userData");
  await shell.openPath(folder);
  return { ok: true, folder };
});

ipcMain.handle("app:restartServer", async () => {
  try {
    if (stopServer) await stopServer();
    // 0 => puerto libre
    currentPort = await startServer(0);
    return { ok: true, port: currentPort };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle("app:getPort", async () => {
  return { ok: true, port: currentPort };
});

async function createWindow() {
  process.env.ELECTRON_IS_PACKAGED = app.isPackaged ? "1" : "0";
  process.env.RUNTIME_DIR = path.join(app.getPath("userData"), "runtime");

  // cargar key guardada
  const cfg = readConfig();
  if (cfg.OPENAI_API_KEY) process.env.OPENAI_API_KEY = String(cfg.OPENAI_API_KEY).trim();

  ({ startServer, stopServer } = require("./server.cjs"));

  try {
    // 0 => evita choques de puertos en otras laps
    currentPort = await startServer(0);
  } catch (e) {
    dialog.showErrorBox(
      "No pudo iniciar el servidor",
      `No se pudo levantar el backend.\n\n${e?.message || e}`
    );
    app.quit();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  await mainWindow.loadURL(`http://127.0.0.1:${currentPort}`);

  mainWindow.on("closed", async () => {
    mainWindow = null;
    if (stopServer) await stopServer();
    app.quit();
  });
}

app.whenReady().then(createWindow);

app.on("window-all-closed", async () => {
  if (stopServer) await stopServer();
  app.quit();
});
