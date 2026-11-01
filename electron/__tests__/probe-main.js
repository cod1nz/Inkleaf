'use strict';
// Security probe of the REAL main.js (hardening, session, navigation, network side channels).
// Run from app/: INKLEAF_DIST=<dist dir> npx electron electron/__tests__/probe-main.js
// Uses a throwaway userData dir (own single-instance lock) and a Chromium net-log to catch any
// DNS lookup / socket the app makes, including ones that bypass webRequest (preconnect, WebRTC).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, session } = require('electron');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inkleaf-probe-'));
app.setPath('userData', path.join(tmp, 'userData'));
const netlog = path.join(tmp, 'netlog.json');
app.commandLine.appendSwitch('log-net-log', netlog);
app.commandLine.appendSwitch('net-log-capture-mode', 'Everything');
if (!process.env.INKLEAF_DIST)
  process.env.INKLEAF_DIST = path.resolve(__dirname, '../../dist');
const IDLE_MS = Number(process.env.PROBE_IDLE_MS || 15000);

require('../main.js');

const results = [];
const check = (name, ok, extra) => results.push({ name, ok: !!ok, extra });
let finished = false;
function finish(code) {
  if (finished) return;
  finished = true;
  for (const r of results)
    console.log(
      `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.extra !== undefined ? '  ' + JSON.stringify(r.extra) : ''}`
    );
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `\n${failed} FAILED` : `\nALL ${results.length} PASSED`);
  app.exit(code ?? (failed ? 1 : 0));
}
setTimeout(() => {
  console.log('TIMEOUT');
  finish(2);
}, IDLE_MS + 60000).unref();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readNetlog() {
  // The log is finalised on exit; while running it is a JSON prefix, so scan lines instead of parsing.
  try {
    return fs.readFileSync(netlog, 'utf8');
  } catch {
    return '';
  }
}
/** Hosts that reached a real resolver job (OS / DoH lookup), i.e. a DNS query that could leave the machine. */
function resolvedHosts(txt) {
  const hosts = new Set();
  for (const m of txt.matchAll(
    /"dns_query_types":\[[^\]]*\],"host":"([^"]+)"/g
  ))
    hosts.add(m[1]);
  return [...hosts];
}
/** Remote socket addresses Chromium tried to connect to (TCP connect attempts / UDP connects). */
function connectAddresses(txt) {
  const out = new Set();
  for (const m of txt.matchAll(/"address":"([^"]+)"/g)) out.add(m[1]);
  return [...out];
}

