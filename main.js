// main.js ✅
const { app, BrowserWindow } = require("electron");
const path = require("path");

let mainWindow = null;
let startServer, stopServer;

async function createWindow() {
  // ✅ Setear env ANTES de require("./server.cjs")
  process.env.ELECTRON_IS_PACKAGED = app.isPackaged ? "1" : "0";
  process.env.RUNTIME_DIR = path.join(app.getPath("userData"), "runtime");

  ({ startServer, stopServer } = require("./server.cjs"));

  const port = await startServer(process.env.PORT || 3000);

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  await mainWindow.loadURL(`http://localhost:${port}`);

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
