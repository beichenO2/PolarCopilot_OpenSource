# PolarCopilot runtime governance design

## Goal

Make PolarPort (`127.0.0.1:11050`) the sole port authority and PolarProcess
(`127.0.0.1:11055`) the sole lifecycle authority for the PolarCopilot Hub and
Web development server.

## Existing-service boundary

This is an in-place migration of the existing service IDs:

| Service | Preferred port | Auto-start | Migration rule |
|---|---:|---:|---|
| `polarcop-hub` | 8040 | true | Preserve the live PID; registration only, no lifecycle action |
| `polarcop-web-dev` | 5180 | false | Register in place, then normalize the stale `starting` state with an exact stop action |

No second service IDs are introduced. Both services use PolarProcess
foreground-command mode (`start_script_dir: "-"`).

## Launch contract

- `Start/hub.sh` checks PolarPort health, claims 8040 as `polarcop-hub`, rejects
  any different assignment, and foreground-execs the Hub.
- `Start/web-dev.sh` applies the same contract for `polarcop-web-dev` on 5180.
- Neither launcher backgrounds, writes PID files, or sends process signals.
- `scripts/register-runtime.sh` updates the two PolarProcess records without
  starting or restarting either service.

The Hub's internal duplicate-instance lookup reads PolarPort `/api/list` rather
than the retired SOTAgent port endpoint. A failed SDK claim is fatal; an
environment variable may express a preferred port but may never bypass
PolarPort.

## Safety and verification

The migration first records the live PID and port owner, then runs only
transient tests and builds. After registration, it verifies that Hub PID 13289
and the PolarPort 8040 owner are unchanged. The stopped Web Dev service remains
stopped and port 5180 remains unbound.