app.whenReady().then(async () => {
  try {
    let win;
    for (let i = 0; i < 100 && !(win = BrowserWindow.getAllWindows()[0]); i++)
      await sleep(100);
    if (!win) throw new Error('no window');
    await new Promise((r) =>
      win.webContents.isLoading()
        ? win.webContents.once('did-finish-load', r)
        : r()
    );
    const wc = win.webContents;
    const js = (code) => wc.executeJavaScript(code);
    const prefs = wc.getLastWebPreferences ? wc.getLastWebPreferences() : {};

    check(
      'loaded app://bentopdf/',
      wc.getURL().startsWith('app://bentopdf/'),
      wc.getURL()
    );
    check('contextIsolation', prefs.contextIsolation === true);
    check('sandbox', prefs.sandbox === true);
    check('nodeIntegration off', prefs.nodeIntegration === false);
    check('nodeIntegrationInSubFrames off', !prefs.nodeIntegrationInSubFrames);
    check('webviewTag off', !prefs.webviewTag);
    check(
      'session spellchecker off',
      session.defaultSession.isSpellCheckerEnabled() === false
    );
    check(
      'webrtc policy blocks non-proxied UDP',
      wc.getWebRTCIPHandlingPolicy() === 'disable_non_proxied_udp',
      wc.getWebRTCIPHandlingPolicy()
    );
    check('crossOriginIsolated', (await js('crossOriginIsolated')) === true);
    const csp = await js(
      `fetch('/').then(r => r.headers.get('content-security-policy'))`
    );
    check(
      'CSP header on page',
      /default-src 'self'/.test(csp || '') && !/'unsafe-eval'/.test(csp || ''),
      csp
    );
    check(
      'eval blocked',
      (await js(
        `(() => { try { eval('1'); return 'EVAL'; } catch { return 'blocked'; } })()`
      )) === 'blocked'
    );
    const leaks = await js(
      `['require','process','Buffer','ipcRenderer','electron','module','global'].filter(k => typeof window[k] !== 'undefined')`
    );
    check('no node globals', leaks.length === 0, leaks);
    check(
      'remote fetch blocked',
      (await js(
        `fetch('https://example.com/').then(() => 'LOADED', () => 'blocked')`
      )) === 'blocked'
    );
    check(
      'file:// fetch blocked',
      (await js(
        `fetch('file:///C:/Windows/win.ini').then(() => 'LOADED', () => 'blocked')`
      )) === 'blocked'
    );

    // Navigation lock: top-level to file://, UNC-ish file URL, remote http (confirm dialog is shown -> we cannot click it,
    // so only non-http schemes are tried here), javascript:, data:.
    for (const target of [
      'file:///C:/Windows/win.ini',
      'file://probe-unc-host.invalid/share/x.pdf',
      'data:text/html,<b>x</b>',
      'smb://probe-smb.invalid/share',
    ]) {
      await js(`location.href = ${JSON.stringify(target)}; 1`).catch(() => {});
      await sleep(400);
      check(
        `top navigation blocked: ${target}`,
        wc.getURL().startsWith('app://bentopdf/'),
        wc.getURL()
      );
    }
    // window.open of a non-http scheme: denied silently, no new window.
    await js(
      `window.open('file:///C:/Windows/win.ini'); window.open('smb://probe-smb.invalid/x'); 1`
    );
    await sleep(300);
    check(
      'window.open denied (no new window)',
      BrowserWindow.getAllWindows().length === 1
    );
    // iframe navigation to file:// is blocked
    const frameRes = await js(
      `new Promise(res => { const f = document.createElement('iframe'); f.src = 'file://probe-unc-host.invalid/share/x.html'; document.body.appendChild(f); setTimeout(() => { try { res(String(f.contentWindow.location.href)); } catch (e) { res('xo'); } }, 800); })`
    );
    check(
      'iframe to file:// UNC not loaded',
      !/^file:/.test(frameRes),
      frameRes
    );

    // Side channels that bypass webRequest: DNS prefetch, preconnect, WebRTC STUN.
    await js(`(() => {
      for (const [rel, href] of [['dns-prefetch', '//probe-dnsprefetch.example.com'], ['preconnect', 'https://probe-preconnect.example.com']]) {
        const l = document.createElement('link'); l.rel = rel; l.href = href; document.head.appendChild(l);
      }
      const l2 = document.createElement('link'); l2.rel = 'preconnect'; l2.href = 'https://192.0.2.55:8443'; document.head.appendChild(l2);
      const a = document.createElement('a'); a.href = 'https://probe-anchor.example.com/'; a.textContent = 'x'; document.body.appendChild(a);
      try {
        const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:probe-stun.example.com:3478' }, { urls: 'turn:probe-turn.example.com:3478', username: 'u', credential: 'p' }] });
        pc.createDataChannel('x');
        pc.createOffer().then(o => pc.setLocalDescription(o));
        window.__pc = pc;
      } catch (e) { window.__pcErr = String(e); }
      return 1;
    })()`);

    // Idle on home and watch the net-log.
    await sleep(IDLE_MS);
    const ice = await js(
      `window.__pc ? window.__pc.localDescription && window.__pc.localDescription.sdp.split('\\n').filter(l => l.startsWith('a=candidate')).length : -1`
    ).catch(() => -2);
    check('no WebRTC ICE candidates gathered', ice <= 0, ice);
    const txt = readNetlog();
    check('net-log captured', txt.length > 1000, txt.length);
    const dns = resolvedHosts(txt).filter(
      (h) => !/^(app:\/\/)?(localhost|127\.0\.0\.1)$/.test(h)
    );
    check(
      'no DNS resolution while idle (incl. dns-prefetch / STUN / TURN probes)',
      dns.length === 0,
      dns.slice(0, 20)
    );
    // [2001:4860:4860::8888]:443 is Chromium's IPv6 reachability check: a UDP connect() (route lookup only, no packet).
    const addrs = connectAddresses(txt).filter(
      (a) =>
        !/^(127\.0\.0\.1|\[::1\]|localhost)(:|$)/.test(a) &&
        a !== '[2001:4860:4860::8888]:443'
    );
    check(
      'no outbound socket connects (incl. preconnect to an IP literal)',
      addrs.length === 0,
      addrs.slice(0, 20)
    );
    finish();
  } catch (e) {
    console.log('ERROR', (e && e.stack) || e);
    finish(3);
  }
});
