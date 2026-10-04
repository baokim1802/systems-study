# Containers and Kubernetes

> "It works on my machine" stops being an excuse once you ship the machine. Containers package an app with everything it needs, and Kubernetes runs thousands of them across a fleet, restarting, scaling and routing traffic for you. Almost every modern backend runs this way.

## The big idea

Before shipping containers existed, loading a cargo ship meant handling sacks, barrels and crates of every shape. Then the world agreed on one **standard steel box**. Cranes, ships, trains and trucks don't care what's inside; they just move boxes. Shipping got dramatically cheaper and faster.

Software **containers** are the same idea. Your Node app, its exact Node version, its `node_modules`, and its config files go into one standard package. Any machine with a container runtime can run it the same way: your laptop, a CI server, or a cloud fleet.

**Kubernetes** is the port authority: you tell it "I want 10 of these boxes running, reachable at this address", and it decides which machines run them, replaces any that fail, and routes traffic to them.

## Virtual machines vs containers

Both let one physical server run many isolated workloads. The difference is *what* is shared.

```text
      Virtual machines                         Containers
┌────────┐┌────────┐┌────────┐       ┌────────┐┌────────┐┌────────┐
│ App A  ││ App B  ││ App C  │       │ App A  ││ App B  ││ App C  │
│ libs   ││ libs   ││ libs   │       │ libs   ││ libs   ││ libs   │
│Guest OS││Guest OS││Guest OS│       └────────┘└────────┘└────────┘
└────────┘└────────┘└────────┘       ┌──────────────────────────────┐
┌──────────────────────────────┐     │ Container runtime            │
│ Hypervisor                   │     ├──────────────────────────────┤
├──────────────────────────────┤     │ Host OS (one shared kernel)  │
│ Hardware                     │     ├──────────────────────────────┤
└──────────────────────────────┘     │ Hardware                     │
                                     └──────────────────────────────┘
```

| | Virtual machine | Container |
|---|---|---|
| Isolation | A whole simulated computer with its own kernel | An isolated **process** sharing the host's kernel |
| Size | Gigabytes (a full OS) | Megabytes to hundreds of MB |
| Start time | Tens of seconds to minutes (boot an OS) | Milliseconds to a second or two (start a process) |
| Security boundary | Strong (hardware virtualization) | Weaker (a kernel bug can affect all containers) |
| Typical use | Cloud servers, running different OSes | Packaging and running apps |

In the cloud you usually have both: your containers run on VMs.

## How a container really works

Here's the surprise: on Linux, a container is **just a normal process** (Day 6) that the kernel has put in blinkers. Two kernel features do it:

- **Namespaces** limit what a process can **see**. With its own PID namespace, the process thinks it's PID 1 and can't see other processes. With its own network namespace, it gets its own IP address and ports. There are namespaces for mounts (its own filesystem view), hostnames, users and more.
- **Control groups (cgroups)** limit what a process can **use**: e.g. at most 0.5 CPU and 512 MB of memory. Exceed the memory limit and the kernel kills it (the infamous **OOMKilled**, out of memory).

Plus a **root filesystem** from an image. That's it: no hidden VM.

## Images and layers

A container **image** is a read-only template: the filesystem plus metadata (which command to run, which port, environment variables). A **container** is a running instance of an image with a thin writable layer on top. One image, many containers: like a class and its objects.

Images are built from a **Dockerfile**:

```text
# start from an official base image
FROM node:22-slim
WORKDIR /app
# install dependencies first (its own, rarely changing layer)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# then copy the source code (changes often)
COPY . .
# don't run as root
USER node
EXPOSE 3000
CMD ["node", "server.js"]
```

Each instruction creates a **layer**, a filesystem diff identified by a hash of its contents (content-addressed storage, like Git on Day 53). Layers are **cached and shared**:

- If 20 images use `node:22-slim`, the machine stores that base layer once.
- On rebuild, Docker reuses cached layers until the first instruction whose inputs changed; everything after is rebuilt.

