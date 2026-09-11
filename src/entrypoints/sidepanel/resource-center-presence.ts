export const RESOURCE_CENTER_PORT_NAME = 'foxfetch-resource-center';

const HEARTBEAT_INTERVAL_MS = 22_000;
const RECONNECT_DELAY_MS = 750;

type RuntimeWithConnect = Pick<typeof chrome.runtime, 'connect'>;

/**
 * Keeps the background informed while the resource center is visible. The
 * returned cleanup is deliberately idempotent for React Strict Mode and page
 * teardown races.
 */
export function connectResourceCenterPresence(
  tabId: number,
  runtime: RuntimeWithConnect = chrome.runtime,
): () => void {
  let disposed = false;
  let activePort: chrome.runtime.Port | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const clearHeartbeat = () => {
    if (heartbeatTimer === undefined) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  };

  const scheduleReconnect = () => {
    if (disposed || reconnectTimer !== undefined) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, RECONNECT_DELAY_MS);
  };

  const connect = () => {
    if (disposed) return;

    const port = runtime.connect({ name: RESOURCE_CENTER_PORT_NAME });
    activePort = port;

    const handleDisconnect = () => {
      if (activePort !== port) return;
      activePort = undefined;
      clearHeartbeat();
      scheduleReconnect();
    };

    port.onDisconnect.addListener(handleDisconnect);
    port.onMessage?.addListener((message: unknown) => {
      if (
        !message ||
        typeof message !== 'object' ||
        !('type' in message) ||
        message.type !== 'RESOURCE_CENTER_YIELD'
      )
        return;
      disposed = true;
      clearHeartbeat();
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      activePort = undefined;
      port.disconnect();
      window.close();
    });

    try {
      // Re-bind on every connection because an MV3 service worker restart loses
      // its in-memory tab-to-port mapping.
      port.postMessage({ type: 'BIND_RESOURCE_CENTER', tabId });
    } catch {
      handleDisconnect();
      return;
    }

    clearHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (disposed || activePort !== port) return;
      try {
        port.postMessage({ type: 'RESOURCE_CENTER_PING', tabId });
      } catch {
        handleDisconnect();
      }
    }, HEARTBEAT_INTERVAL_MS);
  };

  connect();

  return () => {
    if (disposed) return;
    disposed = true;
    clearHeartbeat();
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }

    const port = activePort;
    activePort = undefined;
    if (!port) return;
    try {
      port.disconnect();
    } catch {
      // The browser may already have disconnected the port during teardown.
    }
  };
}
