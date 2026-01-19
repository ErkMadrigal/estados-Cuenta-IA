// main.js ✅ completo: config.json + IPC + server + preload
const { app, BrowserWindow, ipcMain, shell, dialog } = require("electron");
const path = require("path");
const fs = require("fs");

let mainWindow = null;
let startServer, stopServer;
let currentPort = null;

// ----------------------
// Config (userData/config.json)
// ----------------------
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

// ----------------------
// IPC (Renderer <-> Main)
// ----------------------
ipcMain.handle("config:get", async () => {
  const cfg = readConfig();
  const hasKey = !!(cfg.OPENAI_API_KEY && String(cfg.OPENAI_API_KEY).trim());
  return { ok: true, config: { hasKey } };
});

ipcMain.handle("config:setApiKey", async (e, apiKey) => {
  apiKey = String(apiKey || "").trim();
  if (!apiKey) return { ok: false, error: "API Key vacía." };

  const cfg = readConfig();
  cfg.OPENAI_API_KEY = apiKey;
  writeConfig(cfg);

  // ✅ inyectar al proceso actual
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
    currentPort = await startServer(process.env.PORT || 3000);
    return { ok: true, port: currentPort };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle("app:getPort", async () => {
  return { ok: true, port: currentPort || (process.env.PORT || 3000) };
});

// ----------------------
// Window + Server
// ----------------------
async function createWindow() {
  // ✅ env base ANTES de require("./server.cjs")
  process.env.ELECTRON_IS_PACKAGED = app.isPackaged ? "1" : "0";
  process.env.RUNTIME_DIR = path.join(app.getPath("userData"), "runtime");

  // ✅ cargar key guardada si existe
  const cfg = readConfig();
  if (cfg.OPENAI_API_KEY) process.env.OPENAI_API_KEY = String(cfg.OPENAI_API_KEY).trim();

  ({ startServer, stopServer } = require("./server.cjs"));

  // ✅ intenta iniciar server; si no hay key, NO truena la app: UI pedirá key
  const desiredPort = process.env.PORT || 3000;
  try {
    currentPort = await startServer(desiredPort);
  } catch (e) {
    console.warn("[main] Server no inició:", e?.message || e);
    currentPort = desiredPort; // UI se cargará igual si server ya está o si arranca luego
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

  try {
    await mainWindow.loadURL(`http://localhost:${currentPort}`);
  } catch (e) {
    dialog.showErrorBox(
      "No se pudo cargar la interfaz",
      `No pude abrir http://localhost:${currentPort}\n\n${e?.message || e}`
    );
  }

  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

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
