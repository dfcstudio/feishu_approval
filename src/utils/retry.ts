export async function retry<T>(
  operation: () => Promise<T>,
  options: { attempts: number; delayMs: number; shouldRetry?: (error: unknown) => boolean },
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === options.attempts || options.shouldRetry?.(error) === false) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, options.delayMs * attempt));
    }
  }

  throw lastError;
}
