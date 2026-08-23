/**
 * Background work scheduling with a pluggable keeper.
 *
 * The referee fires anchor drains, model inference and sweeps as trailing
 * background work. On a resident server the promise simply runs on the event
 * loop. On serverless hosts the platform freezes the instance once the
 * response is sent, so the entry point installs a keeper (Vercel's waitUntil)
 * that pins the invocation open until the handed-off work settles.
 *
 * Correctness never depends on the keeper: every queued action lives in the
 * durable outbox, and any later request or sweep re-drains whatever a frozen
 * instance left behind.
 */
type BackgroundKeeper = (work: Promise<void>) => void;

let keeper: BackgroundKeeper = () => {
  /* resident process: the promise already runs on the event loop */
};

export function setBackgroundKeeper(next: BackgroundKeeper): void {
  keeper = next;
}

export function background(label: string, promise: Promise<unknown>): void {
  const settled = promise.then(
    () => undefined,
    (error) => {
      console.error(
        `[background] ${label} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  );
  keeper(settled);
}
