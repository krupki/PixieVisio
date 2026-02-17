import React, { useEffect, useMemo, useState } from 'react';
import { appConfig } from '../config';

type State = 'pending' | 'ok' | 'error';

type Status = {
  id: string;
  label: string;
  state: State;
  detail?: string;
  latencyMs?: number;
};

type Metrics = {
  totalEvents: number;
  totalBatches: number;
  lastFlushDoc?: string;
  lastFlushBatch?: number;
  lastFlushAt?: string;
  lastError?: string;
  perDocQueues?: { docId: string; queueDepth: number }[];
};

const colors: Record<State, string> = {
  pending: '#eab308',
  ok: '#22c55e',
  error: '#ef4444'
};

async function pingHttp(url: string, timeoutMs = 3000): Promise<{ ok: boolean; latency: number; detail?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const res = await fetch(url, { signal: controller.signal });
    const latency = performance.now() - started;
    if (!res.ok) return { ok: false, latency, detail: res.statusText };
    return { ok: true, latency };
  } catch (err: any) {
    const latency = performance.now() - started;
    const detail = err?.name === 'AbortError' ? 'Timeout' : String(err?.message ?? err);
    return { ok: false, latency, detail };
  } finally {
    clearTimeout(timer);
  }
}

export default function ServiceStatus() {
  const [statuses, setStatuses] = useState<Status[]>(() => [
    { id: 'frontend', label: 'Frontend (Vite)', state: 'ok', latencyMs: 0 },
    { id: 'backend', label: 'Backend API :5000', state: 'pending' },
    { id: 'realtime', label: 'Realtime WS :8081', state: 'pending' }
  ]);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [metrics, setMetrics] = useState<Metrics | null>(null);

  const diagramColor = useMemo(() => {
    const backend = statuses.find(s => s.id === 'backend')?.state;
    const realtime = statuses.find(s => s.id === 'realtime')?.state;
    if (backend === 'ok' && realtime === 'ok') return '#22c55e';
    if (backend === 'error' || realtime === 'error') return '#ef4444';
    return '#eab308';
  }, [statuses]);

  const runChecks = async () => {
    if (isRunning) return;
    setIsRunning(true);
    setStatuses(prev => prev.map(s => (s.id === 'frontend' ? s : { ...s, state: 'pending', detail: undefined, latencyMs: undefined })));

    const [backend, realtime, metricRes] = await Promise.all([
      pingHttp(`${appConfig.backendBaseUrl}/api/load?modelId=default`),
      pingHttp(`${appConfig.realtimeBaseUrl}/healthz`),
      fetch(`${appConfig.realtimeBaseUrl}/metrics`).then(r => r.ok ? r.json() : Promise.reject(new Error('metrics ' + r.status))).catch(err => ({ error: String(err) }))
    ]);

    setStatuses(prev => prev.map(s => {
      if (s.id === 'backend') {
        return {
          ...s,
          state: backend.ok ? 'ok' : 'error',
          latencyMs: Math.round(backend.latency),
          detail: backend.detail
        };
      }
      if (s.id === 'realtime') {
        return {
          ...s,
          state: realtime.ok ? 'ok' : 'error',
          latencyMs: Math.round(realtime.latency),
          detail: realtime.detail
        };
      }
      return s;
    }));

    if (metricRes && !(metricRes as any).error) {
      setMetrics(metricRes as Metrics);
    } else {
      setMetrics(null);
    }
    setLastChecked(new Date());
    setIsRunning(false);
  };

  useEffect(() => {
    runChecks();
    const id = setInterval(runChecks, 10000);
    return () => clearInterval(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 12, background: '#f8fafc', borderRadius: 8, border: '1px solid #e5e7eb' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong>Systemstatus</strong>
        <button onClick={runChecks} disabled={isRunning} style={{ padding: '4px 8px', cursor: 'pointer' }}>
          {isRunning ? 'Prüfe...' : 'Jetzt prüfen'}
        </button>
        {lastChecked && (
          <span style={{ fontSize: 12, color: '#6b7280' }}>
            zuletzt: {lastChecked.toLocaleTimeString()}
          </span>
        )}
      </div>

      <div style={{ display: 'flex', gap: 12 }}>
        {statuses.map(s => (
          <div key={s.id} style={{ flex: 1, padding: 10, background: '#fff', borderRadius: 6, border: '1px solid #e5e7eb' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span style={{ width: 10, height: 10, borderRadius: '999px', background: colors[s.state] }} />
              <span>{s.label}</span>
              {typeof s.latencyMs === 'number' && (
                <span style={{ marginLeft: 'auto', fontSize: 12, color: '#6b7280' }}>{s.latencyMs} ms</span>
              )}
            </div>
            <div style={{ fontSize: 12, color: '#6b7280', minHeight: 18 }}>
              {s.state === 'pending' && 'Prüfe...'}
              {s.state === 'ok' && 'OK'}
              {s.state === 'error' && (s.detail || 'Fehler')}
            </div>
          </div>
        ))}
      </div>

      {metrics && (
        <div style={{ display: 'flex', gap: 12, padding: 10, background: '#fff', borderRadius: 6, border: '1px solid #e5e7eb' }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, color: '#6b7280' }}>Microservice</div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Events: {metrics.totalEvents}</div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Flushes: {metrics.totalBatches}</div>
            <div style={{ fontSize: 12, color: '#6b7280' }}>
              Letzter Flush: {metrics.lastFlushDoc || '-'} ({metrics.lastFlushBatch ?? 0} msgs)
            </div>
            <div style={{ fontSize: 12, color: '#6b7280' }}>
              Zeit: {metrics.lastFlushAt ? new Date(metrics.lastFlushAt).toLocaleTimeString() : '-'}
            </div>
            {metrics.lastError && (
              <div style={{ fontSize: 12, color: '#ef4444' }}>Letzter Fehler: {metrics.lastError}</div>
            )}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, color: '#6b7280' }}>Queues je Dokument</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {(metrics.perDocQueues || []).map(q => (
                <div key={q.docId} style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #e5e7eb', background: '#f9fafb' }}>
                  <div style={{ fontSize: 12, fontWeight: 600 }}>{q.docId}</div>
                  <div style={{ fontSize: 12, color: '#6b7280' }}>Queue: {q.queueDepth}</div>
                </div>
              ))}
              {(!metrics.perDocQueues || metrics.perDocQueues.length === 0) && (
                <div style={{ fontSize: 12, color: '#9ca3af' }}>Keine offenen Queues</div>
              )}
            </div>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 10, background: '#fff', borderRadius: 6, border: '1px dashed #d1d5db' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 80, padding: 8, textAlign: 'center', borderRadius: 6, border: `2px solid ${diagramColor}`, color: '#111827' }}>
            Frontend
          </div>
          <div style={{ fontSize: 14, color: '#6b7280' }}>requests</div>
          <div style={{ width: 80, padding: 8, textAlign: 'center', borderRadius: 6, border: `2px solid ${statuses.find(s => s.id === 'backend')?.state === 'ok' ? '#22c55e' : '#ef4444'}` }}>
            Backend
          </div>
          <div style={{ fontSize: 14, color: '#6b7280' }}>WS</div>
          <div style={{ width: 80, padding: 8, textAlign: 'center', borderRadius: 6, border: `2px solid ${statuses.find(s => s.id === 'realtime')?.state === 'ok' ? '#22c55e' : '#ef4444'}` }}>
            Realtime
          </div>
        </div>
        <div style={{ fontSize: 12, color: '#6b7280' }}>grün = OK, gelb = prüfe, rot = Fehler</div>
      </div>
    </div>
  );
}
