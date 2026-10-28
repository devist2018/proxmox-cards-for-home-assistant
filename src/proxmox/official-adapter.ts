import type {
  CapabilityStatus,
  LifecycleActionId,
} from "../infrastructure/model";
import type { DeviceEntry, EntityEntry, HaState, Registry } from "../ha/types";
import type {
  ProxmoxVmModel,
  VmIdentity,
  VmMetric,
  VmMetricKey,
} from "./model";

const sensorKeys = {
  cpu: "vm_cpu",
  memory: "vm_memory",
  memoryTotal: "vm_max_memory",
  memoryPercentage: "vm_memory_percentage",
  disk: "vm_disk",
  diskTotal: "vm_max_disk",
  networkRx: "vm_netin",
  networkTx: "vm_netout",
  uptime: "vm_uptime",
  status: "vm_status",
} as const;
const containerKeys = {
  cpu: "container_cpu",
  memory: "container_memory",
  memoryTotal: "container_max_memory",
  memoryPercentage: "container_memory_percentage",
  disk: "container_disk",
  diskTotal: "container_max_disk",
  networkRx: "container_netin",
  networkTx: "container_netout",
  uptime: "container_uptime",
  status: "container_status",
} as const;
const buttonKeys: Record<LifecycleActionId, string> = {
  start: "start",
  shutdown: "shutdown",
  reboot: "restart",
  "force-stop": "stop",
  suspend: "pause",
  resume: "resume",
};
export type EntityRole = keyof typeof sensorKeys;
export const entityRoles = Object.keys(sensorKeys) as EntityRole[];
export type EntityOverrides = Partial<Record<EntityRole, string>>;
export interface VmBinding {
  identity: VmIdentity;
  sensors: Partial<Record<EntityRole, EntityEntry>>;
  actions: Partial<Record<LifecycleActionId, EntityEntry>>;
  overrides: EntityOverrides;
}
function vmIdentifier(device: DeviceEntry): string {
  const ids = device.identifiers.filter(
    ([domain, id]) =>
      domain === "proxmoxve" && /^.+_(vm|container)_\d+$/.test(id),
  );
  if (
    (device.model !== "VM" &&
      device.model !== "LXC" &&
      device.model !== "Container") ||
    ids.length !== 1
  )
    throw new Error(
      "Select a VM or container device from the official Proxmox VE integration.",
    );
  return ids[0]![1];
}
export function discoverVm(
  registry: Registry,
  deviceId: string,
  overrides: EntityOverrides = {},
): VmBinding {
  const device = registry.devices.find((d) => d.id === deviceId);
  if (!device)
    throw new Error(
      "Configured VM device was not found in the Home Assistant device registry.",
    );
  const identifier = vmIdentifier(device);
  const match = /^(.+)_(vm|container)_(\d+)$/.exec(identifier)!;
  const isContainer = match[2] === "container";
  const prefix = `${match[1]}_${match[3]}_`;
  const keys: Record<string, string> = isContainer ? containerKeys : sensorKeys;
  const parent = registry.devices.find((d) => d.id === device.via_device_id);
  const nodeIds =
    parent?.identifiers.filter(
      ([domain, id]) =>
        domain === "proxmoxve" && id.startsWith(`${match[1]}_node_node/`),
    ) ?? [];
  if (nodeIds.length !== 1)
    throw new Error(
      "VM device has no unambiguous official Proxmox node association.",
    );
  const entities = registry.entities.filter(
    (e) => e.device_id === deviceId && e.platform === "proxmoxve",
  );
  const resolve = (
    key: string,
    domain: string,
    override?: string,
  ): EntityEntry | undefined => {
    const candidates = entities.filter(
      (e) =>
        e.entity_id.startsWith(`${domain}.`) &&
        (override
          ? e.entity_id === override
          : e.unique_id === prefix + key &&
            (!e.translation_key || e.translation_key === key)),
    );
    if (candidates.length > 1)
      throw new Error(
        `Ambiguous Proxmox entity for ${key}. Configure an explicit entity override.`,
      );
    if (override && candidates.length !== 1)
      throw new Error(
        `Override ${override} must belong to this official Proxmox VM device and use the ${domain} domain.`,
      );
    return candidates[0];
  };
  const sensors: VmBinding["sensors"] = {};
  for (const role of entityRoles) {
    const entity = resolve(keys[role]!, "sensor", overrides[role]);
    if (entity) sensors[role] = entity;
  }
  const actions: VmBinding["actions"] = {};
  for (const id of Object.keys(buttonKeys) as LifecycleActionId[]) {
    const entity = resolve(buttonKeys[id], "button");
    if (entity) actions[id] = entity;
  }
  return {
    identity: {
      deviceId,
      name: device.name_by_user || device.name || `VM ${match[2]}`,
      vmId: Number(match[3]),
      node: nodeIds[0]![1].slice(`${match[1]}_node_node/`.length),
    },
    sensors,
    actions,
    overrides: { ...overrides },
  };
}
const byteUnits: Record<string, number> = {
  B: 1,
  bytes: 1,
  kB: 1e3,
  KB: 1e3,
  MB: 1e6,
  GB: 1e9,
  TB: 1e12,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
  TiB: 1024 ** 4,
};
const timeUnits: Record<string, number> = {
  s: 1,
  sec: 1,
  seconds: 1,
  min: 60,
  minutes: 60,
  h: 3600,
  hours: 3600,
  d: 86400,
  days: 86400,
};
function reading(
  entity: EntityEntry | undefined,
  states: Record<string, HaState>,
  unit: VmMetric["unit"],
  now: number,
): number | null {
  if (!entity || entity.disabled_by) return null;
  const state = states[entity.entity_id];
  if (!state || ["unknown", "unavailable", ""].includes(state.state.trim()))
    return null;
  if (unit === "seconds" && state.attributes.device_class === "uptime") {
    const date = Date.parse(state.state);
    return Number.isFinite(date) && date <= now ? (now - date) / 1000 : null;
  }
  const n = Number(state.state);
  const symbol = state.attributes.unit_of_measurement;
  const factor =
    typeof symbol === "string"
      ? unit === "bytes"
        ? byteUnits[symbol]
        : unit === "seconds"
          ? timeUnits[symbol]
          : symbol === "%"
            ? 1
            : undefined
      : undefined;
  const value = factor === undefined ? NaN : n * factor;
  return Number.isFinite(value) &&
    value >= 0 &&
    (unit !== "percent" || value <= 100)
    ? value
    : null;
}
function capability(
  entity: EntityEntry | undefined,
  overridden: boolean,
): CapabilityStatus {
  return !entity
    ? "missing"
    : entity.disabled_by
      ? "disabled"
      : overridden
        ? "overridden"
        : "available";
}
export function normalizeVm(
  binding: VmBinding,
  states: Record<string, HaState>,
  now = Date.now(),
): ProxmoxVmModel {
  const status = binding.sensors.status;
  const token =
    status && !status.disabled_by ? states[status.entity_id]?.state : undefined;
  const state =
    token === undefined || token === "unavailable"
      ? "unavailable"
      : ["running", "stopped", "suspended"].includes(token)
        ? (token as ProxmoxVmModel["state"])
        : "unknown";
  const model: ProxmoxVmModel = {
    identity: binding.identity,
    state,
    metrics: {},
    capabilities: {},
    actions: [],
  };
  for (const key of [
    "cpu",
    "memory",
    "disk",
    "networkRx",
    "networkTx",
    "uptime",
  ] as VmMetricKey[]) {
    const unit =
      key === "cpu" ? "percent" : key === "uptime" ? "seconds" : "bytes";
    const entity = binding.sensors[key];
    let value = reading(entity, states, unit, now);
    let cap = capability(entity, !!binding.overrides[key]);
    let total: number | null = null;
    let percentage: number | null = null;
    if (key === "memory" || key === "disk") {
      total = reading(
        binding.sensors[key === "memory" ? "memoryTotal" : "diskTotal"],
        states,
        "bytes",
        now,
      );
      if (key === "memory") {
        percentage = reading(
          binding.sensors.memoryPercentage,
          states,
          "percent",
          now,
        );
        if (
          !binding.overrides.memory &&
          (!entity || entity.disabled_by) &&
          binding.sensors.memoryPercentage &&
          !binding.sensors.memoryPercentage.disabled_by &&
          binding.sensors.memoryTotal &&
          !binding.sensors.memoryTotal.disabled_by
        ) {
          value =
            total !== null && percentage !== null
              ? (total * percentage) / 100
              : null;
          cap =
            binding.overrides.memoryPercentage || binding.overrides.memoryTotal
              ? "overridden"
              : "available";
        }
      }
      if (value !== null && total !== null && total > 0)
        percentage = (value / total) * 100;
    }
    model.capabilities[key] = cap;
    if (cap === "missing" || cap === "disabled") continue;
    const metric: VmMetric = {
      unit,
      value: state === "unavailable" ? null : value,
      availability:
        state !== "unavailable" && value !== null ? "available" : "unavailable",
    };
    if (total !== null) metric.total = total;
    if (percentage !== null) metric.percentage = percentage;
    model.metrics[key] = metric;
  }
  model.actions = (Object.keys(buttonKeys) as LifecycleActionId[]).map(
    (id) => ({ id, capability: capability(binding.actions[id], false) }),
  );
  return model;
}
