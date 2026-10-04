# Demo beat: "Weft was built under Weft"

Since 2026-10-04 00:23 (-03) every Hermes kanban worker building Weft runs the Weft Hermes adapter
(`packages/adapters/hermes`, card B16). Each edit a worker makes under `~/github/weft` (any
worktree) or `~/code/hermes-ios/.worktrees/weft-feed` becomes an event in repo `weft` on the
deployed weft-gateway. Diagnostics go back into that worker's tool results. The same log is what
the Hérmes iOS "Changes" feed shows (card I1). So from that moment on, the build's own change log
is a Weft log you can watch from the phone.

## The first collision (real kanban workers, not a script)

Two throwaway cards on the `weft` board (`t_f81b1eaa` "B16-verify-A", `t_22254bac`
"B16-verify-B") were dispatched at the same time. Each one wrote `builtUnderWeft()` in
`demo/dogfood/built-under-weft.ts` in its own worktree, waited, and then edited it again. This is
the log of repo `weft`, read through the observer API (`GET /v1/repos/weft/events`):

```
#3  accepted join       hermes-default/t_f81b1eaa  hermes-default joined (hermes, L3)
#4  accepted join       hermes-default/t_22254bac  hermes-default joined (hermes, L3)
#5  accepted edit       hermes-default/t_f81b1eaa  hermes-default added builtUnderWeft in demo/dogfood/built-under-weft.ts — B16-verify-A: …
#6  accepted edit       hermes-default/t_22254bac  hermes-default added builtUnderWeft in demo/dogfood/built-under-weft.ts — B16-verify-B: …  [warning claim_wait …#builtUnderWeft]
#8  accepted edit       hermes-default/t_f81b1eaa  hermes-default edited builtUnderWeft in …  [info claim_contended]
#9  accepted checkpoint hermes-default/t_f81b1eaa  hermes-default pushed checkpoint e186d42 — B16-verify-A: …
#10 accepted leave      hermes-default/t_f81b1eaa  hermes-default left — hermes process exit
#11 accepted edit       hermes-default/t_22254bac  hermes-default edited builtUnderWeft in …  [warning claim_wait]
#12 accepted checkpoint hermes-default/t_22254bac  hermes-default pushed checkpoint 7250175 — B16-verify-B: …
```

Interleaved records (#1, #2, #7) are the PM cron's own checkpoints on `main`. The PM is also
under Weft.

Card B's own completion report (verbatim, from its kanban handoff) shows what the model saw in its
tool results:

```
[weft warning] claim_wait demo/dogfood/built-under-weft.ts#builtUnderWeft: … is being edited by
hermes-default (hermes-default/t_f81b1eaa), which has precedence. (caused by hermes-default · task
t_f81b1eaa · event #5). Suggestion: Wait for hermes-default to land or release …, work elsewhere,
or negotiate (negotiate.propose to hermes-default). Options: retreat | wait | negotiate | escalate.

[weft error] claim_wounded demo/dogfood/built-under-weft.ts#builtUnderWeft: hermes-default
(hermes-default/t_f81b1eaa) has precedence on … and took it over; your claim was revoked. (caused
by hermes-default · task t_f81b1eaa · event #8). …
```

B acted on it without being told how. It waited for A to finish, re-edited the symbol (which
cleared its open error, so its completion gate opened), and committed. Card A got only `info`
lines. The asymmetry guarantee (spec §7.2) held: exactly one side was told to yield.

## How to show it in the video

1. Open the Hérmes Changes feed on the phone, filtered to repo `weft`.
2. Cut to the kanban board: two cards running.
3. Show the B worker's transcript with the `weft_diagnostics` block in its tool result.
4. Back to the phone: `#6 … [claim_wait]`, then B's rework at `#11`.

Line for the voice-over: "Every line of this project was written by agents under Weft. This is
its own change log."

## Reproduce

- Two cards: copy the bodies of `t_f81b1eaa` / `t_22254bac` (same function, different strings).
- Scripted (no kanban): `python3 packages/adapters/hermes/scripts/verify_live.py` plays the same
  collision, and also the `stale_assumption` block across files, against a throwaway
  `smoke-hermes-*` repo.
- Log: `GET /v1/repos/weft/events?tail=1&limit=50` with an observer token
  (`~/.config/weft/observer-all-token`, repos `*`).
