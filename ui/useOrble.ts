// Data for the Orble page: one overview fetch, refreshed by the server's
// "orble-changed" signal, a slow timer (boxes also change on their own: Orble
// suspends idle boxes), and after every action.
import { useCallback, useEffect, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { DashboardRpc, OverviewDto } from "../src/dashboard.ts";

export const ORBLE_CHANGED = "orble-changed";
const REFRESH_MS = 20_000;

export function useOrbleOverview() {
  const rpc = useRpc<DashboardRpc>();
  const [data, setData] = useState<OverviewDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refetch = useCallback(() => {
    setLoading(true);
    rpc.call("orble_overview", null).then(
      (o) => {
        setData(o);
        setError(null);
        setLoading(false);
      },
      (e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      },
    );
  }, [rpc]);

  useEffect(() => {
    refetch();
    const t = setInterval(refetch, REFRESH_MS);
    return () => clearInterval(t);
  }, [refetch]);
  useRealtime(ORBLE_CHANGED, refetch);

  return { rpc, data, error, loading, refetch };
}

/** Running-box count for the sidebar badge. */
export function useOrbleRunning(): number | null {
  const rpc = useRpc<DashboardRpc>();
  const [running, setRunning] = useState<number | null>(null);
  const refetch = useCallback(() => {
    rpc.call("orble_summary", null).then(
      (s) => setRunning(s.running),
      () => setRunning(null),
    );
  }, [rpc]);
  useEffect(() => {
    refetch();
    const t = setInterval(refetch, 60_000);
    return () => clearInterval(t);
  }, [refetch]);
  useRealtime(ORBLE_CHANGED, refetch);
  return running;
}

/** Names of the plugin's projects (with at least one repo), for project pickers. */
export function useProjectNames(): string[] {
  const rpc = useRpc<DashboardRpc>();
  const [names, setNames] = useState<string[]>([]);
  const refetch = useCallback(() => {
    rpc.call("projects_list", null).then(
      (r) => setNames(r.projects.filter((p) => p.repos.length > 0).map((p) => p.name)),
      () => setNames([]),
    );
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime(ORBLE_CHANGED, refetch);
  return names;
}
