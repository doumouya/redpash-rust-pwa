---
title: Push policy
section: Internal
order: 53
last modified date: 2026-05-24
owner: Torv
status: stub
---

# Push policy

> **TODO (Torv).** Formalise the rule established 2026-05-21 — captured initially as a feedback memory `[[feedback_push_policy]]`.

The rule: agents commit on `prerelease` but do NOT push. Em confirms,
then Torv (sole designated pusher) pushes.

To cover:

- **Why**: avoid origin-state surprise when multiple agents land work in the same shared tree
- **The "ready to push" signal**: Em says so on the board OR replies "good" / "yes push" to a status post
- **What happens when other agents have unpushed commits in the shared tree**: Torv's push carries them too (this is the *point* — atomic origin update)
- **Force-push posture**: never to `main`/`master`; rare otherwise; always Em's explicit OK
- **Per-contributor branches**: retired 2026-05-21; single shared `prerelease` is the rule
- **Hooks (`--no-verify`)**: never skip unless Em explicitly asks
