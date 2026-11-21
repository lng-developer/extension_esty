export async function verifyTrackingWithRetry(verify, { attempts = 5, delay = () => Promise.resolve() } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await verify();
    } catch (error) {
      lastError = error;
      if (!/tracking is not visible on the order yet/i.test(String(error?.message || error)) || attempt === attempts) throw error;
      await delay(attempt);
    }
  }
  throw lastError;
}
