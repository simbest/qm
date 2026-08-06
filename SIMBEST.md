# simbest

This repository is a **private fork** of `yc-software/qm` (a plain clone, not a GitHub fork).

The simbest-specific development workflow — branch strategy, the daily
edit → check → commit loop, upstream sync procedure, safety rails, and the AI
decision tree — lives in
[`deploy/layers/simbest/WORKFLOW.md`](./deploy/layers/simbest/WORKFLOW.md).

Core (everything outside `deploy/layers/simbest/`) stays byte-identical to
upstream. The general private-fork rules live in `AGENTS.md` → "Private forks",
which upstream maintains and this fork syncs with the `update-qm` skill.
