'use strict';

const { execFile } = require('child_process');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');

// Run a git command safely using execFile (no shell injection risk)
function git(args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: REPO_ROOT }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout.trim());
    });
  });
}

async function gitPush(cycleTimestamp) {
  try {
    // If GITHUB_TOKEN is set, rewrite the remote URL to embed it so push
    // works without any interactive password prompt.
    const token = process.env.GITHUB_TOKEN;
    if (token) {
      await git(['remote', 'set-url', 'origin',
        `https://${token}@github.com/kohlirishi/Ticket_Price_Monitor.git`]);
    }

    // Only commit if prices.json actually changed
    const status = await git(['status', '--porcelain', 'docs/prices.json']);
    if (!status) {
      console.log('[git] prices.json unchanged — skipping commit');
      return;
    }

    await git(['add', 'docs/prices.json']);

    const msg = `chore: update prices ${cycleTimestamp || new Date().toISOString()}`;
    await git(['commit', '-m', msg]);

    await git(['push']);
    console.log('[git] ✓ Pushed prices.json to GitHub');
  } catch (err) {
    // Never crash the scraper — push failures are non-fatal
    console.error('[git] ✗ Push failed (will retry next cycle):', err.message);
  }
}

module.exports = { gitPush };
