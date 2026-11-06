import { createHash } from "node:crypto";
import { signBytes, verifyBytes } from "./ed25519.js";

export const FIRST_PARTY = ["trading", "ai-workspace", "thalos", "data-explorer"];

export function builtinManifests() {
  return [
    manifest({
      id: "trading",
      name: "Trading Desk",
      version: "1.0.0",
      icon: "chart",
      permissions: ["wallet.identity", "paper.trade"],
      dataScopes: ["app:trading"],
      networkScopes: [],
      providerCapabilities: [],
      license: "core",
      window: { title: "Trading Desk", w: 760, h: 520 },
      entry: "trading",
    }),
    manifest({
      id: "ai-workspace",
      name: "AI Workspace",
      version: "1.0.0",
      icon: "bot",
      permissions: ["ai.local", "tasks"],
      dataScopes: ["app:ai-workspace"],
      networkScopes: ["local-relay"],
      providerCapabilities: ["chat"],
      license: "core",
      window: { title: "AI Workspace", w: 720, h: 520 },
      entry: "ai-workspace",
    }),
    manifest({
      id: "thalos",
      name: "Thalos",
      version: "1.0.0",
      icon: "search",
      permissions: ["paper.view"],
      dataScopes: ["app:thalos"],
      networkScopes: [],
      providerCapabilities: ["chat"],
      license: "core",
      window: { title: "Thalos", w: 680, h: 480 },
      entry: "thalos",
    }),
    manifest({
      id: "data-explorer",
      name: "Data Explorer",
      version: "1.0.0",
      icon: "table",
      permissions: ["data.local"],
      dataScopes: ["app:data-explorer"],
      networkScopes: [],
      providerCapabilities: [],
      license: "core",
      window: { title: "Data Explorer", w: 640, h: 480 },
      entry: "data-explorer",
    }),
  ];
}

export const NOT_CONFIGURED_APPS = [
  { id: "code-assistant", name: "Code assistant", status: "not-configured", network: false },
  { id: "research", name: "Research", status: "not-configured", network: false },
  { id: "content", name: "Content", status: "not-configured", network: false },
];

export function manifest(doc) {
  const body = {
    v: 1,
    id: String(doc.id),
    name: String(doc.name),
    version: String(doc.version),
    icon: String(doc.icon || "app"),
    permissions: doc.permissions || [],
    dataScopes: doc.dataScopes || [],
    networkScopes: doc.networkScopes || [],
    providerCapabilities: doc.providerCapabilities || [],
    license: doc.license === "pro" ? "pro" : "core",
    window: doc.window || { title: doc.name, w: 640, h: 480 },
    entry: String(doc.entry || doc.id),
  };
  body.integrity = createHash("sha256").update(`${body.id}@${body.version}:${body.entry}`).digest("hex");
  return body;
}

export function signManifest(privateKey, doc) {
  const body = manifest(doc);
  const sig = signBytes(privateKey, Buffer.from(JSON.stringify(body))).toString("base64url");
  return { ...body, sig };
}

export function editionAllows(doc, rights) {
  if (!doc) return false;
  if (doc.license === "pro" && (!rights || rights.edition !== "pro")) return false;
  return true;
}

export function canLaunch(installed, doc, publicKey) {
  if (!doc || !installed.includes(doc.id)) return false;
  if (FIRST_PARTY.includes(doc.id)) return doc.integrity === manifest(doc).integrity;
  if (!publicKey || !doc.sig) return false;
  const { sig, ...rest } = doc;
  return verifyBytes(publicKey, Buffer.from(JSON.stringify(rest)), Buffer.from(sig, "base64url"));
}

export function scopeKey(workspaceId, appId, userId, key) {
  return `${workspaceId}:${appId}:${userId}:${key}`;
}
