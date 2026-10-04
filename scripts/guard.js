// Preloaded with `node -r` so old Node versions get a friendly message instead of a SyntaxError.
var major = parseInt(process.versions.node, 10);
if (major < 18) {
  console.error('\n\u{1FAE7} Systems Study needs Node 18+ (you have ' + process.version + ').\n   Run:  nvm use     (or: nvm alias default 22)\n');
  process.exit(1);
}
