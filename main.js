const { app, BrowserWindow, shell, ipcMain } = require('electron')
const path = require('path')
const fs   = require('fs')
const os   = require('os')

app.disableHardwareAcceleration()

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'RandSense',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,
      preload: path.join(__dirname, 'preload.js'),
    }
  })

  win.loadFile('Rand-Sense.html')

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

// ── IPC: print brochure HTML to PDF and open it ──────────────
ipcMain.handle('print-brochure-pdf', async (_, brochureFile) => {
  const allowed = [
    'RandSense_Marketing_Brochure_V3.html',
    'RandSense_Marketing_Brochure_Tax.html',
    'RandSense_Marketing_Brochure_Financial.html'
  ]
  const file = allowed.includes(brochureFile) ? brochureFile : allowed[0]
  const brochurePath = path.join(__dirname, file)
  const hidden = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, webSecurity: false }
  })
  await hidden.loadFile(brochurePath)
  const pdfBuf = await hidden.webContents.printToPDF({ landscape: true, printBackground: true })
  hidden.close()
  const nameTag = file.replace('RandSense_Marketing_Brochure_', '').replace('.html', '')
  const savePath = path.join(os.homedir(), 'Downloads', `RandSense_Brochure_${nameTag}_${Date.now()}.pdf`)
  fs.writeFileSync(savePath, pdfBuf)
  shell.openPath(savePath)
  return savePath
})

// ── IPC: print invoice HTML to PDF ───────────────────────────
ipcMain.handle('print-invoice-pdf', async (_, html, filename) => {
  const hidden = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, webSecurity: false }
  })
  await hidden.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  const pdfBuf = await hidden.webContents.printToPDF({ printBackground: true })
  hidden.close()
  const safe = (filename || 'invoice').replace(/[^a-zA-Z0-9_-]/g, '_')
  const savePath = path.join(os.homedir(), 'Downloads', `${safe}.pdf`)
  fs.writeFileSync(savePath, pdfBuf)
  shell.openPath(savePath)
  return savePath
})

// ── IPC: open URL in default browser ─────────────────────────
ipcMain.handle('open-external', (_, url) => {
  shell.openExternal(url)
})

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
