# Security

## Reporting a vulnerability

Report vulnerabilities **privately** to the repository owner's team: use GitHub's "Report a
vulnerability" button under the Security tab, or contact the maintainers directly. **Do not open
a public issue**, and do not post details in pull requests or discussions until a fix is out.

Please include what is affected (file, route or feature), the commit you tested, how to reproduce
it, and what an attacker could do. We aim to acknowledge reports within a few working days and
will tell you when a fix ships.

## Scope notes

- The hive's safety layer (policy gate, approvals, capability tokens, sandbox, budgets,
  visibility) is described in `docs/theory/governance-and-gating.md`, including its known gaps:
  the mind sandbox is opt-in (`HIVE_MIND_SANDBOX=1`), and the Docker driver uses host networking
  by default. Reports in these areas are especially welcome.
- Closed folders and closed repositories are in scope too; report them the same way.

## Secrets

Never commit secrets: `.env*` files, API keys, OAuth client secrets, admin passwords, worker
tokens, or session and sign-in files. Configure them through the environment; see
`deploy/hive.env.example` for the variable names.
