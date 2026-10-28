import { ProxmoxVmCard } from "./card/proxmox-lxc-card";
if (!customElements.get("proxmox-lxc-card"))
  customElements.define("proxmox-lxc-card", ProxmoxVmCard);

import { ProxmoxVmCardEditor } from "./card/proxmox-lxc-card-editor";
if (!customElements.get("proxmox-lxc-card-editor"))
  customElements.define("proxmox-lxc-card-editor", ProxmoxVmCardEditor);
const host = window as Window & {
  customCards?: { type: string; name: string; description: string }[];
};
host.customCards ??= [];
if (!host.customCards.some((card) => card.type === "proxmox-lxc-card"))
  host.customCards.push({
    type: "proxmox-lxc-card",
    name: "Proxmox VM Card",
    description:
      "Monitor and control a VM from the official Proxmox VE integration.",
  });
