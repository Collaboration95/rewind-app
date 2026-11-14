"""Build reproducible presentation tables and 1280x720 charts from hosted JSON.

Usage: python analyze.py /absolute/path/to/load-test
Requires numpy and matplotlib. Never reads private authentication fixtures.
"""
import json
import math
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

root = Path(sys.argv[1])
report = json.loads((root / "results/hosted.json").read_text())
stages = [s for s in report["stages"] if s["phase"] == "steady"]
if len(stages) != 5 or [s["vus"] for s in stages] != [1, 10, 25, 50, 100]:
    raise ValueError("Expected complete five-stage evidence")
# Fit only the repeating journey. The three bounded uploads are retained in
# acceptance statistics, but are not a sustained upload arrival process.
points = []
for stage in stages:
    rows = [s for s in report["samples"] if s["phase"] == "steady" and s["stage"] == stage["vus"] and not (s["operation"].startswith("upload-") or s["operation"] == "process-contribution")]
    points.append({"vus": stage["vus"], "rps": len(rows)/stage["elapsedSeconds"], "meanSeconds": sum(s["ms"] for s in rows)/len(rows)/1000})
calibration = points[1:]  # Use the sustained multi-user regime; retain 1 VU as baseline.
x = np.array([p["rps"] for p in calibration])
y = np.array([p["meanSeconds"] for p in calibration])
# One-dimensional grid with the least-squares optimum L at each S.
# Equal weights per load level avoid letting the busiest stage dominate.
ceiling = min(.999/x.max(), y.min())
grid = np.geomspace(1e-5, ceiling, 100000)
queue = grid[:, None] / (1 - grid[:, None] * x)
fixed = np.maximum(0, np.mean(y - queue, axis=1))
loss = np.mean((fixed[:, None] + queue - y)**2, axis=1)
best = int(np.argmin(loss))
S, L = float(grid[best]), float(fixed[best])
Z = 5.0

def project(n, demand=S, hosts=1):
    low, high = 0.0, hosts / demand * (1 - 1e-10)
    for _ in range(100):
        rate = (low + high)/2
        utilization = rate*demand/hosts
        response = L + demand/(1-utilization)
        if rate*(Z+response) > n:
            high = rate
        else:
            low = rate
    rate = (low+high)/2
    u = rate*demand/hosts
    return {"users": n, "throughputRps": rate, "utilization": u, "meanMs": 1000*(L+demand/(1-u))}

projections = [project(n) for n in [100,250,500,1000]]
practical_rate = .9/S
practical_users = practical_rate*(Z+L+S/.1)
model = {"model": "single serialized M/M/1 center plus fixed delay; closed-loop think time", "serviceDemandSecondsProjected": S, "fixedDelaySecondsProjected": L, "thinkTimeSeconds": Z, "rmseMs": 1000*math.sqrt(float(loss[best])), "calibrationMeasured": calibration, "baselineMeasured": points[0], "ceilingRpsProjected": 1/S, "practicalSaturationUsersProjected": practical_users, "practicalSaturationRpsProjected": practical_rate, "projections": projections, "twoHostsIdealizedProjected": [project(n, hosts=2) for n in [100,250,500,1000]], "serviceDemandSensitivityProjected": [{"demandMultiplier": multiplier, "projections": [project(n, demand=S*multiplier) for n in [100,250,500,1000]]} for multiplier in [.5,2]]}
(root/"results/capacity-model.json").write_text(json.dumps(model,indent=2)+"\n")

plt.rcParams.update({"font.size":17,"axes.titlesize":23,"axes.labelsize":18,"legend.fontsize":15,"xtick.labelsize":16,"ytick.labelsize":16,"figure.facecolor":"white","axes.spines.top":False,"axes.spines.right":False})

def figure():
    fig, ax = plt.subplots(figsize=(12.8,7.2),dpi=100)
    fig.subplots_adjust(left=.12,right=.96,bottom=.15,top=.83)
    ax.grid(axis='y',alpha=.22)
    return fig, ax

vus = [s["vus"] for s in stages]
fig, ax = figure()
for key,label,color in [("p50Ms","Measured p50","#2563eb"),("p95Ms","Measured p95","#d97706"),("p99Ms","Measured p99","#9333ea")]:
    ax.plot(vus,[s[key]/1000 for s in stages],marker='o',linewidth=2.5,label=label,color=color)
