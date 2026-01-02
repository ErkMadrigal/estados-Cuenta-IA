// main.js ✅ Electron window + levanta Express internamente
const { app, BrowserWindow } = require("electron");
const path = require("path");
const { startServer, stopServer } = require("./server.cjs");

let mainWindow = null;

async function createWindow() {
  const port = await startServer(process.env.PORT || 3000);

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    autoHideMenuBar: true,
    show: true,
    webPreferences: {
      contextIsolation: true
    }
  });

  // Carga la app web dentro de la ventana
  await mainWindow.loadURL(`http://localhost:${port}`);

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
