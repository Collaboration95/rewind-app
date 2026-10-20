import { NativeEventSource, createRuntimeEventSource } from '../src/chat/native-event-source';

class FakeXhr {
  readyState = 0;
  status = 0;
  responseText = '';
  onreadystatechange: (() => void) | null = null;
  onprogress: (() => void) | null = null;
  onload: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  ontimeout: ((event: unknown) => void) | null = null;
  onabort: ((event: unknown) => void) | null = null;
  headers: [string, string][] = [];
  abortCount = 0;
  static last: FakeXhr;

  constructor() {
    FakeXhr.last = this;
  }

  open() {}
  setRequestHeader(name: string, value: string) {
    this.headers.push([name, value]);
  }
  send() {}
  abort() {
    this.abortCount += 1;
  }

  headersReceived(status: number) {
    this.readyState = 2;
    this.status = status;
    this.onreadystatechange?.();
  }

  progress(text: string, status = 200) {
    this.readyState = 3;
    this.status = status;
    this.responseText = text;
    this.onreadystatechange?.();
    this.onprogress?.();
  }

  finish(text: string, status = 200) {
    this.readyState = 4;
    this.status = status;
    this.responseText = text;
    this.onload?.();
  }
}

function collect(source: NativeEventSource, type = 'message') {
  const received: { type: string; data: string; lastEventId?: string }[] = [];
  source.addEventListener(type, (event) =>
    received.push(event as { type: string; data: string; lastEventId?: string }),
  );
  return received;
}

describe('NativeEventSource stream completion', () => {
  it('flushes an unterminated final event and then reports the ended stream as an error', () => {
    const source = new NativeEventSource('/events', FakeXhr);
    const received = collect(source);
    const onerror = jest.fn();
    const onopen = jest.fn();
    source.onerror = onerror;
    source.onopen = onopen;
    const xhr = FakeXhr.last;

    // The server closed the connection mid-line: the dangling `data:` line
    // is still part of an event and must not be silently dropped.
    xhr.finish('data: first\n\ndata: dangling');

    expect(onopen).toHaveBeenCalledTimes(1);
    expect(received.map((event) => event.data)).toEqual(['first', 'dangling']);
    // A long-lived SSE response should never end normally; callers must reconnect.
    expect(onerror).toHaveBeenCalledWith({ status: 200 });
    expect(xhr.abortCount).toBe(1);
  });

  it('treats a bare trailing CR as a line break only once the stream has ended', () => {
    const source = new NativeEventSource('/events', FakeXhr);
    const received = collect(source);
    const xhr = FakeXhr.last;

    xhr.progress('data: held\r');
    expect(received).toEqual([]);

    xhr.finish('data: held\r');
    expect(received.map((event) => event.data)).toEqual(['held']);
  });

  it('fails a non-2xx load with the HTTP status and never opens', () => {
    const source = new NativeEventSource('/events', FakeXhr);
    const onopen = jest.fn();
    const onerror = jest.fn();
    source.onopen = onopen;
    source.onerror = onerror;

    FakeXhr.last.finish('{"error":"forbidden"}', 403);

    expect(onopen).not.toHaveBeenCalled();
    expect(onerror).toHaveBeenCalledTimes(1);
    expect(onerror).toHaveBeenCalledWith({ status: 403 });
    expect(source.status).toBe(403);
  });

  it('reports 401 on the response headers before any body is read', () => {
    const source = new NativeEventSource('/events', FakeXhr);
    const onerror = jest.fn();
    source.onerror = onerror;
    const xhr = FakeXhr.last;

    xhr.headersReceived(401);
    // Later callbacks for the same failed request must stay silent.
    xhr.progress('data: leaked\n\n', 401);

    expect(onerror).toHaveBeenCalledTimes(1);
    expect(onerror).toHaveBeenCalledWith({ status: 401 });
    expect(xhr.abortCount).toBe(1);
  });
});