ax.axhline(2,color='#dc2626',linestyle='--',label='p95 target: 2 s')
ax.set(xlabel='Concurrent virtual users (VUs)',ylabel='End-to-end latency (seconds)',title='Rewind hosted dev: latency under load',xticks=vus)
ax.legend(loc='upper left')
fig.text(.12,.9,'CloudFront → Node → PostgreSQL • 3-minute steady windows',fontsize=14,color='#475569')
fig.savefig(root/'charts/latency-vs-vus.png');plt.close(fig)

fig, ax = figure()
ax.plot(vus,[s['throughputRps'] for s in stages],marker='o',linewidth=3,color='#059669',label='Measured completed requests/s')
ax.plot(vus,[(s['requests']-s['errors'])/s['elapsedSeconds'] for s in stages],marker='s',linewidth=2.5,color='#2563eb',label='Measured successful requests/s')
ax.set(xlabel='Concurrent virtual users (VUs)',ylabel='Throughput (requests/second)',title='Rewind hosted dev: achieved throughput',xticks=vus,ylim=(0,None))
ax.legend(loc='upper left')
fig.text(.12,.9,'Read-heavy closed loop • approximately 5 seconds think time per user',fontsize=14,color='#475569')
fig.savefig(root/'charts/throughput-vs-vus.png');plt.close(fig)

fig, ax = figure()
users=np.linspace(1,1000,300)
ax.plot(users,[project(float(n))['meanMs']/1000 for n in users],linewidth=3,color='#d97706',linestyle='--',label='Projected mean: one API host')
ax.plot(users,[project(float(n),hosts=2)['meanMs']/1000 for n in users],linewidth=2.5,color='#059669',linestyle='--',label='Projected mean: two balanced hosts')
ax.scatter(vus,[p['meanSeconds'] for p in points],s=75,color='#2563eb',zorder=4,label='Measured mean: repeating API mix')
ax.set(xlabel='Concurrent active users (5 s mean think time)',ylabel='Mean end-to-end latency (seconds)',title='Rewind capacity: measured vs projected',xlim=(0,1020),ylim=(0,None),xticks=[1,100,250,500,1000])
ax.legend(loc='upper left')
fig.text(.12,.9,f'Fitted serial demand {S*1000:.1f} ms/request • fixed delay {L*1000:.0f} ms • incident-influenced mean projections',fontsize=14,color='#475569')
fig.savefig(root/'charts/measured-vs-projected.png');plt.close(fig)

stage_table='| VUs | Requests measured | p50 ms measured | p95 ms measured | p99 ms measured | req/s measured | Errors measured | Result |\n| ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |\n'
for s in stages:
    stage_table+=f"| {s['vus']} | {s['requests']} | {s['p50Ms']:.1f} | {s['p95Ms']:.1f} | {s['p99Ms']:.1f} | {s['throughputRps']:.2f} | {s['errors']} ({s['errorRate']*100:.2f}%) | {'PASS' if s['p95Ms']<2000 and s['errorRate']<.01 else 'FAIL'} |\n"
capacity_table='| Users | req/s measured | Mean ms measured | p95 ms measured | req/s projected | Mean ms projected | U projected | Mean ms projected, two hosts |\n| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n'
for p,two in zip(projections,model['twoHostsIdealizedProjected']):
    measured=next((s for s in stages if s['vus']==p['users']),None)
    measured_text=f"{measured['throughputRps']:.2f} | {measured['meanMs']:.1f} | {measured['p95Ms']:.1f}" if measured else '— | — | —'
    capacity_table+=f"| {p['users']} | {measured_text} | {p['throughputRps']:.2f} | {p['meanMs']:.1f} | {p['utilization']*100:.1f}% | {two['meanMs']:.1f} |\n"
operations='| Operation | Requests measured | p50 ms measured | p95 ms measured | p99 ms measured | Errors measured |\n| --- | ---: | ---: | ---: | ---: | ---: |\n'
for op,s in report['operations'].items():
    operations+=f"| {op} | {s['requests']} | {s['p50Ms']:.1f} | {s['p95Ms']:.1f} | {s['p99Ms']:.1f} | {s['errors']} |\n"
