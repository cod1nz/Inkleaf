'use strict';
const { Menu, shell, dialog } = require('electron');
const { isHttpUrl } = require('./lib/trust');

const { SOURCE_URL } = require('./app-info');

let confirming = false;
async function confirmExternal(win, url) {
  if (!isHttpUrl(url) || confirming) return false; // one prompt at a time (no dialog spam from a hostile page)
  const u = new URL(url);
  // user:pass@ is the classic way to make a link look like another site; IDN hosts show as punycode (u.hostname).
  if (u.username || u.password || url.length > 8192) return false;
  const href = u.href;
  confirming = true;
  let response;
  try {
    ({ response } = await dialog.showMessageBox(
      win && !win.isDestroyed() ? win : undefined,
      {
        type: 'question',
        buttons: ['Open in browser', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        message: `Open a link to ${u.hostname} in your browser?`,
        detail: href.length > 500 ? href.slice(0, 500) + '...' : href,
      }
    ));
  } finally {
    confirming = false;
  }
  if (response !== 0) return false;
  await shell.openExternal(href);
  return true;
}

/**
 * deps: { send(id), recent: [{name}], openRecent(i), clearRecent(), getWindow(), isDev }
 */
function buildMenu(deps) {
  const mac = process.platform === 'darwin';
  const item = (label, id, accelerator) => ({
    label,
    accelerator,
    click: () => deps.send(id),
  });

  const recentItems = deps.recent.length
    ? [
        ...deps.recent.map((r, i) => ({
          label: r.name,
          click: () => deps.openRecent(i),
        })),
        { type: 'separator' },
        { label: 'Clear Recent', click: () => deps.clearRecent() },
      ]
    : [{ label: 'No recent files', enabled: false }];

  const template = [
    ...(mac
      ? [
          {
            label: 'Inkleaf',
            submenu: [
              item('About Inkleaf', 'menu:about'),
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        item('Open...', 'file:open', 'CmdOrCtrl+O'),
        { label: 'Open Recent', submenu: recentItems },
        item('Save a Copy...', 'file:saveCopy', 'CmdOrCtrl+Shift+S'),
        { type: 'separator' },
        { role: 'close' },
        ...(mac ? [] : [{ role: 'quit' }]),
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'resetZoom' },
        { type: 'separator' },
        item('Toggle Sidebar', 'view:toggleSidebar', 'CmdOrCtrl+\\'),
        item('Toggle Dark Mode', 'view:toggleDark', 'CmdOrCtrl+Shift+D'),
        { role: 'togglefullscreen' },
        ...(deps.isDev
          ? [
              { type: 'separator' },
              { role: 'reload' },
              { role: 'toggleDevTools' },
            ]
          : []),
      ],
    },
    { role: 'windowMenu' },
    {
      label: 'Help',
      submenu: [
        ...(mac ? [] : [item('About Inkleaf', 'menu:about')]),
        {
          label: 'Source Code',
          click: () => confirmExternal(deps.getWindow(), SOURCE_URL),
        },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

function installMenu(deps) {
  Menu.setApplicationMenu(buildMenu(deps));
}

module.exports = { installMenu, confirmExternal, SOURCE_URL };
