/**
 * `fn` at most once per `ms`: the first call runs at once, later ones within the window are
 * folded into one trailing call with the latest arguments. `flush` runs a pending call now
 * (on release), `cancel` drops it.
 */
export function throttle<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: A | undefined;
  const run = () => {
    timer = undefined;
    last = Date.now();
    const args = pending!;
    pending = undefined;
    fn(...args);
  };
  const call = (...args: A) => {
    pending = args;
    const wait = ms - (Date.now() - last);
    if (wait <= 0) run();
    else timer ??= setTimeout(run, wait);
  };
  call.flush = () => {
    if (timer) clearTimeout(timer);
    if (pending) run();
  };
  call.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    pending = undefined;
  };
  return call;
}