cache={}
statuses={}
for sample in report['samples']:
    cache[sample['cache'] or 'none']=cache.get(sample['cache'] or 'none',0)+1
    statuses[str(sample['status'])]=statuses.get(str(sample['status']),0)+1
media=report['fixture']['media']
text=f'''# Rewind load-test results

Hosted test: {report['startedAt']} to {report['finishedAt']} (UTC). Target: {report['target']}. Source baseline: origin/dev f6cd8969379ba720fc0508833f138e29475bc32a. Driver: plain Node {report['node']} from this Mac.

## Measured hosted performance

Overall stage gate: **{'PASS' if report['passed'] else 'FAIL'}**. Each steady stage must meet p95 < 2 seconds and errors < 1%. Steady samples: {report['aggregate']['requests']}; errors: {report['aggregate']['errors']}; overall p95: {report['aggregate']['p95Ms']:.1f} ms. The five steady windows total {sum(s['elapsedSeconds'] for s in stages):.1f} seconds. Ramps are retained in raw JSON and excluded from this table.

{stage_table}
The highest passing tested stage is **50 VUs**. At 100 VUs, the error gate fails despite p95 meeting the latency target. Failures are clustered in a short upstream-error interval; acceptance keeps every failure. Host CPU: **unobserved**. The health endpoint reports PostgreSQL, ffmpeg configured and migration 31 ready. Status counts across ramps and steady windows: `{json.dumps(statuses,sort_keys=True)}`. CloudFront cache headers: `{json.dumps(cache,sort_keys=True)}`.

{operations}
Uploads: {media['uploadAttempts']} tiny photos attempted; source, contribution and processing results appear above. Capability requests returned {media['capabilitiesIssued']} nonempty download paths and {media['capabilityEmpty']} empty collecting-state archives. Media transfer and a populated released Archive were not exercised. The maximum tested activity was 100 VUs sharing three accounts in one test group.

## Capacity model: projected

The repeating API journey is fitted separately from the three bounded uploads. Fit the sustained multi-user regime (10/25/50/100 VUs); retain 1 VU as a separately measured baseline. The 1-VU stage is sparse and uses a different pooled-connection cadence. Fit effective serialized demand **S = {S*1000:.3f} ms/request** and fixed network/parallel delay **L = {L*1000:.1f} ms**; four-level mean-response RMSE = {model['rmseMs']:.1f} ms. S is an inferred service demand, not a measured CPU service time. The calibration includes failed requests: the short 100-VU upstream incident raises the fitted demand. Treat this as an incident-influenced operational projection, not proof that physical host saturation occurred. The input measurements and all model outputs are in `results/capacity-model.json`.

Use U = λS and R_queue = S/(1−U). Add fixed delay: R = L + R_queue. Users think for Z = 5 seconds, so λ = N/(Z+R). Solve these equations together; assuming λ=N/5 after saturation would overstate throughput. R is a mean. Do not compare this projected mean directly with the measured p95 acceptance target.

{capacity_table}
Modeled single-center ceiling: **{1/S:.1f} requests/second**. Practical saturation at U=90%: **{practical_rate:.1f} requests/second**, approximately **{practical_users:.0f} active users** under this think-time model. This is a projected knee; the test establishes results only through 100 VUs. At the ceiling the open-queue formula diverges; in the closed user model throughput approaches the ceiling while latency rises. Saturation of physical CPU or PostgreSQL was not measured.

Sensitivity at 1,000 users: halving fitted S projects {project(1000,demand=S*.5)['throughputRps']:.1f} req/s and {project(1000,demand=S*.5)['meanMs']:.0f} ms mean; doubling S projects {project(1000,demand=S*2)['throughputRps']:.1f} req/s and {project(1000,demand=S*2)['meanMs']:.0f} ms mean. Higher populations use the same small group and response-size assumptions as calibration.

## Bottleneck and scale-out

| Component | Measured | Source evidence and projected implication |
| --- | --- | --- |
| Node event loop + PostgreSQL bridge | Hosted request latencies above; no event-loop counters | `server/src/postgres/database.ts` uses Atomics.wait; `server/src/postgres/sync-worker.ts` runs one pg Client. Main-thread requests serialize around synchronous database calls. This is the strongest source-supported API bottleneck candidate. |
| PostgreSQL connections and writes | PostgreSQL confirmed by health; no connection/CPU counters | There is no request-serving connection pool to exhaust here. One client serializes calls. The adapter's schema-wide advisory writer lock also serializes write transactions across hosts. A second API host adds another connection and overlapping reads but cannot double shared write throughput. |
| ffmpeg media processing | Three small photo processing requests; no film compilation | ffmpeg is a child process sharing the Lightsail CPU budget, rather than JavaScript executing on the event loop. Film compilation can compete for CPU and increase the effective S. This run does not establish film capacity or prove ffmpeg is the current bottleneck. |

A second API host behind a load balancer ideally halves the per-host arrival rate. The table models R = L + S/(1−λS/2) and uses the same user think time. Its service-center ceiling becomes {2/S:.1f} req/s if database time and fixed delay do not change. Balance authenticated requests across the hosts; shared durable sessions are in PostgreSQL, but media capabilities are in-memory and staged media is local, so routing affinity or shared state/storage is required. Multiple scheduler/worker instances also need coordinated job ownership. CloudFront remains the edge; PostgreSQL and S3 remain shared services.

Separate the media worker to reserve API CPU and isolate compilation bursts. Keep durable job claims and retry semantics. This reduces contention when films compile, but leaves synchronous database calls on the API path; converting that path to asynchronous persistence and an appropriately bounded connection pool addresses the serialization mechanism. No infrastructure or production configuration was changed for this test.

## Presentation assets and repeatability

- `charts/latency-vs-vus.png`: observed p50/p95/p99 against the two-second target.
- `charts/throughput-vs-vus.png`: observed request throughput.
- `charts/measured-vs-projected.png`: measured API means and projected one/two-host means.
- `results/hosted.json`: raw formal observations, setup health, stage and operation summaries.
- `results/capacity-model.json`: calibration points, fitted parameters, projections and sensitivity.
- `METHODOLOGY.md`: journeys, profile, acceptance rules and rerun command.

Regenerate charts and tables with `python scripts/load/analyze.py /absolute/path/to/load-test` after installing numpy and matplotlib. All chart files are 1280×720 PNGs. The PR adds a manual performance workflow; it does not deploy or merge anything.
'''
incident_path = root/'results/incident.json'
if incident_path.exists():
    incident = json.loads(incident_path.read_text())
    text += f"""
## Deployment overlap

The initial run's 339 failures occurred from {incident['firstError']} to {incident['lastError']}. [Dev deployment 40341542790](https://github.com/Collaboration95/rewind-app/actions/runs/40341542790) installed the release from 14:45:06–14:46:30 UTC and passed public health at 14:46:30–14:46:31 UTC. The error interval falls within that installation step. Deployment interference is the leading explanation; the request timings alone do not establish CPU saturation. The original failed stage remains in every acceptance statistic and in the incident-influenced capacity scenario.
"""
confirmation_path = root/'results/post-deploy-100vu.json'
if confirmation_path.exists():
    confirmation = json.loads(confirmation_path.read_text())
    c = next(s for s in confirmation['stages'] if s['phase']=='steady')
    text += f"""
## Post-deployment read-only confirmation

A separate three-minute 100-VU confirmation reused the same sessions and group after deployment. It sent no chat writes or uploads; the chat-send slot became a chat read. Keep this read-only result separate from the initial 95% read / 5% chat-write mix.

| VUs | Requests measured | p50 ms measured | p95 ms measured | p99 ms measured | req/s measured | Errors measured | Result |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 100 | {c['requests']} | {c['p50Ms']:.1f} | {c['p95Ms']:.1f} | {c['p99Ms']:.1f} | {c['throughputRps']:.2f} | {c['errors']} ({100*c['errorRate']:.2f}%) | {'PASS' if confirmation['passed'] else 'FAIL'} |

The initial mixed-workload run remains FAIL. This confirmation establishes the read-only result after deployment and does not validate the projected 250–1,000-user populations.
"""
(root/'RESULTS.md').write_text(text)
print(json.dumps({"passed":report['passed'],"serviceDemandMsProjected":S*1000,"fixedDelayMsProjected":L*1000,"ceilingRpsProjected":1/S,"kneeUsersProjected":practical_users,"projections":projections},indent=2))