That's why the order above matters. Dependencies change rarely, source code changes constantly. Copying `package.json` and running `npm ci` *before* `COPY . .` means editing `server.js` reuses the cached `node_modules` layer: rebuilds take seconds instead of minutes.

Images live in a **registry** (Docker Hub, GitHub Container Registry, AWS ECR). You `docker build`, `docker push` to the registry, and servers `docker pull` and run:

```text
docker build -t myapp:1.4.2 .
docker run -p 8080:3000 myapp:1.4.2     # host port 8080 → container port 3000
docker push registry.example.com/myapp:1.4.2
```

Tag images with a **specific version** (or the git commit hash), not `latest`, so you know exactly what's running and can roll back (Day 50).

## Kubernetes: the main ideas

Running one container is easy. Running 300 across 40 machines, keeping them healthy through crashes, deploys and traffic spikes, is the hard part. **Kubernetes** (often "K8s") does it, and its core idea is **declarative desired state**:

> You don't say "start 3 containers". You say "there should **be** 3", and Kubernetes keeps working to make it true.

Inside, **controllers** run a **reconciliation loop**: observe actual state, compare to desired state, act to close the gap, repeat forever. If a machine dies and 3 becomes 2, a controller notices and starts another.

### The cluster

```text
                 Control plane
  ┌────────────────────────────────────────────────┐
  │ API server          everything talks to this   │
  │ etcd                all cluster state (Day 42) │
  │ scheduler           picks a node for new pods  │
  │ controller manager  reconciliation loops       │
  └────────────────────────────────────────────────┘
        │                 │                 │
   ┌─────────┐       ┌─────────┐       ┌─────────┐
   │ Node 1  │       │ Node 2  │       │ Node 3  │
   │ kubelet │       │ kubelet │       │ kubelet │
   │ pods... │       │ pods... │       │ pods... │
   └─────────┘       └─────────┘       └─────────┘

Nodes are worker machines (usually VMs). The kubelet on each node starts
and watches its pods; kube-proxy routes Service traffic to them.
```

### The objects you'll use most

| Object | What it is |
|---|---|
| **Pod** | The smallest unit: one (or a few tightly coupled) containers sharing an IP and volumes. Pods are disposable; they get replaced, not repaired. |
| **Deployment** | "Keep N replicas of this pod template running", and roll out new versions gradually (via ReplicaSets). |
| **Service** | A stable name and virtual IP that load-balances (Day 28) across matching pods, whose IPs keep changing. |
| **Ingress** / Gateway | HTTP routing from outside the cluster: `api.example.com/orders` → orders Service. |
| **ConfigMap / Secret** | Configuration and secrets injected as environment variables or files (Day 48). |
| **StatefulSet** | Like a Deployment but pods get stable names and their own persistent disks; used for databases. |
| **HorizontalPodAutoscaler** | Changes a Deployment's replica count based on metrics. |

A Deployment and Service in YAML (the format you send to the API server):

```text
apiVersion: apps/v1
kind: Deployment
metadata: { name: web }
spec:
  replicas: 3
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec:
      containers:
        - name: web
          image: registry.example.com/myapp:1.4.2
          ports: [{ containerPort: 3000 }]
          resources:
            requests: { cpu: "250m", memory: "256Mi" }
            limits:   { memory: "512Mi" }
          readinessProbe: { httpGet: { path: /ready, port: 3000 } }
          livenessProbe:  { httpGet: { path: /healthz, port: 3000 } }
---
apiVersion: v1
kind: Service
metadata: { name: web }
spec:
  selector: { app: web }        # route to pods with this label
  ports: [{ port: 80, targetPort: 3000 }]
```

Other pods can now call `http://web` and Kubernetes DNS plus the Service spread requests across the 3 pods.

### Resources and probes

