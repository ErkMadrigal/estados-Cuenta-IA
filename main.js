// main.js ✅ Electron window + levanta Express internamente
const { app, BrowserWindow } = require("electron");
const path = require("path");
const { startServer, stopServer } = require("./server.cjs");

let mainWindow = null;

async function createWindow() {
  // ✅ banderita para saber si estamos empaquetados (IMPORTANTE)
  process.env.ELECTRON_IS_PACKAGED = app.isPackaged ? "1" : "0";

  // ✅ ruta con permisos SIEMPRE (AppData/Roaming/<app>/runtime)
  process.env.RUNTIME_DIR = path.join(app.getPath("userData"), "runtime");

  const port = await startServer(process.env.PORT || 3000);

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    autoHideMenuBar: true,
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  await mainWindow.loadURL(`http://localhost:${port}`);

  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  mainWindow.on("closed", async () => {
    mainWindow = null;
    await stopServer();
    app.quit();
  });
}

app.whenReady().then(createWindow);

app.on("window-all-closed", async () => {
  await stopServer();
  app.quit();
});
