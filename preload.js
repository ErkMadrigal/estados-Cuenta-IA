// preload.js ✅ correcto
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("native", {
  configGet: () => ipcRenderer.invoke("config:get"),
  setApiKey: (apiKey) => ipcRenderer.invoke("config:setApiKey", apiKey),
  openConfigFolder: () => ipcRenderer.invoke("config:openFolder"),
  restartServer: () => ipcRenderer.invoke("app:restartServer"),
  getPort: () => ipcRenderer.invoke("app:getPort"),
});