- **Requests** are what the scheduler reserves for the pod (`250m` = a quarter of a CPU core). **Limits** are the cap: over the CPU limit you're **throttled** (slowed down); over the memory limit you're **OOMKilled**.
- A **readiness probe** answers "can this pod take traffic right now?" If it fails, the pod is removed from the Service's endpoints but not restarted (e.g. still warming up, or a dependency is down).
- A **liveness probe** answers "is this pod stuck?" If it fails repeatedly, the container is restarted. Make it cheap and local; don't check the database in it, or a DB blip restarts your whole fleet.
- A **startup probe** gives slow-starting apps time before liveness checks begin.

## Autoscaling

The **Horizontal Pod Autoscaler (HPA)** periodically compares a metric to a target and resizes:

```text
desiredReplicas = ceil( currentReplicas × currentMetric / targetMetric )
```

Example: 4 pods averaging **90%** CPU (of their request), target **60%**:

```text
ceil(4 × 90 / 60) = ceil(6) = 6 pods
```

Later traffic drops and 6 pods average 20%: `ceil(6 × 20 / 60) = 2` pods (subject to the configured minimum, and a scale-down delay so it doesn't flap).

If there's no room on existing nodes for the new pods, they sit **Pending**, and the **Cluster Autoscaler** (or similar) adds a VM. That takes a minute or more, so keep some headroom for spikes.

## The math: packing pods onto nodes

Nodes have 4 CPU cores and 16 GiB memory; about 0.5 core and 1 GiB are reserved for the system. Each pod requests 0.5 CPU and 1 GiB.

```text
by CPU:    (4 − 0.5) / 0.5 = 7 pods
by memory: (16 − 1) / 1    = 15 pods
→ 7 pods per node (CPU is the bottleneck)

60 pods needed → ceil(60 / 7) = 9 nodes (+1 spare for failures/rollouts = 10)
```

Memory is half-empty on every node: a sign the pods' requests don't match the machine shape, and a smaller-memory, CPU-optimized instance type would be cheaper (Day 51).

## In an interview

You rarely need YAML in a system design interview, but you should be fluent in the vocabulary: *"stateless services run as Deployments behind a Service, scaled by an HPA on CPU or request rate, with readiness probes so rollouts don't send traffic to cold pods."* Interviewers also like hearing that you know the limits: stateful databases on Kubernetes are harder, and many teams use a managed database instead.

A strong answer about "VMs vs containers": *"A VM virtualizes hardware and runs its own kernel, so it's heavier but strongly isolated. A container is an ordinary process isolated with Linux namespaces and limited with cgroups, sharing the host kernel, so it starts in about a second and is megabytes, not gigabytes. Images are layered and cached, which makes builds and pulls fast. Kubernetes then schedules containers onto a fleet of VMs and continuously reconciles actual state toward the desired state."*

## Common mistakes

- **"A container is a lightweight VM."** It's a process with namespaces and cgroups; it shares the kernel.
- **Storing data inside the container's filesystem.** It vanishes when the pod is replaced. Use a volume, or better, an external database or object storage (Day 36).
- **Using the `latest` tag in production.** You can't tell what's running or roll back reliably.
- **`COPY . .` before installing dependencies.** Every code change busts the dependency cache.
- **Liveness probes that check dependencies.** A database hiccup then restarts every pod at once.
- **No resource requests.** The scheduler can't place pods sensibly, and noisy neighbors starve each other.

## Before moving on

- [ ] I can explain VMs vs containers, including namespaces and cgroups
- [ ] I can explain image layers and why Dockerfile order matters
- [ ] I can describe pod, Deployment, Service, and what happens when a pod dies
- [ ] I can explain readiness vs liveness probes, requests vs limits
- [ ] I can compute an HPA scaling decision and a pods-per-node estimate

## Go deeper (optional)

- [Kubernetes documentation: Concepts](https://kubernetes.io/docs/concepts/)
- [Docker documentation: Dockerfile best practices](https://docs.docker.com/build/building/best-practices/)
- [Kubernetes: Horizontal Pod Autoscaling](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/)
- [Wikipedia: Linux namespaces](https://en.wikipedia.org/wiki/Linux_namespaces) and [cgroups](https://en.wikipedia.org/wiki/Cgroups)
