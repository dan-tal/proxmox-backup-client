FROM node:22-slim AS frontend
WORKDIR /frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM debian:13-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        gnupg \
        ca-certificates \
        python3 \
        python3-flask \
        cpio \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://enterprise.proxmox.com/debian/proxmox-release-trixie.gpg \
        -o /etc/apt/trusted.gpg.d/proxmox-release-trixie.gpg

RUN echo "deb http://download.proxmox.com/debian/pbs-client trixie main" \
        > /etc/apt/sources.list.d/pbs-client.list

RUN echo "deb http://download.proxmox.com/debian/pve trixie pve-no-subscription" \
        > /etc/apt/sources.list.d/pve.list

RUN apt-get update && apt-get install -y --no-install-recommends \
        proxmox-backup-client \
    && rm -rf /var/lib/apt/lists/*

# proxmox-backup-file-restore boot-eaza o micro-VM QEMU/KVM interna ca sa
# monteze imaginea de disc a unui VM si sa navigheze filesystem-ul dinauntru
# (la fel ca functia "File Restore" din PVE). Necesita acces la /dev/kvm.
RUN apt-get update && apt-get install -y \
        proxmox-backup-file-restore \
        proxmox-backup-restore-image \
        pve-qemu-kvm \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY app.py pbs_query.py /app/
COPY --from=frontend /frontend/dist /app/static

EXPOSE 8080
ENTRYPOINT ["python3", "app.py"]
