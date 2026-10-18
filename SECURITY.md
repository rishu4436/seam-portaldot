# Security policy

## Reporting a vulnerability

Please report privately. **Do not open a public issue or pull request for a security problem.**

Use GitHub's private vulnerability reporting for this repository: open
<https://github.com/rishu4436/seam-portaldot/security/advisories/new> (Security tab, "Report a vulnerability").
Only the maintainers can see the advisory. Include what you found, the commit you tested, and steps or a failing test that reproduces it.

This project is a hackathon-stage project and has no paid bounty and no guaranteed response time. We aim to acknowledge a report within a
few days and will credit you in the advisory if you wish. If private advisories are unavailable to you, open a public issue that says
only "I have a security report, please enable a private channel", with no details.

## Supported versions

SEAM is pre-release. Only the current `main` branch is supported. Packages are version `0.1.0` and marked `private`; nothing is published to npm.

## Scope

In scope: the compiler, policy, SDK/CLI and chain packages in this repository, in particular anything that could make SEAM send a
transaction that was not approved, accept a forged receipt as proof, hide a failed or unproven step as success, or leak key material.

Out of scope: the Portaldot chain and its runtimes, wallets and wallet extensions, third-party dependencies (report those upstream),
and the recorded demo console, which uses recorded or synthetic data and sends nothing.

## What SEAM does and does not prove

See [docs/SECURITY_GATES.md](docs/SECURITY_GATES.md) for what each gate proves and does not. Two points that matter for reports:
offline `seam verify` checks receipt integrity only (it is not on-chain proof), and no result on the Portaldot V3 runtime or Revive
has been verified. Keys are never held by SEAM; do not put seeds or private keys in issues, tests or evidence files.
