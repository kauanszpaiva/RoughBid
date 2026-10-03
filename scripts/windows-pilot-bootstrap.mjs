// The Windows supervisor uses IPC to request the worker's existing graceful
// SIGTERM handler. Windows process.kill(SIGTERM) would terminate it abruptly.
let stopRequested = false;
const deliverStop = () => {
  if (stopRequested && process.listenerCount('SIGTERM') > 0) {
    stopRequested = false;
    process.emit('SIGTERM');
  }
};
process.on('message', message => {
  if (message?.type === 'roughbid:stop') {
    stopRequested = true;
    deliverStop();
  }
});
process.on('disconnect', () => {
  stopRequested = true;
  deliverStop();
});
const retry = setInterval(deliverStop, 250);
retry.unref();
await import('./worker.ts');
