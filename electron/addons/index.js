'use strict';
const { app, dialog, BrowserWindow } = require('electron');
const { addonsRoot } = require('../paths');
const { getManifest } = require('./manifest');
const { createManager } = require('./libreoffice');

const managers = new Map();

function formatMb(bytes) {
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
}

/** Registers add-on IPC. deps come from ipc.js (handle = sender-validated ipcMain.handle wrapper). */
function register({ handle, DeskError, testHook, sendToRenderer }) {
  const testOn = () => testHook();

  function manager(name) {
    if (name !== 'libreoffice')
      throw new DeskError('bad_args', 'Unknown add-on');
    if (!managers.has(name)) {
      let manifest;
      try {
        manifest = getManifest(name, { isPackaged: app.isPackaged });
      } catch {
        throw new DeskError('internal', 'Add-on information is invalid');
      }
      managers.set(
        name,
        createManager({
          root: addonsRoot(),
          manifest,
          emit: (ev) => sendToRenderer('addons:progress', ev),
        })
      );
    }
    return managers.get(name);
  }

  const wrap = async (fn) => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof DeskError) throw e;
      throw new DeskError(
        e && e.code ? e.code : 'internal',
        e && e.code && e.message ? e.message : 'Operation failed'
      );
    }
  };

  handle('desk:addons:status', (_e, name) =>
    wrap(() => manager(name).status())
  );

  handle('desk:addons:install', (event, name) =>
    wrap(async () => {
      const m = manager(name);
      const win = BrowserWindow.fromWebContents(event.sender);
      return m.install(async ({ sizeBytes, host, title }) => {
        if (testOn() && process.env.INKLEAF_TEST_CONFIRM === 'yes') return true;
        const r = await dialog.showMessageBox(win, {
          type: 'question',
          buttons: ['Download', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
          title: `Install ${title}`,
          message: `Download the ${title} add-on (${formatMb(sizeBytes)})?`,
          detail: `It will be downloaded once from ${host} and stored on this computer. After that it works offline.`,
        });
        return r.response === 0;
      });
    })
  );

  handle('desk:addons:installFromFile', (event, name) =>
    wrap(async () => {
      const m = manager(name);
      const win = BrowserWindow.fromWebContents(event.sender);
      const res =
        testOn() && process.env.INKLEAF_TEST_OPEN
          ? {
              canceled: false,
              filePaths: [process.env.INKLEAF_TEST_OPEN.split('|')[0]],
            }
          : await dialog.showOpenDialog(win, {
              title: 'Choose the add-on file',
              properties: ['openFile'],
              filters: [{ name: 'Add-on pack (.zip)', extensions: ['zip'] }],
            });
      if (res.canceled || !res.filePaths.length)
        throw new DeskError('cancelled', 'Cancelled');
      return m.installFromFile(res.filePaths[0]);
    })
  );

  handle('desk:addons:cancel', (_e, name) =>
    wrap(async () => manager(name).cancel())
  );
  handle('desk:addons:remove', (_e, name) =>
    wrap(() => manager(name).remove())
  );
}

module.exports = { register };
