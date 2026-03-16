import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { useNavigate } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { agentsApi, type OrgNode } from "../api/agents";
import { workersApi, type WorkerInfo, type DiscoveredWorker, type PairByCodeResult } from "../api/workers";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { agentUrl } from "../lib/utils";
import { EmptyState } from "../components/EmptyState";
import { AgentIcon } from "../components/AgentIconPicker";
import { Button } from "../components/ui/button";
import {
  Network,
  Server,
  Wifi,
  WifiOff,
  Trash2,
  Search,
  Plus,
  Shield,
  Loader2,
  ChevronRight,
} from "lucide-react";
import { AGENT_ROLE_LABELS, type Agent } from "@paperclipai/shared";

// Layout constants
const CARD_W = 200;
const CARD_H = 100;
const GAP_X = 32;
const GAP_Y = 80;
const PADDING = 60;

// ── Tree layout types ───────────────────────────────────────────────────

interface LayoutNode {
  id: string;
  name: string;
  role: string;
  status: string;
  x: number;
  y: number;
  children: LayoutNode[];
}

// ── Layout algorithm ────────────────────────────────────────────────────

function subtreeWidth(node: OrgNode): number {
  if (node.reports.length === 0) return CARD_W;
  const childrenW = node.reports.reduce((sum, c) => sum + subtreeWidth(c), 0);
  const gaps = (node.reports.length - 1) * GAP_X;
  return Math.max(CARD_W, childrenW + gaps);
}

function layoutTree(node: OrgNode, x: number, y: number): LayoutNode {
  const totalW = subtreeWidth(node);
  const layoutChildren: LayoutNode[] = [];

  if (node.reports.length > 0) {
    const childrenW = node.reports.reduce((sum, c) => sum + subtreeWidth(c), 0);
    const gaps = (node.reports.length - 1) * GAP_X;
    let cx = x + (totalW - childrenW - gaps) / 2;

    for (const child of node.reports) {
      const cw = subtreeWidth(child);
      layoutChildren.push(layoutTree(child, cx, y + CARD_H + GAP_Y));
      cx += cw + GAP_X;
    }
  }

  return {
    id: node.id,
    name: node.name,
    role: node.role,
    status: node.status,
    x: x + (totalW - CARD_W) / 2,
    y,
    children: layoutChildren,
  };
}

function layoutForest(roots: OrgNode[]): LayoutNode[] {
  if (roots.length === 0) return [];

  let x = PADDING;
  const y = PADDING;

  const result: LayoutNode[] = [];
  for (const root of roots) {
    result.push(layoutTree(root, x, y));
    x += subtreeWidth(root) + GAP_X;
  }
  return result;
}

function flattenLayout(nodes: LayoutNode[]): LayoutNode[] {
  const result: LayoutNode[] = [];
  function walk(n: LayoutNode) {
    result.push(n);
    n.children.forEach(walk);
  }
  nodes.forEach(walk);
  return result;
}

function collectEdges(nodes: LayoutNode[]): Array<{ parent: LayoutNode; child: LayoutNode }> {
  const edges: Array<{ parent: LayoutNode; child: LayoutNode }> = [];
  function walk(n: LayoutNode) {
    for (const c of n.children) {
      edges.push({ parent: n, child: c });
      walk(c);
    }
  }
  nodes.forEach(walk);
  return edges;
}

// ── Status dot colors (raw hex for SVG) ─────────────────────────────────

const adapterLabels: Record<string, string> = {
  claude_local: "Claude",
  codex_local: "Codex",
  gemini_local: "Gemini",
  opencode_local: "OpenCode",
  cursor: "Cursor",
  openclaw_gateway: "OpenClaw Gateway",
  process: "Process",
  http: "HTTP",
};

const statusDotColor: Record<string, string> = {
  running: "#22d3ee",
  active: "#4ade80",
  paused: "#facc15",
  idle: "#facc15",
  error: "#f87171",
  terminated: "#a3a3a3",
};
const defaultDotColor = "#a3a3a3";

const LOCAL_ADAPTERS_FILTER = ["openclaw_gateway", "process", "http"];

// ── Worker Panel ────────────────────────────────────────────────────────

