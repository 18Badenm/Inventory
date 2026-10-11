# Team iteration / 团队迭代

Use one Issue → one branch → one PR for each reviewable UX iteration.
The PR is the shared review surface; its latest commit, screenshots, walkthrough,
CI receipt and next owner must describe the same revision.

1. Open **New issue → UX iteration / 体验迭代** with the exact reference and acceptance steps.
2. Start from the current integration branch; the current repository default is `claude/funny-gauss-ekilg7`.
3. Make a small branch such as `ux/42-scan-review` (`codex/…` for agent-created branches).
4. Copy `docs/iterations/_TEMPLATE.md` to `docs/iterations/UX-<issue-number>.md`.
5. Open a draft PR early. Every push updates that PR and runs **Iteration checks**.
6. Attach the latest before/after screens and flow recording. Request a UX review and an integration review.
7. Merge only after the current revision passes its checks and reviewers accept the stated scope.

See [the full workflow and one-time owner setup](docs/TEAM_WORKFLOW.md) and
[the iteration index](docs/iterations/README.md).

CI does not call paid models, publish listings, deploy, or certify visual fidelity.
Do not commit `.env`, real household photos without permission, database files, or unrelated work.
