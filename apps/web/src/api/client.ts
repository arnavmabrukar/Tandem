import { createDemoApi } from './demo';
import type { DashboardApi } from '../types/domain';

// Single replacement point for a future HTTP adapter. There is deliberately no network adapter.
// Getter wrappers keep storage-denied errors inside the recoverable API error UI.
export const demoApi = createDemoApi({
  getItem: (key) => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
});
export const dashboardApi: DashboardApi = demoApi;
