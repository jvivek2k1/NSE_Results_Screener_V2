import { useEffect, useRef, useState } from 'react';

// Subscribes to the backend SSE stream and invokes handlers for each event.
export function useLive({ onResult, onAlert, onScan, onConnect } = {}) {
  const [connected, setConnected] = useState(false);
  const [dbStatus, setDbStatus] = useState(null);
  const [aiStatus, setAiStatus] = useState(null);
  const handlers = useRef({ onResult, onAlert, onScan, onConnect });
  handlers.current = { onResult, onAlert, onScan, onConnect };

  useEffect(() => {
    const es = new EventSource('/api/live');

    es.addEventListener('connected', (e) => {
      setConnected(true);
      try {
        const data = JSON.parse(e.data);
        if (data?.dbStatus) setDbStatus(data.dbStatus);
        if (data?.aiHealth) setAiStatus(data.aiHealth);
      } catch {
        /* ignore */
      }
      // The stream connects as soon as the API is reachable. Use this to (re)load
      // all dashboard data, covering the case where the very first on-mount loads
      // failed because the backend was still starting up.
      handlers.current.onConnect?.();
    });
    es.addEventListener('db-status', (e) => {
      try {
        setDbStatus(JSON.parse(e.data));
      } catch {
        /* ignore */
      }
    });
    es.addEventListener('ai-health', (e) => {
      try {
        setAiStatus(JSON.parse(e.data));
      } catch {
        /* ignore */
      }
    });
    es.addEventListener('result', (e) => {
      try {
        handlers.current.onResult?.(JSON.parse(e.data));
      } catch {
        /* ignore */
      }
    });
    es.addEventListener('alert', (e) => {
      try {
        handlers.current.onAlert?.(JSON.parse(e.data));
      } catch {
        /* ignore */
      }
    });
    es.addEventListener('scan', (e) => {
      try {
        handlers.current.onScan?.(JSON.parse(e.data));
      } catch {
        /* ignore */
      }
    });
    es.onerror = () => setConnected(false);

    return () => es.close();
  }, []);

  return { connected, dbStatus, aiStatus };
}
