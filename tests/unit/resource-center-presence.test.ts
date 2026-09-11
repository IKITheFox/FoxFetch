import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  connectResourceCenterPresence,
  RESOURCE_CENTER_PORT_NAME,
} from '../../src/entrypoints/sidepanel/resource-center-presence';

interface FakePort {
  disconnect: ReturnType<typeof vi.fn>;
  emitDisconnect: () => void;
  onDisconnect: {
    addListener: ReturnType<typeof vi.fn>;
    removeListener: ReturnType<typeof vi.fn>;
  };
  postMessage: ReturnType<typeof vi.fn>;
}

function createPort(): FakePort {
  const disconnectListeners = new Set<() => void>();
  return {
    disconnect: vi.fn(),
    emitDisconnect: () => {
      for (const listener of disconnectListeners) listener();
    },
    onDisconnect: {
      addListener: vi.fn((listener: () => void) => disconnectListeners.add(listener)),
      removeListener: vi.fn((listener: () => void) => disconnectListeners.delete(listener)),
    },
    postMessage: vi.fn(),
  };
}

describe('resource center presence', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('connects with the stable presence name and disconnects exactly once', () => {
    const port = createPort();
    const connect = vi.fn(() => port) as unknown as typeof chrome.runtime.connect;

    const cleanup = connectResourceCenterPresence(17, { connect });

    expect(connect).toHaveBeenCalledWith({ name: RESOURCE_CENTER_PORT_NAME });
    expect(port.postMessage).toHaveBeenCalledWith({
      type: 'BIND_RESOURCE_CENTER',
      tabId: 17,
    });
    cleanup();
    cleanup();
    expect(port.disconnect).toHaveBeenCalledTimes(1);
  });

  it('keeps the MV3 presence port alive with a periodic heartbeat', () => {
    vi.useFakeTimers();
    const port = createPort();
    const connect = vi.fn(() => port) as unknown as typeof chrome.runtime.connect;

    const cleanup = connectResourceCenterPresence(23, { connect });
    vi.advanceTimersByTime(22_000);

    expect(port.postMessage).toHaveBeenLastCalledWith({
      type: 'RESOURCE_CENTER_PING',
      tabId: 23,
    });
    expect(port.postMessage).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it('reconnects after a disconnect and binds the tab again', () => {
    vi.useFakeTimers();
    const firstPort = createPort();
    const secondPort = createPort();
    const connect = vi
      .fn()
      .mockReturnValueOnce(firstPort)
      .mockReturnValueOnce(secondPort) as unknown as typeof chrome.runtime.connect;

    const cleanup = connectResourceCenterPresence(31, { connect });
    firstPort.emitDisconnect();
    vi.advanceTimersByTime(749);
    expect(connect).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(secondPort.postMessage).toHaveBeenCalledWith({
      type: 'BIND_RESOURCE_CENTER',
      tabId: 31,
    });
    cleanup();
  });

  it('does not reconnect after cleanup, including a queued retry', () => {
    vi.useFakeTimers();
    const port = createPort();
    const connect = vi.fn(() => port) as unknown as typeof chrome.runtime.connect;

    const cleanup = connectResourceCenterPresence(42, { connect });
    port.emitDisconnect();
    cleanup();
    cleanup();
    vi.advanceTimersByTime(5_000);

    expect(connect).toHaveBeenCalledTimes(1);
    expect(port.disconnect).not.toHaveBeenCalled();
  });
});
