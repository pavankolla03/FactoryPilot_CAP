---
name: day-feature-pr
description: >-
  Execute a FactoryPilot four-week plan day: branch naming, checklist, PR body,
  CHANGELOG update, and smoke notes. Use when starting or finishing a plan day.
---

# Skill: Day feature PR

1. Confirm day number in `docs/architecture/Four_Week_Delivery_Plan.md`.
2. Branch: `feature/NNN-short-name` (NNN matches plan).
3. Complete AM then PM checklists; mark blockers explicitly.
4. Update `CHANGELOG.md` [Unreleased].
5. Open PR to `main` with test plan; squash-merge when CI green.
6. Note Hub smoke result if S/4 path touched.
