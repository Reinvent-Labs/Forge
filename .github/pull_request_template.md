## Summary

<!-- Describe what changed and why. Include any relevant context, links to issues,
     or design decisions that reviewers should understand. -->

Closes #<!-- issue number -->

## Type of change

<!-- Check all that apply by replacing [ ] with [x] -->

- [ ] Bug fix (non-breaking change that resolves an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to behave differently)
- [ ] Refactor (code restructuring with no functional change)
- [ ] Performance improvement
- [ ] Documentation update
- [ ] CI / tooling / infrastructure change

## Test plan

<!-- Describe how you tested this change. Be specific enough that another engineer
     could reproduce your verification steps. -->

- [ ] Unit tests added / updated
- [ ] Integration tests added / updated
- [ ] Manually tested locally — steps:
  1.
  2.

## Screenshots

<!-- If this PR includes UI changes, add before/after screenshots or a short screen recording.
     Delete this section if not applicable. -->

| Before | After |
|--------|-------|
|        |       |

## Checklist

<!-- All boxes should be checked before requesting review. -->

- [ ] `npx turbo typecheck` passes with no errors
- [ ] `npx turbo test` passes with no failures
- [ ] `npx turbo lint` passes with no warnings (or warnings are explained)
- [ ] No `console.log` / debug statements left in production code
- [ ] Environment variables added to `.env.example` if new ones were introduced
- [ ] Documentation / JSDoc comments updated for any new public APIs
- [ ] CODEOWNERS notified if files outside my usual scope were modified
- [ ] No sensitive data (tokens, passwords, PII) committed
