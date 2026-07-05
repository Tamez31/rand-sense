const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  printBrochurePDF:  () => ipcRenderer.invoke('print-brochure-pdf'),
  printInvoicePDF:   (html, filename) => ipcRenderer.invoke('print-invoice-pdf', html, filename),
  openExternal:      (url) => ipcRenderer.invoke('open-external', url),
})
