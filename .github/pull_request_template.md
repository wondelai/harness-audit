## Summary

- What changed and why:

## Verification

| Check | Command | Result |
| --- | --- | --- |
| Gate | `npm run verify` | |
| On real repositories | `node dist/cli.js <repo>` on at least two, one of them not TypeScript | |

## Risk

- [ ] No check can report a finding from a gitignored file
- [ ] No evidence line prints a secret value
- [ ] A changed threshold or cap is mirrored in the README table
- [ ] Every new user-facing string has `en` and `pl`
