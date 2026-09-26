import type { RealtimeEventSource } from './realtime-client';

interface NativeXhr {
  readyState: number;
  status: number;
  responseText: string;
  onreadystatechange: (() => void) | null;
  onprogress: (() => void) | null;
  onload: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
  ontimeout: ((event: unknown) => void) | null;
  onabort: ((event: unknown) => void) | null;
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(): void;
  abort(): void;
}

type NativeXhrConstructor = new () => NativeXhr;

interface SseEvent {
  type: string;
  data: string;
  lastEventId?: string;
}

/** XHR-backed EventSource for React Native, where the browser API is absent. */
export class NativeEventSource implements RealtimeEventSource {
  onerror: ((event: unknown) => void) | null = null;
  onopen: (() => void) | null = null;
  status?: number;

  private readonly xhr: NativeXhr;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  private responseOffset = 0;
  private lineBuffer = '';
  private eventType = '';
  private eventData: string[] = [];
  private lastEventId = '';
  private opened = false;
  private closed = false;
  private failed = false;

  constructor(url: string, Xhr: NativeXhrConstructor = getXhrConstructor()) {
    this.xhr = new Xhr();
    this.xhr.onreadystatechange = () => this.handleReadyState();
    this.xhr.onprogress = () => {
      this.handleReadyState();
      this.readResponse(false);
    };
    this.xhr.onload = () => {
      this.handleReadyState();
      this.readResponse(true);
      this.fail();
    };
    this.xhr.onerror = (event) => this.fail(event);
    this.xhr.ontimeout = (event) => this.fail(event);
    this.xhr.onabort = (event) => {
      if (!this.closed) this.fail(event);
    };
    this.xhr.open('GET', url);
    this.xhr.setRequestHeader('Accept', 'text/event-stream');
    this.xhr.send();
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type);
    listeners?.delete(listener);
    if (listeners?.size === 0) this.listeners.delete(type);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.xhr.onreadystatechange = null;
    this.xhr.onprogress = null;
    this.xhr.onload = null;
    this.xhr.onerror = null;
    this.xhr.ontimeout = null;
    this.xhr.onabort = null;
    this.xhr.abort();
    this.listeners.clear();
  }

  private handleReadyState(): void {
    if (this.closed || this.failed || this.opened || this.xhr.readyState < 2) return;
    this.status = this.xhr.status;
    if (this.status < 200 || this.status >= 300) {
      this.fail({ status: this.status });
      return;
    }
    this.opened = true;
    this.onopen?.();
  }

  private readResponse(atEnd: boolean): void {
    if (this.closed || this.failed || !this.opened) return;
    const text = this.xhr.responseText ?? '';
    if (text.length < this.responseOffset) this.responseOffset = 0;
    this.lineBuffer += text.slice(this.responseOffset);
    this.responseOffset = text.length;

    let newline = this.lineBuffer.search(/[\r\n]/);
    while (newline >= 0) {
      if (this.lineBuffer[newline] === '\r' && newline === this.lineBuffer.length - 1 && !atEnd) {
        break;
      }
      const line = this.lineBuffer.slice(0, newline);
      const separatorLength =
        this.lineBuffer[newline] === '\r' && this.lineBuffer[newline + 1] === '\n' ? 2 : 1;
      if (separatorLength === 1 && newline === this.lineBuffer.length - 1 && !atEnd) break;
      this.lineBuffer = this.lineBuffer.slice(newline + separatorLength);
      this.consumeLine(line);
      newline = this.lineBuffer.search(/[\r\n]/);
    }
    if (atEnd && this.lineBuffer.length > 0) {
      this.consumeLine(this.lineBuffer);
      this.lineBuffer = '';
    }
    if (atEnd) this.dispatchEvent();
  }

  private consumeLine(line: string): void {
    if (line === '') {
      this.dispatchEvent();
      return;
    }
    if (line.startsWith(':')) return;
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event':
        this.eventType = value;
        break;
      case 'data':
        this.eventData.push(value);
        break;
      case 'id':
        if (!value.includes('\0')) this.lastEventId = value;
        break;
      default:
        break;
    }
  }

  private dispatchEvent(): void {
    if (this.eventData.length === 0) {
      this.eventType = '';
      return;
    }
    const event: SseEvent = {
      type: this.eventType || 'message',
      data: this.eventData.join('\n'),
      lastEventId: this.lastEventId,
    };
    this.eventData = [];
    this.eventType = '';
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
  }

  private fail(event?: unknown): void {
    if (this.closed || this.failed) return;
    this.failed = true;
    if (typeof this.xhr.status === 'number' && this.xhr.status > 0) this.status = this.xhr.status;
    const error =
      event && typeof event === 'object'
        ? { ...(event as Record<string, unknown>), status: this.status ?? 0 }
        : { status: this.status ?? 0 };
    this.onerror?.(error);
  }
}

function getXhrConstructor(): NativeXhrConstructor {
  const Xhr = (globalThis as typeof globalThis & { XMLHttpRequest?: NativeXhrConstructor })
    .XMLHttpRequest;
  if (!Xhr) throw new Error('This platform does not provide XMLHttpRequest for realtime chat.');
  return Xhr;
}

/** Keep browser EventSource behavior, using XHR only on platforms without it. */
export function createRuntimeEventSource(url: string): RealtimeEventSource {
  const EventSourceConstructor = (
    globalThis as typeof globalThis & {
      EventSource?: new (source: string) => RealtimeEventSource;
    }
  ).EventSource;
  return EventSourceConstructor
    ? (new EventSourceConstructor(url) as unknown as RealtimeEventSource)
    : new NativeEventSource(url);
}
