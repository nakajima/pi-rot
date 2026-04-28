---
name: proxmox
description: Manage Proxmox VE cluster VMs, containers, snapshots, and Proxmox Backup Server via the REST API. Use when the user asks about VMs, containers, backups, or anything related to their Proxmox infrastructure.
---

# Proxmox

Manage a Proxmox VE cluster at `proxmox.fishmt.net` and Proxmox Backup Server at `backup.fishmt.net` via their REST APIs.

**Important:** Both services are behind a Caddy reverse proxy on standard HTTPS (port 443). Do NOT use port 8006 or 8007.

## Setup

Required environment variables:

```
# Proxmox VE
PROXMOX_TOKEN_ID=user@realm!tokenid
PROXMOX_TOKEN=<secret-uuid>

# Proxmox Backup Server
PBS_TOKEN_ID=user@realm!tokenid
PBS_TOKEN=<secret-uuid>
```

## Scripts

Two thin curl wrappers that handle auth and JSON output:

```bash
./scripts/pve-api.sh <METHOD> <PATH> [key=value ...]   # PVE
./scripts/pbs-api.sh <METHOD> <PATH> [key=value ...]   # PBS
```

GET/DELETE params become query strings. POST/PUT params become a JSON body.

## Proxmox VE API Reference

### Cluster

```bash
./scripts/pve-api.sh GET /cluster/status          # Cluster status
./scripts/pve-api.sh GET /cluster/resources        # All resources
./scripts/pve-api.sh GET /cluster/resources type=vm # Only VMs/CTs
./scripts/pve-api.sh GET /cluster/tasks            # Recent tasks
```

### Nodes

```bash
./scripts/pve-api.sh GET /nodes                          # List nodes
./scripts/pve-api.sh GET /nodes/{node}/status            # Node status
./scripts/pve-api.sh GET /nodes/{node}/network           # Network config
./scripts/pve-api.sh GET /nodes/{node}/storage           # Storage list
./scripts/pve-api.sh GET /nodes/{node}/disks/list        # Physical disks
```

### Virtual Machines (QEMU)

```bash
# List & status
./scripts/pve-api.sh GET /nodes/{node}/qemu                     # List VMs on node
./scripts/pve-api.sh GET /nodes/{node}/qemu/{vmid}/status/current  # VM status

# Power
./scripts/pve-api.sh POST /nodes/{node}/qemu/{vmid}/status/start
./scripts/pve-api.sh POST /nodes/{node}/qemu/{vmid}/status/stop
./scripts/pve-api.sh POST /nodes/{node}/qemu/{vmid}/status/shutdown  # ACPI shutdown
./scripts/pve-api.sh POST /nodes/{node}/qemu/{vmid}/status/reboot
./scripts/pve-api.sh POST /nodes/{node}/qemu/{vmid}/status/reset    # Hard reset
./scripts/pve-api.sh POST /nodes/{node}/qemu/{vmid}/status/suspend

# Config
./scripts/pve-api.sh GET /nodes/{node}/qemu/{vmid}/config          # Get config
./scripts/pve-api.sh PUT /nodes/{node}/qemu/{vmid}/config memory=4096 cores=2

# Create VM
./scripts/pve-api.sh POST /nodes/{node}/qemu vmid=200 name=my-vm memory=2048 cores=2 scsihw=virtio-scsi-single

# Delete VM
./scripts/pve-api.sh DELETE /nodes/{node}/qemu/{vmid}

# Clone
./scripts/pve-api.sh POST /nodes/{node}/qemu/{vmid}/clone newid=201 name=my-clone full=1

# Migrate
./scripts/pve-api.sh POST /nodes/{node}/qemu/{vmid}/migrate target=pve2

# Snapshots
./scripts/pve-api.sh GET /nodes/{node}/qemu/{vmid}/snapshot
./scripts/pve-api.sh POST /nodes/{node}/qemu/{vmid}/snapshot snapname=snap1 description="before upgrade"
./scripts/pve-api.sh POST /nodes/{node}/qemu/{vmid}/snapshot/snap1/rollback
./scripts/pve-api.sh DELETE /nodes/{node}/qemu/{vmid}/snapshot/snap1
```

