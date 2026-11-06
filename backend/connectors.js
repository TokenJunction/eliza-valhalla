export const CONNECTORS = [
  {
    id: "google-drive",
    label: "Google Drive",
    api: "https://www.googleapis.com/drive/v3",
    official: true,
    configured: false,
  },
  {
    id: "github",
    label: "GitHub",
    api: "https://api.github.com",
    official: true,
    configured: false,
  },
  {
    id: "cloudflare",
    label: "Cloudflare",
    api: "https://api.cloudflare.com/client/v4",
    official: true,
    configured: false,
  },
  {
    id: "s3",
    label: "S3 or R2",
    api: "https://s3.amazonaws.com",
    official: true,
    configured: false,
    prefixRequired: true,
  },
];

export function listConnectors() {
  return CONNECTORS.map((item) => ({
    id: item.id,
    label: item.label,
    api: item.api,
    official: true,
    configured: false,
    status: "not-configured",
    scraping: false,
  }));
}

export function connectorRequest(id, input) {
  const item = CONNECTORS.find((row) => row.id === id);
  if (!item) return { ok: false, status: 404, error: "unknown" };
  if (item.prefixRequired && !String(input && input.prefix || "").trim()) {
    return { ok: false, status: 400, error: "prefix-required" };
  }
  return {
    ok: false,
    status: 503,
    error: "not-configured",
    id: item.id,
    api: item.api,
    prefix: item.prefixRequired ? String(input.prefix) : null,
    called: false,
  };
}
