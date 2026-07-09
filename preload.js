const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  printBrochurePDF:  (brochureFile) => ipcRenderer.invoke('print-brochure-pdf', brochureFile),
  printInvoicePDF:   (html, filename) => ipcRenderer.invoke('print-invoice-pdf', html, filename),
  openExternal:      (url) => ipcRenderer.invoke('open-external', url),
})
