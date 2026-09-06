// Local compatibility shim for Vercel CLI on Windows. No machine settings change.
const cp = require('node:child_process');
const path = require('node:path');
const original = cp.spawn;
cp.spawn = function(command, args, options) {
  if (process.platform === 'win32' && options?.env) {
    const env = { ...options.env };
    const paths = Object.keys(env).filter(key => key.toLowerCase() === 'path').flatMap(key => String(env[key]).split(path.delimiter));
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
    env.PATH = [...new Set([path.dirname(process.execPath), path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'), ...paths])].join(path.delimiter);
    options = { ...options, env };
  }
  if (/^cmd\.exe$/i.test(command)) command = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
  return original.call(this, command, args, options);
};
