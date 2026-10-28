# VM Policy Organ

`omegaclaw.immune.vm-policy` is an immune/habitat boundary organ.

It follows the principle that an agent can have broad agency inside its own VM
body while external exits are named, observable, and policy-gated. This module
does not replace cognition and does not hardcode behavioral rules into the
mind. It exposes boundary facts the agent can reason over.

The first version is deliberately audit-first:

- `vm-policy-status` shows containment state.
- `vm-policy-exits` names required exits.
- `vm-policy-atoms` returns symbolic MeTTa facts for exits, risks, and mode.
- `vm-policy-connections` returns live connection observations as atoms.
- `vm-policy-metrics` returns runtime metrics as atoms.
- `vm-policy-audit` reports boundary risks.
- `vm-policy-enforcement-plan` prints a cautious deny-by-default plan for review.
- `vm-policy-maintenance-window` traces a requested temporary exit window.
- `vm-policy-record-exit` records allowed/blocked/approved/rejected/temporary
  exit evidence without changing firewall state.
- `vm-policy-exit-history` and `vm-policy-exit-summary` return recent exit
  evidence as symbolic atoms for later reasoning.

Actual firewall enforcement should be applied only after reviewing the plan on
the live deployment, because messaging, model calls, Home Assistant, SSH, and
Cloudflare all depend on network access. Web search is treated as an allowed
ongoing cognition/perception exit, while still remaining observable because
queries can reveal intent or private context.
