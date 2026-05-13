# Contributing to Vigil

Thanks for your interest. Contributions are welcome — bug fixes, new rules, improvements to the deploy or AI logic.

## Getting started

```bash
git clone https://github.com/yourorg/vigilops
cd vigilops
npm install
cp .env.example .env  # fill in your values
npm run dev
```

## Project structure

```
src/
  collector/      — gathers system snapshot (Docker, disk, memory, nginx, HTTP)
  rules/          — rule engine + rules config (if-this-then-that)
  ai/             — Claude API escalation, called only when rules don't match
  executor/       — runs shell commands, enforces safety allowlist
  deploy/         — deploy config + pull/up/health-check/rollback logic
  webhook/        — Express server for CI/CD webhook triggers
  telegram/       — bot commands and notification helpers
  logger/         — append-only audit log
  types/          — shared TypeScript types
  index.ts        — main polling loop
```

## Adding a new rule

All rules live in `src/rules/rules.config.ts`. Each rule is a `condition` + `action` pair:

```typescript
{
  id: 'your-rule-id',
  description: 'What this rule does',
  condition: (snapshot, history) => {
    // return true when this rule should fire
    return snapshot.disk.usedPercent > 95;
  },
  action: (snapshot) => ({
    tier: 'auto',       // 'auto' | 'suggest' | 'alert'
    ruleId: 'your-rule-id',
    commands: ['docker system prune -f'],
    message: 'Disk critical — running full prune',
  }),
},
```

No other files need to change.

## Adding a new executor command

If your rule needs a command that isn't in the allowlist, add a regex to `src/executor/index.ts`:

```typescript
const ALLOWED_COMMANDS: RegExp[] = [
  // existing patterns...
  /^your safe command pattern$/,
];
```

Be conservative. The allowlist exists for a reason.

## Pull requests

- Keep PRs focused — one thing per PR
- Add a clear description of what changed and why
- Don't modify the safety allowlist without a strong reason

## Issues

Bug reports and feature requests are welcome via GitHub Issues.
