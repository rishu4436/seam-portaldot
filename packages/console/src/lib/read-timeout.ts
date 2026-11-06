/** Bound read-only UI work; never use this to retry or time out a wallet submission. */
export const READ_TIMEOUT_MS = 60000;
export async function withReadTimeout<T>(
  work: Promise<T>,
  milliseconds = READ_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error("The chain read timed out. Retry the read; do not resubmit a transaction."),
            ),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
