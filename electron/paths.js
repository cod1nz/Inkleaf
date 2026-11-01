'use strict';
const path = require('node:path');
const { app } = require('electron');

/** Packaged web build: dist/ next to the app root (inside app.asar when packaged). */
const distRoot = () =>
  !app.isPackaged && process.env.INKLEAF_DIST
    ? path.resolve(process.env.INKLEAF_DIST)
    : path.join(app.getAppPath(), 'dist');
const userDataPath = (...p) => path.join(app.getPath('userData'), ...p);
const addonsRoot = () => userDataPath('addons');

module.exports = { distRoot, userDataPath, addonsRoot };
