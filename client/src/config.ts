const backendBaseUrl = import.meta.env.VITE_BACKEND_BASE_URL ?? 'http://localhost:5000';
const realtimeBaseUrl = import.meta.env.VITE_REALTIME_BASE_URL ?? 'http://localhost:8081';

function toWsUrl(httpUrl: string): string {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString().replace(/\/$/, '');
}

export const appConfig = {
  backendBaseUrl: backendBaseUrl.replace(/\/$/, ''),
  realtimeBaseUrl: realtimeBaseUrl.replace(/\/$/, ''),
  realtimeWsBaseUrl: toWsUrl(realtimeBaseUrl)
};
