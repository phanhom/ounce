import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "@/context/CompanyContext";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/queryKeys";
import { workersApi, type WorkerInfo, type DiscoveredWorker } from "@/api/workers";
import {
  Loader2,
  Wifi,
  WifiOff,
  Trash2,
  Search,
  Plus,
  Server,
  Shield,
} from "lucide-react";

export function Workers() {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();

  const [showDiscover, setShowDiscover] = useState(false);
  const [showManualAdd, setShowManualAdd] = useState(false);
  const [manualHost, setManualHost] = useState("");
  const [manualPort, setManualPort] = useState("19820");
  const [discovered, setDiscovered] = useState<DiscoveredWorker[]>([]);
  const [scanStats, setScanStats] = useState<{ scanned: number; total: number; truncated: boolean } | null>(null);
  const [pairingHost, setPairingHost] = useState<string | null>(null);
  const [pairName, setPairName] = useState("");

  const workersQuery = useQuery({
    queryKey: queryKeys.workers(selectedCompanyId!),
    queryFn: () => workersApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 10_000,
  });

  const discoverMut = useMutation({
    mutationFn: () => workersApi.discover(selectedCompanyId!, { limit: 10 }),
    onSuccess: (data) => {
      setDiscovered(data.discovered);
      setScanStats({ scanned: data.scanned, total: data.total, truncated: data.truncated });
    },
  });

  const probeMut = useMutation({
    mutationFn: (body: { host: string; port?: number }) =>
      workersApi.probe(selectedCompanyId!, body),
    onSuccess: (data) => {
      setDiscovered((prev) => {
        const exists = prev.some((w) => w.host === data.worker.host && w.port === data.worker.port);
        return exists ? prev : [...prev, data.worker];
      });
      setManualHost("");
    },
  });

  const pairMut = useMutation({
    mutationFn: (body: { host: string; port?: number; fingerprint: string; name?: string }) =>
      workersApi.pair(selectedCompanyId!, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workers(selectedCompanyId!) });
      setDiscovered((prev) => prev.filter((w) => w.host !== pairingHost));
      setPairingHost(null);
      setPairName("");
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => workersApi.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workers(selectedCompanyId!) });
    },
  });

  if (!selectedCompanyId) return null;

  const workers: WorkerInfo[] = workersQuery.data?.workers ?? [];

  return (
    <div className="mx-auto max-w-4xl py-6 px-4">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold">Remote Workers</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage remote machines running the Paperclip worker daemon. Workers execute agent tasks on remote hardware.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => { setShowDiscover(true); discoverMut.mutate(); }}
            disabled={discoverMut.isPending}
          >
            {discoverMut.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <Search className="h-4 w-4 mr-1.5" />}
            Discover LAN
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowManualAdd(true)}>
            <Plus className="h-4 w-4 mr-1.5" />
            Add Manually
          </Button>
        </div>
      </div>

      {/* Discovery panel */}
      {showDiscover && (
        <div className="mb-6 rounded-lg border border-border bg-card p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium">LAN Discovery</h3>
            <Button variant="ghost" size="sm" onClick={() => { setShowDiscover(false); setDiscovered([]); setScanStats(null); }}>
              Close
            </Button>
          </div>

          {discoverMut.isPending && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
              <Loader2 className="h-4 w-4 animate-spin" />
              Scanning local network for worker beacons...
            </div>
          )}

          {discoverMut.isError && (
            <p className="text-sm text-destructive">Scan failed: {(discoverMut.error as Error).message}</p>
          )}

          {scanStats && !discoverMut.isPending && (
            <p className="text-xs text-muted-foreground mb-3">
              Scanned {scanStats.scanned.toLocaleString()} of {scanStats.total.toLocaleString()} addresses
              {scanStats.truncated && " (results capped at 10)"}
              {" · "}{discovered.length} worker{discovered.length !== 1 ? "s" : ""} found
            </p>
          )}

          {discovered.length > 0 && (
            <div className="space-y-2">
              {discovered.map((w) => {
                const alreadyPaired = workers.some((pw) => pw.name?.includes(w.hostname));
                return (
                  <div key={`${w.host}:${w.port}`} className="flex items-center justify-between rounded-md border border-border px-3 py-2.5">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <Server className="h-4 w-4 text-muted-foreground shrink-0" />
                        <span className="text-sm font-medium">{w.hostname}</span>
                        <span className="text-xs text-muted-foreground">{w.host}:{w.port}</span>
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                        <span>{w.platform} {w.arch}</span>
                        <span>Node {w.nodeVersion}</span>
                        <span>{w.capabilities.filter((c) => !["openclaw_gateway","process","http"].includes(c)).join(", ") || "no local adapters"}</span>
                      </div>
                      <div className="flex items-center gap-1.5 mt-1">
                        <Shield className="h-3 w-3 text-muted-foreground" />
                        <code className="text-[10px] text-muted-foreground font-mono">{w.fingerprint}</code>
                      </div>
                    </div>
                    <div className="shrink-0 ml-3">
                      {alreadyPaired ? (
                        <span className="text-xs text-muted-foreground">Already paired</span>
                      ) : pairingHost === w.host ? (
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            placeholder="Worker name"
                            value={pairName}
                            onChange={(e) => setPairName(e.target.value)}
                            className="w-32 rounded-md border border-border bg-background px-2 py-1 text-xs"
                          />
                          <Button
                            size="sm"
                            onClick={() => pairMut.mutate({ host: w.host, port: w.port, fingerprint: w.fingerprint, name: pairName || undefined })}
                            disabled={pairMut.isPending}
                          >
                            {pairMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Confirm"}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setPairingHost(null)}>Cancel</Button>
                        </div>
                      ) : (
                        <Button size="sm" variant="outline" onClick={() => { setPairingHost(w.host); setPairName(w.hostname); }}>
                          Pair
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {!discoverMut.isPending && discovered.length === 0 && scanStats && (
            <p className="text-sm text-muted-foreground py-2">No workers found on the local network. Make sure the worker daemon is running on target machines.</p>
          )}
        </div>
      )}

      {/* Manual add panel */}
      {showManualAdd && (
        <div className="mb-6 rounded-lg border border-border bg-card p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium">Add Worker Manually</h3>
            <Button variant="ghost" size="sm" onClick={() => setShowManualAdd(false)}>Close</Button>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="IP or hostname"
              value={manualHost}
              onChange={(e) => setManualHost(e.target.value)}
              className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm"
            />
            <input
              type="text"
              placeholder="Port"
              value={manualPort}
              onChange={(e) => setManualPort(e.target.value)}
              className="w-20 rounded-md border border-border bg-background px-3 py-1.5 text-sm"
            />
            <Button
              size="sm"
              onClick={() => probeMut.mutate({ host: manualHost, port: parseInt(manualPort, 10) || 19820 })}
              disabled={probeMut.isPending || !manualHost.trim()}
            >
              {probeMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Probe"}
            </Button>
          </div>
          {probeMut.isError && (
            <p className="text-sm text-destructive mt-2">
              Probe failed: {(probeMut.error as Error).message}
            </p>
          )}
          {probeMut.isSuccess && (
            <p className="text-sm text-green-600 mt-2">
              Worker found! It should appear in the discovery list above.
            </p>
          )}
        </div>
      )}

      {/* Paired workers list */}
      {workersQuery.isLoading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )}

      {!workersQuery.isLoading && workers.length === 0 && (
        <div className="rounded-lg border border-dashed border-border p-8 text-center">
          <Server className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
          <h3 className="text-sm font-medium">No workers paired</h3>
          <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
            Deploy the worker daemon on remote machines, then use "Discover LAN" or "Add Manually" to pair them.
          </p>
        </div>
      )}

      {workers.length > 0 && (
        <div className="space-y-2">
          {workers.map((w) => (
            <div key={w.id} className="rounded-lg border border-border bg-card px-4 py-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 min-w-0">
                  {w.status === "online" ? (
                    <Wifi className="h-4 w-4 text-green-500 shrink-0" />
                  ) : (
                    <WifiOff className="h-4 w-4 text-muted-foreground shrink-0" />
                  )}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">{w.name}</span>
                      <span className={`text-[10px] font-medium uppercase px-1.5 py-0.5 rounded ${
                        w.status === "online"
                          ? "bg-green-500/10 text-green-600"
                          : "bg-muted text-muted-foreground"
                      }`}>
                        {w.status}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
                      {w.platform && <span>{w.platform} {w.arch}</span>}
                      {w.nodeVersion && <span>Node {w.nodeVersion}</span>}
                      <span>
                        {w.capabilities.filter((c) => !["openclaw_gateway","process","http"].includes(c)).join(", ") || "–"}
                      </span>
                      {w.status === "online" && (
                        <span>
                          {w.activeRuns}/{w.maxConcurrency} runs
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {w.lastSeenAt && (
                    <span className="text-[10px] text-muted-foreground">
                      Last seen {new Date(w.lastSeenAt).toLocaleString()}
                    </span>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (confirm(`Delete worker "${w.name}"? This will disconnect it.`)) {
                        deleteMut.mutate(w.id);
                      }
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {pairMut.isError && (
        <div className="mt-4 rounded-lg border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
          Pairing failed: {(pairMut.error as Error).message}
        </div>
      )}
    </div>
  );
}
