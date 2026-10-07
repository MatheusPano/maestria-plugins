'use strict';

const { execFile } = require('child_process');

const SERVICE = 'maestria-argocd';

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10000 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

async function lookup(account) {
  const out =
    process.platform === 'darwin'
      ? await run('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w'])
      : await run('secret-tool', ['lookup', 'service', SERVICE, 'account', account]);
  return out ? out.replace(/\n$/, '') : '';
}

async function forget(account) {
  if (process.platform === 'darwin') await run('security', ['delete-generic-password', '-s', SERVICE, '-a', account]);
  else await run('secret-tool', ['clear', 'service', SERVICE, 'account', account]);
}

module.exports = { lookup, forget };