### Containers (LXC)

```bash
# List & status
./scripts/pve-api.sh GET /nodes/{node}/lxc                        # List CTs on node
./scripts/pve-api.sh GET /nodes/{node}/lxc/{vmid}/status/current  # CT status

# Power
./scripts/pve-api.sh POST /nodes/{node}/lxc/{vmid}/status/start
./scripts/pve-api.sh POST /nodes/{node}/lxc/{vmid}/status/stop
./scripts/pve-api.sh POST /nodes/{node}/lxc/{vmid}/status/shutdown
./scripts/pve-api.sh POST /nodes/{node}/lxc/{vmid}/status/reboot

# Config
./scripts/pve-api.sh GET /nodes/{node}/lxc/{vmid}/config
./scripts/pve-api.sh PUT /nodes/{node}/lxc/{vmid}/config memory=1024 cores=1

# Create CT
./scripts/pve-api.sh POST /nodes/{node}/lxc vmid=300 hostname=my-ct ostemplate=local:vztmpl/debian-12-standard_12.2-1_amd64.tar.zst memory=512 rootfs=local-lvm:8

# Delete CT
./scripts/pve-api.sh DELETE /nodes/{node}/lxc/{vmid}

# Snapshots (same pattern as QEMU)
./scripts/pve-api.sh GET /nodes/{node}/lxc/{vmid}/snapshot
./scripts/pve-api.sh POST /nodes/{node}/lxc/{vmid}/snapshot snapname=snap1
./scripts/pve-api.sh POST /nodes/{node}/lxc/{vmid}/snapshot/snap1/rollback
./scripts/pve-api.sh DELETE /nodes/{node}/lxc/{vmid}/snapshot/snap1
```

### Backup (vzdump via PVE)

```bash
# Trigger a backup
./scripts/pve-api.sh POST /nodes/{node}/vzdump vmid=100 storage=local mode=snapshot

# List backup jobs
./scripts/pve-api.sh GET /cluster/backup
```

### Tasks

```bash
# Check task status (UPID returned by async operations)
./scripts/pve-api.sh GET /nodes/{node}/tasks/{upid}/status
./scripts/pve-api.sh GET /nodes/{node}/tasks/{upid}/log
```

## Proxmox Backup Server API Reference

### Datastores

```bash
./scripts/pbs-api.sh GET /admin/datastore                         # List datastores
./scripts/pbs-api.sh GET /admin/datastore/{store}/status          # Datastore usage
```

### Snapshots / Backups

```bash
./scripts/pbs-api.sh GET /admin/datastore/{store}/snapshots       # List all backups
./scripts/pbs-api.sh GET /admin/datastore/{store}/snapshots backup-type=vm backup-id=100  # Filter

# Delete a backup snapshot
./scripts/pbs-api.sh DELETE /admin/datastore/{store}/snapshots backup-type=vm backup-id=100 backup-time=1700000000
```

### Garbage Collection

```bash
./scripts/pbs-api.sh POST /admin/datastore/{store}/gc             # Start GC
./scripts/pbs-api.sh GET /admin/datastore/{store}/gc              # GC status
```

### Verify

```bash
./scripts/pbs-api.sh POST /admin/datastore/{store}/verify         # Verify integrity
```

### Node Status

```bash
./scripts/pbs-api.sh GET /nodes/localhost/status                  # PBS node status
./scripts/pbs-api.sh GET /nodes/localhost/tasks                   # Recent tasks
```

## Tips

- **Replace `{node}`** with the actual node name (e.g., `pve1`, `pve2`). List nodes first with `GET /nodes`.
- **Replace `{vmid}`** with the numeric VM/CT ID (e.g., `100`, `201`).
- **Replace `{store}`** with the PBS datastore name.
- **Async operations** (clone, migrate, backup) return a UPID. Poll the task status to check completion.
- **Dangerous operations** (delete, stop) — confirm with the user before executing.
- When unsure about available parameters for an endpoint, consult the [PVE API docs](https://pve.proxmox.com/pve-docs/api-viewer/) or [PBS API docs](https://pbs.proxmox.com/docs/api-viewer/).
