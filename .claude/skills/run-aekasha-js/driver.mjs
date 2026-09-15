#!/usr/bin/env node
// Headless-browser driver for aekasha-js (WebGPU/Three.js app).
// Navigates a running dev-server URL, waits for the scene to settle,
// captures console/page errors, and takes a screenshot.
//
// Usage:
//   node driver.mjs <baseUrl> [urlSuffix] [outFile] [waitMs]
//
// Examples:
//   node driver.mjs http://localhost:8080 "" out.png
//   node driver.mjs http://localhost:8080 "?isDebug=true" debug.png
//
// Exits non-zero and prints [DRIVER][FATAL] on launch/navigation failure.
// Always prints captured console/page errors before exiting, even on success -
// a blank WebGPU canvas often reports "success" (page loaded) while every
// GPU call silently failed, so check this output, not just the screenshot.

import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import { platform } from 'node:os';

const [, , baseUrlArg, urlSuffixArg, outFileArg, waitMsArg] = process.argv;

if (!baseUrlArg) {
  console.error('Usage: node driver.mjs <baseUrl> [urlSuffix] [outFile] [waitMs]');
  process.exit(1);
}

const baseUrl = baseUrlArg.replace(/\/$/, '');
const urlSuffix = urlSuffixArg ?? '';
const outFile = outFileArg ?? 'screenshot.png';
const waitMs = Number(waitMsArg ?? 6000);

// --- Locate a system browser (system Chrome/Chromium/Edge is much
// faster than downloading Playwright's own bundled Chromium, and avoids
// a large one-time download on a fresh machine). Falls back to letting
// playwright-core manage its own browser if nothing is found - see
// SKILL.md Troubleshooting for the `npx playwright install chromium` step
// this requires (playwright-core alone cannot download browsers).
function findBrowserExecutable() {
  const candidates = [];
  const os = platform();

  if (os === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    );
  } else if (os === 'win32') {
    candidates.push(
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    );
  } else {
    // Linux, including WSL2. Try native Linux browsers first, then
    // reach across into the Windows host filesystem (WSL2 only) as a
    // last resort - this is UNVERIFIED (authored/tested on macOS only;
    // see SKILL.md).
    candidates.push(
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
      '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
    );
  }

  return candidates.find((p) => existsSync(p));
}

const executablePath = findBrowserExecutable();
if (executablePath) {
  console.log('[DRIVER] using system browser:', executablePath);
} else {
  console.log(
    '[DRIVER] no system browser found for this platform, falling back to playwright-managed Chromium ' +
      '(requires: npx playwright install chromium --with-deps, run once from this directory)'
  );
}

// --enable-unsafe-webgpu / --enable-features=Vulkan: verified needed on
// macOS Chrome stable to get WebGPU rendering (without them the canvas
// silently stays blank). Unverified on Linux/WSL2 - if WebGPU still
// doesn't init there, try adding --use-angle=vulkan or, as a
// software-rendering last resort, --use-gl=swiftshader / --use-angle=swiftshader
// (slow, but works without real GPU passthrough).
const launchArgs = ['--enable-unsafe-webgpu', '--enable-features=Vulkan'];

const browser = await chromium
  .launch({
    ...(executablePath ? { executablePath } : {}),
    args: launchArgs,
  })
  .catch((err) => {
    console.error('[DRIVER][FATAL] browser launch failed:', err.message);
    process.exit(1);
  });

const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });

const consoleLogs = [];
page.on('console', (msg) => consoleLogs.push(`[console:${msg.type()}] ${msg.text()}`));
page.on('pageerror', (err) => consoleLogs.push(`[pageerror] ${err.message}`));

const targetUrl = baseUrl + urlSuffix;
console.log('[DRIVER] navigating to', targetUrl);

try {
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
} catch (err) {
  console.error('[DRIVER][FATAL] navigation failed:', err.message);
  await browser.close();
  process.exit(1);
}

// No reliable "scene fully loaded" DOM signal was found for this app
// (physics/assets/WebGPU pipeline compilation all happen after
// domcontentloaded with no exposed ready event) - this fixed wait is an
// approximation. Bump waitMs if screenshots look like they caught the
// loading screen.
await page.waitForTimeout(waitMs);

await page.screenshot({ path: outFile });
console.log('[DRIVER] screenshot saved to', outFile);

console.log('[DRIVER] --- console/page output ---');
for (const line of consoleLogs) console.log(line);
console.log('[DRIVER] --- end console/page output ---');

await browser.close();
