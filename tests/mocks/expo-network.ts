type NetworkState = { isConnected: boolean; isInternetReachable: boolean };

const listeners = new Set<(state: NetworkState) => void>();
let state: NetworkState = { isConnected: true, isInternetReachable: true };

export function addNetworkStateListener(listener: (state: NetworkState) => void) {
  listeners.add(listener);
  return { remove: () => listeners.delete(listener) };
}

export async function getNetworkStateAsync() {
  return state;
}

export function __setNetworkState(next: NetworkState) {
  state = next;
  for (const listener of listeners) listener(next);
}
