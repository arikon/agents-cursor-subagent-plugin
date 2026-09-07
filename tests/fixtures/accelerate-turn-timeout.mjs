const nativeSetTimeout = globalThis.setTimeout;

globalThis.setTimeout = (callback, delay, ...args) => nativeSetTimeout(
  callback,
  (delay === 3_600_000 && process.env.FAKE_ACP_ACCELERATE_TURN_TIMEOUT === '1')
    || (delay === 30_000 && process.env.FAKE_ACP_ACCELERATE_WAIT_TIMEOUT === '1') ? 100 : delay,
  ...args,
);
