// Starts the study server. Written in old-style JS so any Node version can show the version message.
// On Node 22+ it runs in --watch mode: after "Save to GitHub" pulls new app code, the server
// restarts itself, so a browser refresh is all you need.
var spawn = require('child_process').spawn;
var path = require('path');

var major = parseInt(process.versions.node, 10);
if (major < 18) {
  console.error('\n\u{1FAE7} Systems Study needs Node 18+ (you have ' + process.version + ').\n   Run:  nvm use     (or: nvm alias default 22)\n');
  process.exit(1);
}

var args = (major >= 22 ? ['--watch'] : []).concat([path.join(__dirname, '..', 'server.js')], process.argv.slice(2));
var child = spawn(process.execPath, args, { stdio: 'inherit' });
child.on('exit', function (code) { process.exit(code || 0); });
process.on('SIGINT', function () { child.kill('SIGINT'); });
process.on('SIGTERM', function () { child.kill('SIGTERM'); });
