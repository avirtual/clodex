# Clodex as a plugin core — product-design brainstorm

> Status: **brainstorm, not a plan.** Captured 2026-07 from a long design
> conversation (Bogdan + lead). No code, no commitment, no timeline. This is
> the durable record so the thesis survives compaction. It is product thinking,
> not architecture-of-record — `docs/architecture.md` remains the truth about
> what exists today.

## The trigger

Two real conversations, days apart:

1. **Eugen (a competent dev friend), on auto-compact:** it fired at 27% context
   "de nicaieri," mid-task, and he had no idea *why*. Bogdan spent ~10 minutes
   being Eugen's settings panel over WhatsApp (two compact modes, the +100k
   cold-guard, the 15% soft-suggestion, "Settings › Intents, remove the compact
   intent"). **The compact wasn't the bug — its unattributed, unexplained
   firing was.** Every *automatic* action the app takes should carry its own
   "why did this happen + how to turn it off," inline, at the moment it happens.
   The cost optimizer is correct; it's just invisible, and invisible +
   spontaneous reads as "porcul face compact in mijlocul distracției."

2. **Eugen, on scope:** offered remote agents / docker / one-command
   ec2·k8s·fargate, he recoiled harder each time — *"pe clodex? nu vreau
   nebunii, vreau sa ma pot uita din cand in cand la ce se intampla prin spate.
   eniuei."* And later: *"nu sunt tipul"* who deploys to Fargate. Then, asked if
   he'd used the file popover or workbench — **he didn't know they existed.**

## What Eugen is actually saying (the three distinct signals)

- **"pe clodex?" is an identity collision, not a preference.** In his head
  clodex = *a viewer where agents chat and show me a pretty status bar.* That's
  a complete, coherent product. Learning the same name also means deployable
  agent infrastructure invalidated his mental model, and he noped out. Same
  name, five different things → the product lost its single answer to "what is
  this." That's a **coherence** problem, worse than a density problem: you can
  curate density away; an identity fracture lingers under every hidden toggle.

- **"nu sunt tipul" is about *him*, not the tool.** The product implicitly cast
  him in the maximal role (someone who might deploy to Fargate) and he had to
  *actively refuse it* three times to get back to what he wanted. He doesn't
  want the scary parts **hidden** — hidden means still his, behind a door, his
  responsibility not to open. He wants them to **never have been part of the
  deal.** The difference between "advanced features collapsed by default" and
  "this is a viewer, full stop" is a power tool with a child-lock vs. a
  genuinely simpler tool. A child-lock still says *you could hurt yourself
  here.*

- **Not knowing file-popover/workbench exist = density past self-description.**
  Overwhelm is "I see too much." This is worse: the product is so dense it can
  no longer *show* a competent user its own good parts. The features aren't
  overwhelming him — they're **invisible.**

## The thesis: clodex is a core + a public plugin API

**wb-wrap was the core all along.** Wrapped agents, IPC, `dm`, a status bar —
the minimal seed clodex started from is *exactly* the "Eugen product." Two years
of features (peering, wirescope, deploy, workbench) weren't scope-creep away
from that seed — they were mods built *into the engine because there was no mod
API yet.* The core was never wrong; power-features just had nowhere to live
except inside it.

### The Minecraft frame (validates specific decisions, not just vibe)

- **Vanilla is a complete, shippable game.** Most players never install a mod
  and feel zero lack. → Core is Eugen's **whole** product, not a stripped tier.
- **Modded is a different game on the same engine.** → Bogdan's orchestrator
  clodex and Eugen's viewer clodex, one codebase, different experiences. "pe
  clodex?" — yes, same clodex, and that's *fine*, because vanilla players never
  see the modded surface.
- **The mod API (Forge/Fabric) is the load-bearing public contract.** → The
  extension-point taxonomy, treated as a published API.
- **Modpacks = curated bundles of mods.** → Personas. "Eugen mode" and "Bogdan
  mode" are modpacks, not different Minecrafts.
- **The community makes 100× what the core team could;** Mojang's job became
  *protecting the engine and the API.* → The suggestion box stops being the
  backlog. "Show git branches in the sidebar?" → "here's the sidebar seam."
  **Your job shrinks to the two things only you can do: keep the core coherent,
  and keep the API a promise.** Everything else becomes someone's plugin. That's
  the only way a tiny team outruns its own feature surface.

## Why bother — the funnel / user-base case

This is the commercial motivation, not just tidiness. **Every Eugen who recoils
at "pe clodex?" is a user you *had* and lost to your own surface.** The plugin
model is a funnel fix: vanilla clodex (wrapped agents, dm, pretty status bar) is
a product a *far* larger population says yes to, because they can hold it in
their head. The orchestrator power-user is a small, deep market; the "watch my
agents in a nice window" user is a wide, shallow one. **Same engine serves both —
but only if the wide market never has to see, refuse, or even know about the
deep market's features.** That's the commercial translation of "nu sunt tipul":
you don't grow the base by adding features, only by making the *entry* product
complete and coherent on its own. Minecraft sold ~300M copies on vanilla; the
mods kept the deep end loyal. Same shape. (Caveat that surfaced the point: we
don't know what version Eugen runs, so we can't audit whether *his* build
already explains its auto-actions — which is exactly why self-attribution has to
be a standing invariant, not a one-off patch.)