describe('NativeEventSource failure signals', () => {
  it('propagates network errors and timeouts with the event fields and a status', () => {
    const errored = new NativeEventSource('/events', FakeXhr);
    const onError = jest.fn();
    errored.onerror = onError;
    FakeXhr.last.onerror?.({ type: 'error' });
    expect(onError).toHaveBeenCalledWith({ type: 'error', status: 0 });

    const timedOut = new NativeEventSource('/events', FakeXhr);
    const onTimeout = jest.fn();
    timedOut.onerror = onTimeout;
    FakeXhr.last.ontimeout?.({ type: 'timeout' });
    expect(onTimeout).toHaveBeenCalledWith({ type: 'timeout', status: 0 });
  });

  it('keeps an already-known status when the connection later drops', () => {
    const source = new NativeEventSource('/events', FakeXhr);
    const onerror = jest.fn();
    source.onerror = onerror;
    const xhr = FakeXhr.last;
    xhr.progress('data: ok\n\n');

    xhr.onerror?.(undefined);

    expect(onerror).toHaveBeenCalledWith({ status: 200 });
  });

  it('treats an unexpected abort as a failure but an abort after close() as silent', () => {
    const aborted = new NativeEventSource('/events', FakeXhr);
    const onAborted = jest.fn();
    aborted.onerror = onAborted;
    const abortedXhr = FakeXhr.last;
    abortedXhr.onabort?.({ type: 'abort' });
    expect(onAborted).toHaveBeenCalledTimes(1);
    expect(onAborted).toHaveBeenCalledWith({ type: 'abort', status: 0 });

    const closed = new NativeEventSource('/events', FakeXhr);
    const onClosed = jest.fn();
    closed.onerror = onClosed;
    const closedXhr = FakeXhr.last;
    closed.close();
    // close() detaches handlers, so the abort it triggers must not surface.
    expect(closedXhr.onabort).toBeNull();
    expect(onClosed).not.toHaveBeenCalled();
    expect(closedXhr.abortCount).toBe(1);
  });

  it('close() is idempotent and drops listeners so late data is not delivered', () => {
    const source = new NativeEventSource('/events', FakeXhr);
    const received = collect(source);
    const xhr = FakeXhr.last;
    xhr.progress('data: one\n\n');
    source.close();
    source.close();

    expect(received).toHaveLength(1);
    expect(xhr.abortCount).toBe(1);
  });
});

describe('NativeEventSource framing limits', () => {
  it('fails when a single line grows past the limit without ever ending', () => {
    const source = new NativeEventSource('/events', FakeXhr);
    const onerror = jest.fn();
    source.onerror = onerror;
    const xhr = FakeXhr.last;

    xhr.progress(`data: ${'x'.repeat(20 * 1024)}`);

    expect(onerror).toHaveBeenCalledTimes(1);
    expect(onerror).toHaveBeenCalledWith({ status: 200, code: 'line_too_large' });
    expect(xhr.abortCount).toBe(1);
  });

  it('fails when a dangling final line exceeds the per-line limit at end of stream', () => {
    const source = new NativeEventSource('/events', FakeXhr);
    const onerror = jest.fn();
    const received = collect(source);
    source.onerror = onerror;

    FakeXhr.last.finish(`data: ${'y'.repeat(20 * 1024)}`);

    expect(received).toEqual([]);
    expect(onerror).toHaveBeenCalledTimes(1);
    expect(onerror).toHaveBeenCalledWith({ status: 200, code: 'line_too_large' });
  });

  it('fails an event whose accumulated lines exceed the event limit', () => {
    const source = new NativeEventSource('/events', FakeXhr);
    const onerror = jest.fn();
    const received = collect(source);
    source.onerror = onerror;
    const line = `data: ${'z'.repeat(10 * 1024)}\n`;

    // 7 lines of ~10 KiB with no blank line to dispatch exceeds 64 KiB.
    FakeXhr.last.progress(line.repeat(7));

    expect(received).toEqual([]);
    expect(onerror).toHaveBeenCalledWith({ status: 200, code: 'event_too_large' });
  });

  it('restarts offset tracking if the platform hands back a shorter response text', () => {
    const source = new NativeEventSource('/events', FakeXhr);
    const received = collect(source);
    const xhr = FakeXhr.last;

    xhr.progress('data: aaaaaaaaaaaaaaaa\n\n');
    xhr.progress('data: b\n\n');

    expect(received.map((event) => event.data)).toEqual(['aaaaaaaaaaaaaaaa', 'b']);
  });
});

