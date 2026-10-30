const MODULES = [
  "dashboard", "players", "parents", "requests", "programs", "terms",
  "classes", "attendance", "teams", "leagues", "events", "store",
  "orders", "invoices", "payments", "bankDetails", "reports", "communication",
  "news", "notes", "coaches", "sponsors", "audit",
];

const ACTIONS = ["read", "create", "edit", "delete", "assign", "approve", "export"];
const SUPPORTED = {
  dashboard: ["read"], players: ["read", "create", "edit", "delete", "assign", "export"],
  parents: ["read"], requests: ["read", "delete", "assign", "approve"],
  programs: ["read", "create", "edit", "delete"], terms: ["read", "create", "edit", "delete"],
  classes: ["read", "create", "edit", "delete", "assign", "export"],
  attendance: ["read", "edit"], teams: ["read", "create", "edit", "delete", "assign", "export"],
  leagues: ["read", "create", "edit", "delete", "assign", "approve"],
  events: ["read", "create", "edit", "delete", "approve", "export"],
  store: ["read", "create", "edit", "delete"], orders: ["read", "edit"],
  invoices: ["read", "create", "edit", "delete"],
  payments: ["read", "edit", "approve"], bankDetails: ["read", "create", "edit"], reports: ["read", "export"],
  communication: ["read", "create", "edit", "delete"], news: ["read", "create", "edit", "delete"],
  notes: ["read", "create", "edit"], coaches: ["read", "create", "edit"],
  sponsors: ["read", "create", "edit", "delete"], audit: ["read"],
};
const ALL_ONLY = new Set(["dashboard", "requests", "programs", "terms", "events", "store", "bankDetails", "reports", "news", "coaches", "sponsors", "audit"]);
const OWN_ONLY = new Set(["notes"]);
const DEFAULT_ON = {
  dashboard: ["read"],
  players: ["read", "create"],
  parents: ["read"],
  requests: ["read"],
  programs: ["read"],
  terms: ["read"],
  classes: ["read"],
  attendance: ["read", "edit"],
  teams: ["read"],
  leagues: ["read"],
  communication: ["read", "create"],
  news: ["read"],
  notes: ["read", "create", "edit"],
};

const defaultPermissions = () => Object.fromEntries(MODULES.map((module) => [module, {
  scope: ALL_ONLY.has(module) ? "ALL" : "ASSIGNED",
  ...Object.fromEntries(ACTIONS.map((action) => [action, (DEFAULT_ON[module] || []).includes(action)])),
}]));

const normalizePermissions = (input) => {
  const defaults = defaultPermissions();
  if (!input || typeof input !== "object" || Array.isArray(input)) return defaults;
  for (const module of MODULES) {
    const submitted = input[module];
    if (!submitted || typeof submitted !== "object" || Array.isArray(submitted)) continue;
    defaults[module].scope = ALL_ONLY.has(module) || (!OWN_ONLY.has(module) && submitted.scope === "ALL") ? "ALL" : "ASSIGNED";
    for (const action of ACTIONS) {
      if (typeof submitted[action] === "boolean" && SUPPORTED[module].includes(action)) defaults[module][action] = submitted[action];
      if (!SUPPORTED[module].includes(action)) defaults[module][action] = false;
    }
    if (module === "leagues" && defaults[module].scope === "ASSIGNED") {
      for (const action of ["create", "delete", "approve"]) defaults[module][action] = false;
    }
    if (!defaults[module].read) {
      for (const action of ACTIONS) defaults[module][action] = false;
    }
  }
  return defaults;
};

const accessFor = (admin) => ({
  mode: admin?.role === "COACH" && admin?.accessMode === "FULL" ? "FULL" : "PARTIAL",
  permissions: normalizePermissions(admin?.permissions),
});

const isPrivileged = (admin) => ["SUPER_ADMIN", "ADMIN"].includes(admin?.role);
const can = (admin, module, action = "read") => {
  if (!admin || admin.isActive === false) return false;
  if (isPrivileged(admin)) return true;
  if (admin.role !== "COACH") return false;
  const access = accessFor(admin);
  return access.mode === "FULL" || Boolean(access.permissions[module]?.read && access.permissions[module]?.[action]);
};
const scopeFor = (admin, module) => {
  if (isPrivileged(admin) || accessFor(admin).mode === "FULL") return "ALL";
  return accessFor(admin).permissions[module]?.scope || "ASSIGNED";
};

module.exports = { MODULES, ACTIONS, SUPPORTED, defaultPermissions, normalizePermissions, accessFor, isPrivileged, can, scopeFor };
