# Security Policy

VigilOps runs with root access and a Docker socket on production servers. We take
reports about it seriously, and we would rather hear about a problem early and
awkwardly than late and publicly.

## Reporting a vulnerability

Email **security@vigilops.cloud**.

**Please don't open a public issue, pull request or discussion for a security
bug.** A public report tells everyone running VigilOps about the problem at the
same moment it tells us, and they can't patch until we ship a fix.

Useful things to include, as far as you have them:

- What an attacker can do, and what access they need to start
- The affected version (`vigil version`) and whether it's self-hosted or connected to VigilOps Cloud
- Steps to reproduce, or a proof of concept
- Anything you think we'll get wrong about the severity

## What we commit to

| | |
|---|---|
| First response | Within **48 hours**, from a person, not an autoresponder |
| Assessment | Our read on severity and a rough fix timeline, within 5 working days |
| Updates | At least weekly until it's resolved |
| Credit | Named in the release notes, unless you'd rather not be |
| Disclosure | We publish the details once a fixed release is out and users have had a reasonable chance to update |

If we disagree with your severity assessment, we'll say so and explain why
rather than quietly downgrading it.

## Scope

In scope: the agent (`src/`, `install.sh`, the published Docker image), and
VigilOps Cloud (`website/`, `vigilops.cloud`, the dashboard and the agent API).

Out of scope: findings that need an attacker to already have root on the server
VigilOps runs on (at that point they don't need VigilOps), reports from
automated scanners with no demonstrated impact, and missing hardening headers on
the marketing site with no exploit path.

We don't run a paid bug bounty. We're a small team and we'll be honest about
that rather than imply a reward that isn't coming.

## Supported versions

Security fixes go to the latest release. If you're running the published image
with `VIGIL_TAG=latest`, `vigil update` picks them up. Older tags are not
backported.
