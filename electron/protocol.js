'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { Readable } = require('node:stream');
const { protocol } = require('electron');
const { distRoot, addonsRoot } = require('./paths');
const {
  parseUrlPath,
  resolveInside,
  isRealInside,
  realRoots,
} = require('./lib/safepath');
const { candidatesFor } = require('./lib/routing');
const { securityHeaders } = require('./lib/headers');
const { mimeFor } = require('./lib/mime');

const SCHEME = 'app';
const HOST = 'bentopdf';
const ADDON_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const ADDON_DOCUMENT = /\.(html?|xhtml|xht|svgz?|xml|xsl|mht(ml)?|shtml|pdf)$/i;

/** Must run before app 'ready'. */
function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

function reply(status, body, extra = {}, addon = false) {
  return new Response(body, {
    status,
    headers: { ...securityHeaders({ addon }), ...extra },
  });
}

async function regularFile(file, roots) {
  try {
    const st = await fsp.stat(file);
    return st.isFile() && (await isRealInside(file, roots)) ? st : null;
  } catch {
    return null;
  }
}

async function serve(file, st, req, addon = false) {
  const headers = {
    'Content-Type': mimeFor(file),
    'Content-Length': String(st.size),
    'Cache-Control': 'no-cache',
  };
  if (req.method === 'HEAD') return reply(200, null, headers, addon);
  return reply(200, Readable.toWeb(fs.createReadStream(file)), headers, addon);
}

function createHandler() {
  let distRoots;
  let addonRoots;
  return async (req) => {
    if (req.method !== 'GET' && req.method !== 'HEAD')
      return reply(405, 'Method Not Allowed');
    let url;
    try {
      url = new URL(req.url);
    } catch {
      return reply(400, 'Bad Request');
    }
    if (url.hostname !== HOST || url.port || url.username || url.password)
      return reply(403, 'Forbidden');
    const parsed = parseUrlPath(url.pathname);
    if (!parsed) return reply(400, 'Bad Request');
    const { segments } = parsed;

    if (segments[0] === 'addons') {
      if (segments.length < 3 || !ADDON_NAME.test(segments[1]))
        return reply(404, 'Not Found');
      // Add-on files are data/scripts for app pages; never serve something that would render as an app:// document.
      if (ADDON_DOCUMENT.test(segments[segments.length - 1]))
        return reply(404, 'Not Found');
      const root = addonsRoot();
      addonRoots = addonRoots?.length ? addonRoots : await realRoots(root);
      const file = resolveInside(root, segments.slice(1));
      const st = file && (await regularFile(file, addonRoots));
      return st ? serve(file, st, req, true) : reply(404, 'Not Found');
    }

    const root = distRoot();
    distRoots = distRoots?.length ? distRoots : await realRoots(root);
    for (const rel of candidatesFor(segments)) {
      const file = resolveInside(root, rel.split('/'));
      const st = file && (await regularFile(file, distRoots));
      if (st) return serve(file, st, req);
    }
    const nf = resolveInside(root, ['404.html']);
    const st = nf && (await regularFile(nf, distRoots));
    if (st) {
      return reply(
        404,
        req.method === 'HEAD' ? null : Readable.toWeb(fs.createReadStream(nf)),
        {
          'Content-Type': mimeFor(nf),
        }
      );
    }
    return reply(404, 'Not Found');
  };
}

function registerHandler(session) {
  (session ? session.protocol : protocol).handle(SCHEME, createHandler());
}

module.exports = { registerScheme, registerHandler, SCHEME, HOST };