## Core vs. plugin — where the line falls

- **Core** = what makes a wrapped agent legible and alive, and **nothing about
  what the agent can *reach*.** Spawning/wrapping the PTY, session lifecycle,
  sidebar + status bar, and **local** `[agent:dm]`/`[agent:who]` messaging
  between agents on this machine. That's Eugen's whole, self-complete,
  *nameable* world.
- **The tell:** the moment a message can leave the machine, you've crossed out
  of core. Local dm = core. Remote dm, `name@peer`, tunnels, tokens = peering
  **plugin.** The status bar is core; what wirescope *overlays on it* is a
  plugin.
- **Plugin** = a JS module conforming to the public host API. It may (a) add
  surfaces (workbench's editor) and/or (b) extend core surfaces (wirescope →
  status bar, peering → dm grammar + intent set).

## The load-bearing design question: the extension-point taxonomy

This is the **one-way door.** Core exposes a small set of **named extension
points** and plugins register against them. That list *is* the plugin API.
Candidates: **status bar, sidebar, intent grammar (prompt line + execution
handler), session menu, settings.** Get it right and everything slots in. Get it
wrong (each plugin pokes core in a bespoke way) and you've renamed today's mess.

**It is a *published, versioned* contract, not an internal detail** — because
first-party plugins (wirescope, peering) and third-party ones (the git-branches
suggestion already on the repo) must build against the **identical** surface. If
your own plugins get a privileged path and a stranger's gets a lesser API, you
don't have a plugin protocol — you have a core with hardcoded friends. The
discipline that keeps it honest: **build wirescope-js and peering-js against the
same public host API you'd hand a stranger.** No backdoor.

## The seam realization (the load-bearing insight)

**A plugin's JS half owns its own coupling; core defines only the
core↔plugin contract, never the plugin↔backend wire.**

Today the "where to connect / what to pull / what settings to add" knowledge for
wirescope lives *in core* — that's what makes wirescope a *feature* instead of a
*plugin*. Move it: `wirescope-js` (the in-process half) becomes the only thing
in the JS world that knows wirescope exists. It's the **adapter** — core's
extension-point vocabulary on one side, wirescope's private protocol to its
Python engine on the other.

```
core ──(host API, the ONE contract)── wirescope-js ──(wirescope's private wire)── wirescope-python
     ──(host API, same contract)───── workbench-js  ──(no backend; fully in-process)
     ──(host API, same contract)───── peering-js    ──(clodexctl / ssh / ssm, its private business)
```

Every plugin is "a JS module conforming to the host API." Whether it has a
backend, and how it talks to it, is **invisible to core.** So you do **not** need
to design a universal clodex↔backend protocol — you need exactly **one**:
core↔JS-plugin. Each plugin brings its own bridge to its own backend, in its own
shape.

**The coupling doesn't vanish — it relocates,** into a file shipped/versioned/
removed *with* the plugin, instead of scarred into core. Enable = load the
plugin's JS. Disable = don't. **Core never learns the word "wirescope."** That's
the definition of a plugin.

Two exports must both happen or neither works:
1. Coupling exports **out of core into the plugin** (detachment).
2. The host API exports **out of clodex to the world** — a documented surface a
   stranger writes against (BYO). (1) alone is just internal tidiness; only
   *you* could write plugins. The git-branches case forces (2): it's the first
   plugin whose author won't PR into core.

## Feasibility (the "is this even possible" answer: yes)

It's the LSP / DAP / MCP / VS Code extension shape — a decade-proven pattern,
not a research bet. And clodex is unusually pre-adapted:

- **Visual insertion:** `contextIsolation:false` + `nodeIntegration:true` lets
  the renderer `require()` a plugin module that touches the DOM via
  `statusBar.register(...)` / `sidebar.addPanel(...)`.
- **Intents, both halves:** the prompt grammar line is *pure data* — a plugin
  adds an entry to the list `buildIpcPrompt` renders. **T58 already made that
  list conditional/per-seat — the first brick of plugin-contributed grammar,
  shipped.** The execution half is a JS handler the plugin registers in the
  intent-dispatch table.
- **Out-of-process / other languages (Python wirescope):** Python can't inject
  into Node — full stop. It runs as a separate process speaking a protocol; a
  thin JS host-shim mediates. **This loop already exists** as `[agent:exec]` +
  the wirescope proxy: intent scanned in core, work happens out-of-process,
  result injected back. You'd generalize a pattern you already run.

### The liveness / trust table (also the sandbox boundary — free payoff)

