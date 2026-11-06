export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/** Buffer an untrusted response with a byte cap and the time remaining in the request's deadline. */
export async function readResponseBody(
  response: Response,
  options: { timeoutMs: number; maxBytes: number; signal?: AbortSignal },
): Promise<ArrayBuffer> {
  const { timeoutMs, maxBytes, signal } = options;
  const reader = response.body?.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectBoundary!: (reason: unknown) => void;
  const boundary = new Promise<never>((_, reject) => { rejectBoundary = reject; });
  const onAbort = () => rejectBoundary(abortReason(signal!));
  const timeoutError = () => new Error("response body did not finish within the request deadline");

  try {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError("maxBytes must be a non-negative integer");
    if (signal?.aborted) throw abortReason(signal);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw timeoutError();
    if (!reader) return new ArrayBuffer(0);
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => rejectBoundary(timeoutError()), timeoutMs);
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), boundary]);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`response body exceeded ${maxBytes} bytes`);
      chunks.push(value);
    }
    const body = new ArrayBuffer(total);
    const bytes = new Uint8Array(body);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  } catch (error) {
    // Cancel the owner of the stream lock. Response.body.cancel() fails while a reader owns it.
    // Do not await cancellation: an untrusted stream's cleanup may itself never finish.
    if (reader) void reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    reader?.releaseLock();
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("request aborted", "AbortError");
}
