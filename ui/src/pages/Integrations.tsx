import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { integrationsApi } from "../api/integrations";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Plug,
  Database,
  HardDrive,
  GitBranch,
  CheckCircle2,
  XCircle,
  Loader2,
  Trash2,
  FlaskConical,
  Eye,
  EyeOff,
} from "lucide-react";
import type {
  IntegrationProvider,
  CompanyIntegration,
} from "@paperclipai/shared";
import { INTEGRATION_PROVIDER_LABELS } from "@paperclipai/shared";

const PROVIDER_META: Record<
  IntegrationProvider,
  { icon: typeof Database; color: string; description: string }
> = {
  mysql: {
    icon: Database,
    color: "text-blue-500",
    description: "Relational database for structured data storage",
  },
  minio: {
    icon: HardDrive,
    color: "text-amber-500",
    description: "S3-compatible object storage for files and assets",
  },
  gitlab: {
    icon: GitBranch,
    color: "text-orange-500",
    description: "Git repository hosting and CI/CD platform",
  },
};

const PROVIDERS: IntegrationProvider[] = ["mysql", "minio", "gitlab"];

export function Integrations() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [activeProvider, setActiveProvider] = useState<IntegrationProvider>("mysql");

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Integrations" },
    ]);
  }, [setBreadcrumbs, selectedCompany?.name]);

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.integrations(selectedCompanyId!),
    queryFn: () => integrationsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const integrations = data?.integrations ?? [];
  const byProvider = Object.fromEntries(
    integrations.map((i) => [i.provider, i]),
  ) as Partial<Record<IntegrationProvider, CompanyIntegration>>;

  if (!selectedCompany) {
    return (
      <div className="text-sm text-muted-foreground">
        No company selected.
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center gap-2">
        <Plug className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Integrations</h1>
      </div>
      <p className="text-sm text-muted-foreground">
        Connect your company infrastructure. These services are available to all agents in the company.
      </p>

      {/* Provider tabs */}
      <div className="flex gap-1 border-b border-border">
        {PROVIDERS.map((p) => {
          const meta = PROVIDER_META[p];
          const Icon = meta.icon;
          const configured = !!byProvider[p];
          return (
            <button
              key={p}
              onClick={() => setActiveProvider(p)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                activeProvider === p
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon className={`h-4 w-4 ${meta.color}`} />
              {INTEGRATION_PROVIDER_LABELS[p]}
              {configured && (
                <span className="ml-1 h-1.5 w-1.5 rounded-full bg-green-500" />
              )}
            </button>
          );
        })}
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading integrations...
        </div>
      ) : (
        <IntegrationForm
          key={activeProvider}
          companyId={selectedCompanyId!}
          provider={activeProvider}
          existing={byProvider[activeProvider] ?? null}
        />
      )}
    </div>
  );
}