describe('NativeEventSource field handling', () => {
  it('ignores comments and unknown fields and defaults the type to "message"', () => {
    const source = new NativeEventSource('/events', FakeXhr);
    const received = collect(source);

    FakeXhr.last.progress(': keep-alive\nretry: 3000\nunknown: value\ndata: payload\n\n');

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ type: 'message', data: 'payload' });
  });

  it('drops an event with no data lines and does not leak its type to the next event', () => {
    const source = new NativeEventSource('/events', FakeXhr);
    const messages = collect(source, 'message');
    const checkpoints = collect(source, 'checkpoint');

    FakeXhr.last.progress('event: checkpoint\n\ndata: plain\n\n');

    expect(checkpoints).toEqual([]);
    expect(messages.map((event) => event.data)).toEqual(['plain']);
  });

  it('keeps the last event id across events and ignores ids containing NUL', () => {
    const source = new NativeEventSource('/events', FakeXhr);
    const received = collect(source);

    FakeXhr.last.progress('id: 7\ndata: a\n\nid: bad\0id\ndata: b\n\n');

    expect(received.map((event) => event.lastEventId)).toEqual(['7', '7']);
  });

  it('handles a field name with no colon and strips only one leading space', () => {
    const source = new NativeEventSource('/events', FakeXhr);
    const received = collect(source);

    FakeXhr.last.progress('data\ndata:  two spaces\n\n');

    expect(received[0].data).toBe('\n two spaces');
  });

  it('removeEventListener stops delivery and an unknown listener removal is harmless', () => {
    const source = new NativeEventSource('/events', FakeXhr);
    const listener = jest.fn();
    source.addEventListener('message', listener);
    source.removeEventListener('message', jest.fn());
    source.removeEventListener('absent', listener);
    source.removeEventListener('message', listener);

    FakeXhr.last.progress('data: x\n\n');

    expect(listener).not.toHaveBeenCalled();
  });

  it('sends custom headers after Accept', () => {
    new NativeEventSource('/events', FakeXhr, { Authorization: 'Bearer t' });

    expect(FakeXhr.last.headers).toEqual([
      ['Accept', 'text/event-stream'],
      ['Authorization', 'Bearer t'],
    ]);
  });
});

describe('createRuntimeEventSource', () => {
  const globals = globalThis as unknown as { EventSource?: unknown; XMLHttpRequest?: unknown };
  const originalEventSource = globals.EventSource;
  const originalXhr = globals.XMLHttpRequest;

  afterEach(() => {
    globals.EventSource = originalEventSource;
    globals.XMLHttpRequest = originalXhr;
  });

  it('prefers the platform EventSource and forwards the credentials flag', () => {
    const constructed: { url: string; init: unknown }[] = [];
    globals.EventSource = class {
      constructor(url: string, init: unknown) {
        constructed.push({ url, init });
      }
    };

    const withDefault = createRuntimeEventSource('/events');
    createRuntimeEventSource('/events', {}, { withCredentials: true });

    expect(withDefault).not.toBeInstanceOf(NativeEventSource);
    expect(constructed.map((entry) => entry.init)).toEqual([
      { withCredentials: false },
      { withCredentials: true },
    ]);
  });

  it('falls back to the XHR adapter with auth headers when EventSource is missing', () => {
    globals.EventSource = undefined;
    globals.XMLHttpRequest = FakeXhr;

    const source = createRuntimeEventSource('/events', { Authorization: 'Bearer abc' });

    expect(source).toBeInstanceOf(NativeEventSource);
    expect(FakeXhr.last.headers).toContainEqual(['Authorization', 'Bearer abc']);
    source.close();
  });

  it('throws a clear error when neither EventSource nor XMLHttpRequest exists', () => {
    globals.EventSource = undefined;
    globals.XMLHttpRequest = undefined;

    expect(() => createRuntimeEventSource('/events')).toThrow(/XMLHttpRequest/);
  });
});
