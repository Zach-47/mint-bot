/** ms-precision structured logging to stdout only. */

function ts(): string {
  return new Date().toISOString();
}

function emit(level: string, msg: string): void {
  process.stdout.write(`${ts()} ${level} ${msg}\n`);
}

export function log(msg: string): void {
  emit("INFO ", msg);
}

export function warn(msg: string): void {
  emit("WARN ", msg);
}

export function error(msg: string): void {
  emit("ERROR", msg);
}

export function ok(msg: string): void {
  emit("OK   ", msg);
}

export function fail(msg: string): void {
  emit("FAIL ", msg);
}

/** Rate-limited logger: at most one emission per `windowMs` per key. */
export function makeThrottledLogger(windowMs: number) {
  const last = new Map<string, number>();
  return (key: string, fn: () => void): void => {
    const now = Date.now();
    const prev = last.get(key) ?? 0;
    if (now - prev < windowMs) return;
    last.set(key, now);
    fn();
  };
}

export function fmtEth(wei: bigint): string {
  const neg = wei < 0n;
  const abs = neg ? -wei : wei;
  const whole = abs / 10n ** 18n;
  const frac = (abs % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""} ETH`;
}

export function fmtMs(n: number): string {
  return `${n.toFixed(2)}ms`;
}
