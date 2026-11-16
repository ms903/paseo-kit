/** Serialize mutations of the same resource and release completed keys. */
export function keyedQueue() {
  const pending = new Map<string, Promise<unknown>>();
  function run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const next = (pending.get(key) ?? Promise.resolve()).then(task, task);
    const settled = next
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        if (pending.get(key) === settled) pending.delete(key);
      });
    pending.set(key, settled);
    return next;
  }
  return Object.assign(run, {
    drain: async () => {
      await Promise.all([...pending.values()]);
    },
  });
}
