import { api } from "./client";
import type { CompanyIntegration, IntegrationProvider } from "@paperclipai/shared";

interface IntegrationsListResponse {
  integrations: CompanyIntegration[];
}

interface IntegrationResponse {
  integration: CompanyIntegration;
}

interface TestResult {
  ok: boolean;
  message: string;
  error?: string;
}

export const integrationsApi = {
  list: (companyId: string) =>
    api.get<IntegrationsListResponse>(`/companies/${companyId}/integrations`),

  get: (companyId: string, provider: IntegrationProvider) =>
    api.get<IntegrationResponse>(`/companies/${companyId}/integrations/${provider}`),

  upsert: (
    companyId: string,
    data: { provider: IntegrationProvider; name?: string; config: Record<string, unknown> },
  ) => api.post<IntegrationResponse>(`/companies/${companyId}/integrations`, data),

  remove: (companyId: string, provider: IntegrationProvider) =>
    api.delete<{ ok: boolean }>(`/companies/${companyId}/integrations/${provider}`),

  test: (companyId: string, provider: IntegrationProvider, config?: Record<string, unknown>) =>
    api.post<TestResult>(`/companies/${companyId}/integrations/${provider}/test`, config ? { config } : {}),
};
