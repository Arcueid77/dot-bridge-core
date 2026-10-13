// A private inherited pipe from the finite-window launcher, enabled explicitly.
// No socket, file, provider message, or public MCP request can trigger it.
export function supervisedStop(stop) {
  if (process.env.DOT_BRIDGE_SUPERVISED !== '1') return () => {};
  let bytes = '', stopped = false;
  const cleanup = () => {
    process.stdin.off('data', data); process.stdin.off('end', end);
    process.stdin.pause(); process.stdin.destroy();
  };
  const finish = (invalid = false) => {
    if (stopped) return;
    stopped = true; cleanup();
    Promise.resolve().then(stop).then(() => { if (invalid) process.exitCode = 1; }, () => { process.exitCode = 1; });
  };
  const data = chunk => {
    bytes += chunk.toString('ascii');
    if (bytes === 'stop\n') finish();
    else if (bytes.length > 5 || !'stop\n'.startsWith(bytes)) finish(true);
  };
  const end = () => finish();
  process.stdin.on('data', data); process.stdin.once('end', end); process.stdin.resume();
  return cleanup;
}