function WorkerPanel({
  companyId,
  workers,
  isLoading,
}: {
  companyId: string;
  workers: WorkerInfo[];
  isLoading: boolean;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [pairCode, setPairCode] = useState("");
  const [pairResult, setPairResult] = useState<PairByCodeResult | null>(null);
  const [agentName, setAgentName] = useState("");

  const pairByCodeMut = useMutation({
    mutationFn: (code: string) => workersApi.pairByCode(companyId, { code }),
    onSuccess: (data) => {
      setPairResult(data);
      setAgentName(`${data.adapter.label} (${data.hostname})`);
      queryClient.invalidateQueries({ queryKey: queryKeys.workers(companyId) });
    },
  });

  const createAgentMut = useMutation({
    mutationFn: (data: { name: string; adapterType: string; workerId: string }) =>
      agentsApi.create(companyId, {
        name: data.name,
        adapterType: data.adapterType,
        adapterConfig: { worker: { workerId: data.workerId } },
      }),
    onSuccess: (agent) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
      setPairResult(null);
      setPairCode("");
      setAgentName("");
      navigate(agentUrl(agent));
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => workersApi.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workers(companyId) });
    },
  });

  return (
    <div className="flex flex-col h-full">
      {/* Pair by code — primary flow */}
      <div className="px-3 pt-2 pb-2 space-y-2">
        <p className="text-[10px] font-medium uppercase text-muted-foreground">Pair by code</p>
        <div className="flex items-center gap-1">
          <input
            type="text"
            placeholder="PCLIP-XXXXXXXXXX"
            value={pairCode}
            onChange={(e) => setPairCode(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && pairCode.trim()) pairByCodeMut.mutate(pairCode.trim()); }}
            className="flex-1 rounded border border-border bg-background px-2 py-1 text-[11px] font-mono tracking-wider"
          />
          <Button
            size="sm"
            className="h-7 text-[10px] px-3"
            onClick={() => pairByCodeMut.mutate(pairCode.trim())}
            disabled={pairByCodeMut.isPending || !pairCode.trim()}
          >
            {pairByCodeMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Connect"}
          </Button>
        </div>
        <p className="text-[9px] text-muted-foreground">
          Enter the pairing code shown on the worker terminal.
        </p>

        {pairByCodeMut.isError && (
          <p className="text-[10px] text-destructive">{(pairByCodeMut.error as Error).message}</p>
        )}

        {/* Pair success — create agent */}
        {pairResult && (
          <div className="rounded-md border border-green-500/30 bg-green-500/5 p-2 space-y-1.5">
            <div className="flex items-center gap-1.5">
              <Wifi className="h-3 w-3 text-green-500 shrink-0" />
              <span className="text-[11px] font-medium">{pairResult.adapter.label}</span>
              <span className="text-[10px] text-muted-foreground">({pairResult.adapter.version})</span>
            </div>
            <p className="text-[10px] text-muted-foreground">
              on {pairResult.hostname}
            </p>
            <div className="flex items-center gap-1 mt-1">
              <input
                type="text"
                placeholder="Agent name"
                value={agentName}
                onChange={(e) => setAgentName(e.target.value)}
                className="flex-1 rounded border border-border bg-background px-1.5 py-0.5 text-[11px]"
              />
              <Button
                size="sm"
                className="h-6 text-[10px] px-2"
                onClick={() => {
                  if (!pairResult.worker) return;
                  createAgentMut.mutate({
                    name: agentName,
                    adapterType: pairResult.adapter.type,
                    workerId: pairResult.worker.id,
                  });
                }}
                disabled={createAgentMut.isPending || !agentName.trim() || !pairResult.worker}
              >
                {createAgentMut.isPending ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : "Create Agent"}
              </Button>
              <Button size="sm" variant="ghost" className="h-6 text-[10px] px-1" onClick={() => { setPairResult(null); setPairCode(""); }}>
                X
              </Button>
            </div>
            {!pairResult.worker && (
              <p className="text-[10px] text-yellow-600">Worker is connecting... Refresh in a moment.</p>
            )}
            {createAgentMut.isError && (
              <p className="text-[10px] text-destructive">{(createAgentMut.error as Error).message}</p>
            )}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        {/* Paired workers */}
        {isLoading && (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        )}

        {!isLoading && workers.length === 0 && (
          <div className="text-center py-4">
            <Server className="h-5 w-5 text-muted-foreground mx-auto mb-1.5" />
            <p className="text-[11px] text-muted-foreground">No workers paired</p>
          </div>
        )}

        {workers.map((w) => (
          <div key={w.id} className="rounded-md border border-border bg-card p-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 min-w-0">
                {w.status === "online" ? (
                  <Wifi className="h-3 w-3 text-green-500 shrink-0" />
                ) : (
                  <WifiOff className="h-3 w-3 text-muted-foreground shrink-0" />
                )}
                <span className="text-[11px] font-medium truncate">{w.name}</span>
                <span className={`text-[9px] font-medium uppercase px-1 py-0.5 rounded ${
                  w.status === "online" ? "bg-green-500/10 text-green-600" : "bg-muted text-muted-foreground"
                }`}>
                  {w.status}
                </span>
              </div>
              <button
                className="text-muted-foreground hover:text-destructive p-0.5"
                onClick={() => { if (confirm(`Delete "${w.name}"?`)) deleteMut.mutate(w.id); }}
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
            <div className="text-[10px] text-muted-foreground mt-0.5">
              {w.capabilities.filter((c) => !LOCAL_ADAPTERS_FILTER.includes(c)).join(", ") || "–"}
              {w.status === "online" && ` · ${w.activeRuns}/${w.maxConcurrency} runs`}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────

export function OrgChart() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const [workerPanelOpen, setWorkerPanelOpen] = useState(false);

  const { data: orgTree, isLoading } = useQuery({
    queryKey: queryKeys.org(selectedCompanyId!),
    queryFn: () => agentsApi.org(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: workersData, isLoading: workersLoading } = useQuery({
    queryKey: queryKeys.workers(selectedCompanyId!),
    queryFn: () => workersApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 10_000,
  });

  const workers: WorkerInfo[] = workersData?.workers ?? [];

  const agentMap = useMemo(() => {
    const m = new Map<string, Agent>();
    for (const a of agents ?? []) m.set(a.id, a);
    return m;
  }, [agents]);

  const workerMap = useMemo(() => {
    const m = new Map<string, WorkerInfo>();
    for (const w of workers) m.set(w.id, w);
    return m;
  }, [workers]);

  const agentWorkerInfo = useMemo(() => {
    const m = new Map<string, { name: string; online: boolean }>();
    for (const [agentId, agent] of agentMap) {
      const cfg = agent.adapterConfig as Record<string, unknown> | undefined;
      const workerCfg = cfg?.worker as { workerId?: string } | undefined;
      if (workerCfg?.workerId) {
        const w = workerMap.get(workerCfg.workerId);
        if (w) {
          m.set(agentId, { name: w.name, online: w.status === "online" });
        }
      }
    }
    return m;
  }, [agentMap, workerMap]);

  useEffect(() => {
    setBreadcrumbs([{ label: "Org Chart" }]);
  }, [setBreadcrumbs]);

  const layout = useMemo(() => layoutForest(orgTree ?? []), [orgTree]);
  const allNodes = useMemo(() => flattenLayout(layout), [layout]);
  const edges = useMemo(() => collectEdges(layout), [layout]);

  const bounds = useMemo(() => {
    if (allNodes.length === 0) return { width: 800, height: 600 };
    let maxX = 0, maxY = 0;
    for (const n of allNodes) {
      maxX = Math.max(maxX, n.x + CARD_W);
      maxY = Math.max(maxY, n.y + CARD_H);
    }
    return { width: maxX + PADDING, height: maxY + PADDING };
  }, [allNodes]);

  const containerRef = useRef<HTMLDivElement>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });

  const hasInitialized = useRef(false);
  useEffect(() => {
    if (hasInitialized.current || allNodes.length === 0 || !containerRef.current) return;
    hasInitialized.current = true;

    const container = containerRef.current;
    const containerW = container.clientWidth;
    const containerH = container.clientHeight;

    const scaleX = (containerW - 40) / bounds.width;
    const scaleY = (containerH - 40) / bounds.height;
    const fitZoom = Math.min(scaleX, scaleY, 1);

    const chartW = bounds.width * fitZoom;
    const chartH = bounds.height * fitZoom;

    setZoom(fitZoom);
    setPan({
      x: (containerW - chartW) / 2,
      y: (containerH - chartH) / 2,
    });
  }, [allNodes, bounds]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("[data-org-card]")) return;
    setDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
  }, [pan]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    setPan({ x: dragStart.current.panX + dx, y: dragStart.current.panY + dy });
  }, [dragging]);

  const handleMouseUp = useCallback(() => {
    setDragging(false);
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const newZoom = Math.min(Math.max(zoom * factor, 0.2), 2);

    const scale = newZoom / zoom;
    setPan({
      x: mouseX - scale * (mouseX - pan.x),
      y: mouseY - scale * (mouseY - pan.y),
    });
    setZoom(newZoom);
  }, [zoom, pan]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Network} message="Select a company to view the org chart." />;
  }

  const isEmpty = !isLoading && orgTree && orgTree.length === 0;

  return (
    <div className="-m-4 md:-m-6 flex h-[calc(100vh-3rem)] relative bg-muted/20">
      {/* Org chart canvas */}
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden relative"
        style={{ cursor: isEmpty || isLoading ? "default" : dragging ? "grabbing" : "grab" }}
        onMouseDown={isEmpty || isLoading ? undefined : handleMouseDown}
        onMouseMove={isEmpty || isLoading ? undefined : handleMouseMove}
        onMouseUp={isEmpty || isLoading ? undefined : handleMouseUp}
        onMouseLeave={isEmpty || isLoading ? undefined : handleMouseUp}
        onWheel={isEmpty || isLoading ? undefined : handleWheel}
      >
        {/* Zoom controls — only when chart has content */}
        {!isEmpty && !isLoading && (
          <div className="absolute top-3 right-3 z-10 flex flex-col gap-1">
            <button
              className="w-7 h-7 flex items-center justify-center bg-background border border-border rounded text-sm hover:bg-accent transition-colors"
              onClick={() => {
                const newZoom = Math.min(zoom * 1.2, 2);
                const container = containerRef.current;
                if (container) {
                  const cx = container.clientWidth / 2;
                  const cy = container.clientHeight / 2;
                  const scale = newZoom / zoom;
                  setPan({ x: cx - scale * (cx - pan.x), y: cy - scale * (cy - pan.y) });
                }
                setZoom(newZoom);
              }}
              aria-label="Zoom in"
            >
              +
            </button>
            <button
              className="w-7 h-7 flex items-center justify-center bg-background border border-border rounded text-sm hover:bg-accent transition-colors"
              onClick={() => {
                const newZoom = Math.max(zoom * 0.8, 0.2);
                const container = containerRef.current;
                if (container) {
                  const cx = container.clientWidth / 2;
                  const cy = container.clientHeight / 2;
                  const scale = newZoom / zoom;
                  setPan({ x: cx - scale * (cx - pan.x), y: cy - scale * (cy - pan.y) });
                }
                setZoom(newZoom);
              }}
              aria-label="Zoom out"
            >
              &minus;
            </button>
            <button
              className="w-7 h-7 flex items-center justify-center bg-background border border-border rounded text-[10px] hover:bg-accent transition-colors"
              onClick={() => {
                if (!containerRef.current) return;
                const cW = containerRef.current.clientWidth;
                const cH = containerRef.current.clientHeight;
                const scaleX = (cW - 40) / bounds.width;
                const scaleY = (cH - 40) / bounds.height;
                const fitZoom = Math.min(scaleX, scaleY, 1);
                const chartW = bounds.width * fitZoom;
                const chartH = bounds.height * fitZoom;
                setZoom(fitZoom);
                setPan({ x: (cW - chartW) / 2, y: (cH - chartH) / 2 });
              }}
              title="Fit to screen"
              aria-label="Fit chart to screen"
            >
              Fit
            </button>
          </div>
        )}

        {/* Loading state */}
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {/* Empty state */}
        {isEmpty && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 pointer-events-none">
            <Network className="h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No agents yet</p>
            <p className="text-xs text-muted-foreground/60">Create agents to see the org chart here</p>
          </div>
        )}

        {/* SVG layer for edges */}
        {!isEmpty && !isLoading && (
          <svg className="absolute inset-0 pointer-events-none" style={{ width: "100%", height: "100%" }}>
            <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
              {edges.map(({ parent, child }) => {
                const x1 = parent.x + CARD_W / 2;
                const y1 = parent.y + CARD_H;
                const x2 = child.x + CARD_W / 2;
                const y2 = child.y;
                const midY = (y1 + y2) / 2;

                return (
                  <path
                    key={`${parent.id}-${child.id}`}
                    d={`M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}`}
                    fill="none"
                    stroke="var(--border)"
                    strokeWidth={1.5}
                  />
                );
              })}
            </g>
          </svg>
        )}

        {/* Card layer */}
        {!isEmpty && !isLoading && (
          <div
            className="absolute inset-0"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: "0 0",
            }}
          >
            {allNodes.map((node) => {
              const agent = agentMap.get(node.id);
              const dotColor = statusDotColor[node.status] ?? defaultDotColor;
              const wInfo = agentWorkerInfo.get(node.id);

              return (
                <div
                  key={node.id}
                  data-org-card
                  className="absolute bg-card border border-border rounded-lg shadow-sm hover:shadow-md hover:border-foreground/20 transition-[box-shadow,border-color] duration-150 cursor-pointer select-none"
                  style={{
                    left: node.x,
                    top: node.y,
                    width: CARD_W,
                    minHeight: CARD_H,
                  }}
                  onClick={() => navigate(agent ? agentUrl(agent) : `/agents/${node.id}`)}
                >
                  <div className="flex items-center px-4 py-3 gap-3">
                    <div className="relative shrink-0">
                      <div className="w-9 h-9 rounded-full bg-muted flex items-center justify-center">
                        <AgentIcon icon={agent?.icon} className="h-4.5 w-4.5 text-foreground/70" />
                      </div>
                      <span
                        className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-card"
                        style={{ backgroundColor: dotColor }}
                      />
                    </div>
                    <div className="flex flex-col items-start min-w-0 flex-1">
                      <span className="text-sm font-semibold text-foreground leading-tight">
                        {node.name}
                      </span>
                      <span className="text-[11px] text-muted-foreground leading-tight mt-0.5">
                        {agent?.title ?? roleLabel(node.role)}
                      </span>
                      {agent && (
                        <span className="text-[10px] text-muted-foreground/60 font-mono leading-tight mt-1">
                          {adapterLabels[agent.adapterType] ?? agent.adapterType}
                        </span>
                      )}
                      {/* Worker tag */}
                      <span className={`text-[9px] font-mono leading-tight mt-0.5 flex items-center gap-1 ${wInfo ? "text-cyan-400/80" : "text-muted-foreground/40"}`}>
                        {wInfo ? (
                          <>
                            <span className={`inline-block h-1.5 w-1.5 rounded-full ${wInfo.online ? "bg-green-500" : "bg-muted-foreground/40"}`} />
                            {wInfo.name}
                          </>
                        ) : (
                          "Local"
                        )}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Edge tab / Drawer handle */}
      <div
        className="absolute top-1/2 -translate-y-1/2 z-20 flex items-center justify-center transition-[right] duration-200 ease-in-out"
        style={{ right: workerPanelOpen ? "18rem" : "0" }}
      >
        <button
          onClick={() => setWorkerPanelOpen((v) => !v)}
          className="flex h-12 w-5 items-center justify-center rounded-l-md border border-r-0 border-border bg-background shadow-sm hover:bg-accent hover:text-foreground text-muted-foreground transition-colors"
          title={workerPanelOpen ? "Hide workers" : "Show workers"}
        >
          {workerPanelOpen ? (
            <ChevronRight className="h-3.5 w-3.5" />
          ) : (
            <Server className="h-3.5 w-3.5" />
          )}
        </button>
      </div>

      {/* Worker panel */}
      {workerPanelOpen && (
        <div className="w-72 border-l border-border bg-background shrink-0 flex flex-col z-10">
          <div className="flex-1 min-h-0">
            <WorkerPanel companyId={selectedCompanyId} workers={workers} isLoading={workersLoading} />
          </div>
        </div>
      )}
    </div>
  );
}

const roleLabels = AGENT_ROLE_LABELS as Record<string, string>;

function roleLabel(role: string): string {
  return roleLabels[role] ?? role;
}
