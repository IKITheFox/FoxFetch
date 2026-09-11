/** Task-local, secret-free transport diagnostics. No raw exception or URL is retained. */
export interface SabrNetworkEvent {
  request: number;
  attempt: number;
  phase: 'request' | 'response' | 'body';
  elapsedMs: number;
  status?: number;
  code?: string;
  permission?: 'granted' | 'missing' | 'unknown';
}

export function safeNetworkEvents(events: readonly SabrNetworkEvent[] = []): SabrNetworkEvent[] {
  return events
    .slice(-16)
    .filter(
      (e) =>
        Number.isSafeInteger(e.request) &&
        e.request >= 1 &&
        Number.isInteger(e.attempt) &&
        e.attempt >= 1 &&
        e.attempt <= 4 &&
        ['request', 'response', 'body'].includes(e.phase) &&
        Number.isSafeInteger(e.elapsedMs) &&
        e.elapsedMs >= 0,
    )
    .map((e) => ({
      request: e.request,
      attempt: e.attempt,
      phase: e.phase,
      elapsedMs: e.elapsedMs,
      ...(Number.isInteger(e.status) && e.status! >= 100 && e.status! <= 599
        ? { status: e.status }
        : {}),
      ...(e.code &&
      /^(?:SABR_(?:NETWORK_FAILED|INVOCATION_FAILED|TIMEOUT|BODY_INTERRUPTED|ABORTED|PERMISSION_REQUIRED)|SOURCE_HTTP_\d{3})$/.test(
        e.code,
      )
        ? { code: e.code }
        : {}),
      ...(e.permission && ['granted', 'missing', 'unknown'].includes(e.permission)
        ? { permission: e.permission }
        : {}),
    }));
}

export function waitForSabrRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(new Error('SABR_ABORTED'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Owns the sole retry budget. Once a response body is exposed it is never replayed. */
export async function fetchSabrResponse(
  url: string,
  init: RequestInit,
  options: {
    signal: AbortSignal;
    request: number;
    fetch: typeof fetch;
    onEvent?: (event: SabrNetworkEvent) => void;
    timeoutMs?: number;
    checkPermission?: () => Promise<boolean>;
  },
): Promise<Response> {
  // Native Window.fetch must not receive the options object as its receiver.
  // Injected implementations share the plain callable-function contract.
  const network = options.fetch;
  for (let attempt = 1; attempt <= 4; attempt++) {
    options.signal.throwIfAborted();
    const started = Date.now();
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000);
    const signal = AbortSignal.any([
      options.signal,
      timeout,
      ...(init.signal ? [init.signal] : []),
    ]);
    let status = 0;
    let permission: SabrNetworkEvent['permission'];
    const emit = (phase: SabrNetworkEvent['phase'], code?: string) =>
      options.onEvent?.({
        request: options.request,
        attempt,
        phase,
        elapsedMs: Math.max(0, Date.now() - started),
        ...(status ? { status } : {}),
        ...(code ? { code } : {}),
        ...(permission ? { permission } : {}),
      });
    const failureCode = () =>
      options.signal.aborted || init.signal?.aborted
        ? 'SABR_ABORTED'
        : timeout.aborted
          ? 'SABR_TIMEOUT'
          : 'SABR_NETWORK_FAILED';
    let response: Response;
    try {
      response = await network(url, { ...init, redirect: 'error', signal });
    } catch (error) {
      let code = failureCode();
      if (
        code === 'SABR_NETWORK_FAILED' &&
        error instanceof TypeError &&
        /illegal invocation/i.test(error.message)
      ) {
        emit('request', 'SABR_INVOCATION_FAILED');
        // Raw network causes can contain signed URLs or request credentials.
        // eslint-disable-next-line preserve-caught-error
        throw new Error('SABR_INVOCATION_FAILED');
      }
      if (code !== 'SABR_ABORTED') {
        permission = 'unknown';
        try {
          if (options.checkPermission)
            permission = (await options.checkPermission()) ? 'granted' : 'missing';
        } catch {
          /* Remain unknown. */
        }
        if (options.signal.aborted || init.signal?.aborted) code = 'SABR_ABORTED';
        else if (permission === 'missing') code = 'SABR_PERMISSION_REQUIRED';
      }
      emit('request', code);
      if (code === 'SABR_ABORTED' || code === 'SABR_PERMISSION_REQUIRED' || attempt === 4)
        // eslint-disable-next-line preserve-caught-error -- Never expose a raw network cause.
        throw new Error(code);
      await waitForSabrRetry(500 * 2 ** (attempt - 1), signalForWait(options.signal, init.signal));
      continue;
    }
    status = response.status;
    if (!response.ok || !response.body) {
      const code = `SOURCE_HTTP_${status}`;
      emit('response', code);
      await response.body?.cancel().catch(() => undefined);
      if (attempt === 4 || !(status === 429 || status === 408 || status >= 500))
        throw new Error(code);
      const header = response.headers.get('retry-after');
      const seconds = header === null ? NaN : Number(header);
      const delay =
        header === null
          ? 0
          : Number.isFinite(seconds)
            ? seconds * 1000
            : Date.parse(header) - Date.now();
      // Do not retry earlier than a server-requested delay that exceeds our budget.
      if (delay > 30_000) throw new Error(code);
      await waitForSabrRetry(
        Math.max(500 * 2 ** (attempt - 1), Number.isFinite(delay) ? delay : 0),
        signalForWait(options.signal, init.signal),
      );
      continue;
    }
    emit('response');
    const reader = response.body.getReader();
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            signal.throwIfAborted();
            const item = await reader.read();
            if (item.done) {
              reader.releaseLock();
              controller.close();
            } else controller.enqueue(item.value);
          } catch {
            const cause = failureCode();
            const code = cause === 'SABR_NETWORK_FAILED' ? 'SABR_BODY_INTERRUPTED' : cause;
            emit('body', code);
            await reader.cancel().catch(() => undefined);
            controller.error(new Error(code));
          }
        },
        cancel(reason) {
          return reader.cancel(reason);
        },
      }),
      { status, headers: response.headers },
    );
  }
  throw new Error('SABR_NETWORK_FAILED');
}

function signalForWait(signal: AbortSignal, other?: AbortSignal | null) {
  return other ? AbortSignal.any([signal, other]) : signal;
}
