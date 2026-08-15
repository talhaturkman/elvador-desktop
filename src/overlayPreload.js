const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('elvadorOverlay', {
  open: (notificationId) => ipcRenderer.send('elvador:overlay-notification-open', notificationId),
  minimize: (notificationId) => ipcRenderer.send('elvador:overlay-notification-minimize', notificationId)
});
