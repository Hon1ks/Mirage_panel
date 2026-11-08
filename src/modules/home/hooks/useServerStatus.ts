import { useEffect, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { ServerStatus } from '@/shared/types';

const POLL_INTERVAL_MS = 30_000;

/**
 * Used by HomeScreen for the «Сервер» widget: the server reading from
 * `GET /api/home/server`, refreshed every 30 s while the tab is visible and only
 * while the widget is on (`enabled`). Null until the first answer; a failed
 * refresh keeps the last numbers.
 */
export function useServerStatus(enabled: boolean): ServerStatus | null {
  // The latest reading; kept on a failed refresh so the dials do not blink empty.
  const [status, setStatus] = useState<ServerStatus | null>(null);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    const load = async () => {
      try {
        const body = await readApiJson<{ data: ServerStatus }>(await api.home.server());
        if (!cancelled) setStatus(body.data);
      } catch {
        // Keep the previous reading.
      }
    };
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled]);

  return status;
}