| | Live enable | Clean live disable | Power | Trust |
|---|---|---|---|---|
| **In-process JS** | yes | **no** (Node can't truly unload a module → restart boundary) | full (DOM + code) | full app access — **first-party only** |
| **Out-of-process protocol** | yes | **yes** (killing the process *is* teardown) | declarative + webview | the process boundary **is** the sandbox — safe for **BYO/untrusted** |

The inversion worth remembering: the *harder-sounding* cross-language tier is
the one that gives **clean live plug/unplug**, and it doubles as the trust
boundary — curated/first-party in-process (fast, full-power); community/BYO
out-of-process (the process sandboxes them; you never run a stranger's code in
your process). "Live plugging" for in-process JS realistically means
**`npm install && npm start`** for clean removal; live-*enable* is fine.

### Genuinely impossible (don't chase)

1. Python contributing in-process execution code to Node — no; always separate
   process + protocol.
2. Clean live-unload of an in-process JS plugin — effectively no; restart
   boundary is the honest answer.
3. A cross-language plugin drawing arbitrary DOM directly — no; it *declares* UI
   or serves a webview.
4. `vm`-sandboxed eval as a security boundary — a *false* boundary; the real one
   is the process.

## Personas / settings (how overwhelm dissolves by consent, not hiding)

A **persona = a named default bundle of enabled plugins + settings** (a
modpack). "Eugen mode": peering/remote/deploy off, auto-compact on-but-loud,
minimal sidebar. "Bogdan mode": everything.

**The settings argument is the cleanest case for the whole thesis.** Today's
"million checkboxes" exist because settings are organized **by feature, but the
user never chose the features** — every feature ships on, so its config is just
*there*. The plugin model flips the axis: **settings are organized by plugin,
and you chose the plugins.** Every setting you see is config for something you
*deliberately enabled.* The wall of checkboxes doesn't get *hidden* — it stops
*existing* for you. Overwhelm's **cause** is removed, not its symptom: you can
only be overwhelmed by settings for things you chose, and you chose them.

This composes with the *invisibility* problem too: a plugin can announce itself
on enable ("Workbench added — edit files with…"). **You enabled it, so it gets
to introduce itself; you didn't, so it never shows up.** Discoverability and
overwhelm turn out to be the same problem solved by the same seam:
**consent-scoped surface.**

## Two principles worth banking even if the architecture waits

1. **Auto-actions must be self-attributing — and must break the stale prior,
   not just explain themselves.** Any action the app takes *unprompted*
   (compact, cost-guard, anything automatic) must carry, inline at the event,
   *why it fired* and *how to disable it.* Ships anytime, needs no plugin
   system, highest-leverage anti-overwhelm move.

   **The deeper reason (the real adversary is outdated priors).** Eugen reacted
   to a compact at 27% context as an *attack* — "my context was only 27%!" His
   mental model is the chat-app one: context is a fixed container you fill to
   ~80% before worrying; using less is wasted headroom. That model is *inverted*
   for metered agents on a 1M model: context is **re-billed every turn**, so 27%
   of 1M = **270k tokens you pay for again on every single request.** Small
   context isn't wasteful — it's the *cheap* way to work; the compact he hated
   *saved him money.* The failure mode flipped (chat: danger = running out;
   agents: danger = carrying dead weight) and he didn't notice, so an action
   fighting the new danger read as destroying his old safety margin. **When a
   tool operates on a model the user doesn't hold yet, every automatic action
   reads as hostile,** and the brain fills the gap with "malfunction." So the
   attribution must be phrased to *correct the prior*, not reinforce it: not
   "compacting to save context" (feeds the container model) but "compacting
   because you're re-billing 270k tokens/turn — this makes it cheaper" (breaks
   it). The auto-action becomes a teaching moment for the new mental model
   instead of a jump-scare.

   **This is the same disease as the muted reaction to agent communication
   (5 months).** Both are audiences applying a *previous tool's* mental model
   (chat window; single-agent CLI) to the new world (metered agents;
   multi-agent), where the old model is silently wrong. A feature that
   contradicts a held prior gets rejected as *wrong*, not evaluated as *new*.
   The lesson for demos AND for auto-action copy: **name the old prior and break
   it, out loud, before showing the thing that only makes sense on the other
   side.** Don't sell the mechanism ("agents can communicate," "here's
   compaction") — name the pain the stale prior is causing and show it gone. The
   real adversary is never apathy; it's the last tool's model still running in
   the user's head.
2. **The observer persona is a real corner of the space:** the competent user
   who wants a *passive local window onto agents* and *actively refuses*
   orchestration. It's the opposite of how the maintainers use clodex, so it
   won't get designed for by default — capture it deliberately.

## The one number, for when this becomes real

The load-bearing decision is the **extension-point taxonomy as a published,
versioned API.** Everything else (in-repo vs downloadable vs local plugins,
personas, BYO) is downstream and comparatively easy. Do **not** start with
Peering (hard: out-of-process, external `aws`/SSM, packaging blocker) or
wirescope (a *migration*, not a clean pilot). Start by formalizing the
**in-process host API against workbench** — already in-repo, already in-process,
already near the deps-object seam — and extract *one* real thing into a declared
`{ manifest, activate(host), deactivate() }` lifecycle to discover what the seam
wants to be. The deps-object factory pattern (M1–M5) is already "core hands a
component a defined surface" in embryo.
