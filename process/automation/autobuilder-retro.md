# Autobuilder pilot retro — 2026-07-13

The pre-flight's own last box: *"After E-3 merges: disable the routine and
run the pilot retro (did this beat doing it by hand?)."* E-3 merged
2026-07-12; this is that retro.

## Verdict

**The cloud autobuilder never ran. Kill the routine.** Zero `autobuild`-
labelled PRs, zero `autobuild-blocked` issues, zero `autobuild/*` branches
ever existed; the routine was created disabled on 2026-07-08 and its
five-step pre-flight was never completed. Both scoped deliverables (E-2,
E-3) shipped through other flows before the pilot could earn a first
supervised run. `autobuilder.md` stays in the repo as a design artifact
(status note added), because the design itself reviewed well and the
reasons it lost are the useful output.

## What actually happened (all times Sydney)

| When | Event |
|---|---|
| 07-08 evening | Pilot designed (3-reviewer panel), prompt doc PR #18 opened, cloud routine created **disabled** pending pre-flight |
| 07-10 ~09:00–14:09 | **E-2 built and merged interactively in one session** (PR #20) — design panel, 9-task SDD, differential review, merge |
| 07-10 14:13 | PR #18 (the autobuilder prompt itself) merges — **four minutes after the pilot's first deliverable was already done** |
| 07-10 23:25 → 07-11 00:58 | **E-3 core built overnight — but as a local autonomous session on Jackson's machine**, not the cloud routine: ~93 unattended minutes landed normalization → differ → hostile baseline loader → drift classifier → CLI extraction → compare-by-default gate on the feature branch |
| 07-12 | Interactive session finishes E-3 (T9–T12), runs the review gates, merges PR #21 |
| 07-13 | E-4 + Week-3 docs close (both interactive); scope the pilot was fenced to is exhausted |

The prompt's own scope-exhaustion rule ("if E-2 and E-3 are both merged,
print scope exhausted — disable the routine") was satisfied by reality
before the routine ever woke up.

## Did it beat doing it by hand?

- **Cloud pilot: never tested — and lost structurally, not accidentally.**
  The pre-flight required a second platform's setup (GitHub App
  least-privilege, sandbox secret audit, supervised first run) while the
  deliverables it was scoped to shipped interactively within two days of
  the design. At this repo's current velocity, setup latency exceeded
  time-to-deliverable, so completing the pre-flight was never the rational
  next action. A pilot fenced to work you are about to do anyway loses the
  race by construction; it should have been fenced to work that would
  otherwise NOT get done (backlog LOWs, doc drift sweeps).
- **Local overnight run: a qualified yes.** ~93 unattended minutes landed
  the E-3 core — roughly a session's worth of mechanical TDD executed
  while asleep, on zero new infrastructure, because the local machine
  already had the trust boundary the cloud sandbox was designed to
  construct (key custody, branch protection, review gates, git identity).
  The qualification is the review-debt tail: the 07-12 `/review3` found
  **two CRITICALs in the overnight code** — a repo-committed-symlink
  arbitrary-file overwrite in `--update-baseline`'s tmp-path write
  (live-reproduced), and the T9 baseline never actually landing (the
  commit message claimed the task; the commit contained one of its three
  files), which left CI's gate step deterministically red. Cleaning that
  up consumed part of the 07-12 session. Net positive, but not free.

## Lessons

1. **Setup latency must beat time-to-deliverable, or the pilot loses by
   construction.** Fence automation pilots to work that won't otherwise
   happen, not to the top of the active queue.
2. **The cheapest trust boundary is the one that already exists.** Local
   auto-mode captured most of the pilot's intended value with none of its
   pre-flight, because every control the cloud design had to specify
   (no-self-merge, review gates, secret custody) was already in force
   locally.
3. **Unattended output is untrusted input until the interactive review
   gates run.** The pilot's design said this; the local run proved it
   empirically (two CRITICALs and a half-landed task inside otherwise
   good overnight work). This rule — not the cloud sandbox — turned out
   to be the load-bearing safety property, and it is portable to any
   unattended flow.
4. **Monitoring-shaped cloud automation stuck; building-shaped didn't.**
   The nightly report-only repo-check routine (live since 07-08) survives
   this retro untouched: it has no merge authority, no review-debt tail,
   and its value doesn't depend on beating an interactive session to a
   deliverable.
5. **Commit messages lie by omission** (T9) — already in the lessons file
   from the E-3 close; the overnight context is *why* it bit: nobody was
   awake to notice the claim/content gap at commit time.

## Disposition

- Cloud routine `trig_01HXT4ab1C6r5iT7oFANFQrW`: **delete** (never
  enabled; scope exhausted; superseded by the local-overnight pattern).
- `process/automation/autobuilder.md`: **retained, marked retired** — the
  design and its panel review are portfolio artifacts; the PR-state-machine
  and stop-condition patterns are reusable if a future pilot is fenced to
  otherwise-undone work.
- Nightly report-only routine: **keep** (different shape, earning its keep).
- Local overnight autonomous runs: **keep as a supported pattern**, with
  lesson 3 as a standing rule: nothing unattended merges before the
  interactive review gates run on it.