function IntegrationForm({
  companyId,
  provider,
  existing,
}: {
  companyId: string;
  provider: IntegrationProvider;
  existing: CompanyIntegration | null;
}) {
  const queryClient = useQueryClient();
  const meta = PROVIDER_META[provider];
  const Icon = meta.icon;

  const defaults = getDefaults(provider);
  const [config, setConfig] = useState<Record<string, unknown>>(
    existing ? (existing.config as unknown as Record<string, unknown>) : defaults,
  );
  const [showSecrets, setShowSecrets] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const upsertMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      integrationsApi.upsert(companyId, { provider, config: data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.integrations(companyId) });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => integrationsApi.remove(companyId, provider),
    onSuccess: () => {
      setConfig(defaults);
      queryClient.invalidateQueries({ queryKey: queryKeys.integrations(companyId) });
    },
  });

  const testMutation = useMutation({
    mutationFn: () => integrationsApi.test(companyId, provider, config),
    onSuccess: (result) => setTestResult(result),
    onError: (err) =>
      setTestResult({
        ok: false,
        message: err instanceof Error ? err.message : "Test failed",
      }),
  });

  const fields = getFields(provider);
  const sensitiveFields = getSensitiveFields(provider);

  function updateField(key: string, value: unknown) {
    setConfig((prev) => ({ ...prev, [key]: value }));
    setTestResult(null);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-lg bg-muted/50 ${meta.color}`}>
            <Icon className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-sm font-semibold">
              {INTEGRATION_PROVIDER_LABELS[provider]}
            </h2>
            <p className="text-xs text-muted-foreground">{meta.description}</p>
          </div>
        </div>
        {existing && (
          <Badge
            variant="outline"
            className="text-green-600 border-green-600/30"
          >
            Connected
          </Badge>
        )}
      </div>

      <div className="space-y-3 rounded-md border border-border px-4 py-4">
        {fields.map((field) => {
          const isSensitive = sensitiveFields.includes(field.key);
          const value = config[field.key] ?? "";

          if (field.type === "boolean") {
            return (
              <label
                key={field.key}
                className="flex items-center gap-2 text-sm"
              >
                <input
                  type="checkbox"
                  checked={!!config[field.key]}
                  onChange={(e) => updateField(field.key, e.target.checked)}
                  className="h-4 w-4 rounded border-border"
                />
                <span className="text-muted-foreground">{field.label}</span>
              </label>
            );
          }

          return (
            <div key={field.key} className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                {field.label}
              </label>
              <div className="relative">
                <input
                  type={isSensitive && !showSecrets ? "password" : "text"}
                  value={String(value)}
                  onChange={(e) => {
                    const val =
                      field.type === "number"
                        ? Number(e.target.value) || 0
                        : e.target.value;
                    updateField(field.key, val);
                  }}
                  placeholder={field.placeholder}
                  className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none font-mono"
                />
                {isSensitive && (
                  <button
                    type="button"
                    onClick={() => setShowSecrets(!showSecrets)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {showSecrets ? (
                      <EyeOff className="h-3.5 w-3.5" />
                    ) : (
                      <Eye className="h-3.5 w-3.5" />
                    )}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Test result */}
      {testResult && (
        <div
          className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${
            testResult.ok
              ? "border-green-500/30 bg-green-500/5 text-green-700 dark:text-green-400"
              : "border-destructive/30 bg-destructive/5 text-destructive"
          }`}
        >
          {testResult.ok ? (
            <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
          ) : (
            <XCircle className="h-4 w-4 mt-0.5 shrink-0" />
          )}
          <span>{testResult.message}</span>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={() => upsertMutation.mutate(config)}
          disabled={upsertMutation.isPending}
        >
          {upsertMutation.isPending
            ? "Saving..."
            : existing
            ? "Update"
            : "Save"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => testMutation.mutate()}
          disabled={testMutation.isPending}
        >
          {testMutation.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
          ) : (
            <FlaskConical className="h-3.5 w-3.5 mr-1.5" />
          )}
          Test Connection
        </Button>
        {existing && (
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive ml-auto"
            onClick={() => {
              if (window.confirm(`Remove ${INTEGRATION_PROVIDER_LABELS[provider]} integration?`)) {
                deleteMutation.mutate();
              }
            }}
            disabled={deleteMutation.isPending}
          >
            <Trash2 className="h-3.5 w-3.5 mr-1.5" />
            Remove
          </Button>
        )}
      </div>

      {upsertMutation.isSuccess && (
        <p className="text-xs text-muted-foreground">Saved successfully.</p>
      )}
      {upsertMutation.isError && (
        <p className="text-xs text-destructive">
          {upsertMutation.error instanceof Error
            ? upsertMutation.error.message
            : "Failed to save"}
        </p>
      )}
    </div>
  );
}

interface FieldDef {
  key: string;
  label: string;
  type: "text" | "number" | "boolean";
  placeholder?: string;
}

function getFields(provider: IntegrationProvider): FieldDef[] {
  switch (provider) {
    case "mysql":
      return [
        { key: "host", label: "Host", type: "text", placeholder: "127.0.0.1" },
        { key: "port", label: "Port", type: "number", placeholder: "3306" },
        { key: "database", label: "Database", type: "text", placeholder: "paperclip" },
        { key: "username", label: "Username", type: "text", placeholder: "root" },
        { key: "password", label: "Password", type: "text", placeholder: "••••••••" },
        { key: "ssl", label: "Enable SSL", type: "boolean" },
      ];
    case "minio":
      return [
        { key: "endpoint", label: "Endpoint", type: "text", placeholder: "minio.local" },
        { key: "port", label: "Port", type: "number", placeholder: "9000" },
        { key: "accessKey", label: "Access Key", type: "text", placeholder: "minioadmin" },
        { key: "secretKey", label: "Secret Key", type: "text", placeholder: "••••••••" },
        { key: "bucket", label: "Bucket", type: "text", placeholder: "paperclip-assets" },
        { key: "region", label: "Region", type: "text", placeholder: "us-east-1" },
        { key: "useSSL", label: "Use SSL", type: "boolean" },
      ];
    case "gitlab":
      return [
        { key: "url", label: "GitLab URL", type: "text", placeholder: "https://gitlab.company.com" },
        { key: "token", label: "Access Token", type: "text", placeholder: "glpat-xxxxxxxxxxxx" },
        { key: "group", label: "Group / Namespace", type: "text", placeholder: "my-org" },
      ];
  }
}

function getSensitiveFields(provider: IntegrationProvider): string[] {
  switch (provider) {
    case "mysql":
      return ["password"];
    case "minio":
      return ["secretKey"];
    case "gitlab":
      return ["token"];
  }
}

function getDefaults(provider: IntegrationProvider): Record<string, unknown> {
  switch (provider) {
    case "mysql":
      return { host: "", port: 3306, database: "", username: "", password: "", ssl: false };
    case "minio":
      return { endpoint: "", port: 9000, accessKey: "", secretKey: "", bucket: "", region: "us-east-1", useSSL: false };
    case "gitlab":
      return { url: "", token: "", group: "" };
  }
}
