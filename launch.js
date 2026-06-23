#!/usr/bin/env node
'use strict';

// Startet die Electron-App. Chrome-Check und -Start übernimmt der
// eingebaute Splash-Screen (src/splash.html + main.js splash:*-Handler).

const { spawn } = require('child_process');
const path      = require('path');

const electronBin = require('electron');
const extraArgs   = process.argv.slice(2); // z.B. --dev

const child = spawn(electronBin, ['.', ...extraArgs], {
  cwd:         __dirname,
  stdio:       'inherit',
  windowsHide: false,
});

child.on('close', (code, signal) => {
  if (code === null) {
    console.error('Electron exited with signal', signal);
    process.exit(1);
  }
  process.exit(code);
});

process.on('SIGINT',  () => { if (!child.killed) child.kill('SIGINT');  });
process.on('SIGTERM', () => { if (!child.killed) child.kill('SIGTERM'); });
