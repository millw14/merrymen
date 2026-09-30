/** Bound optional research/recovery so it cannot hold the trading loop open. */
export async function boundedRead<T>(read: () => Promise<T>, milliseconds: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), milliseconds); }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
