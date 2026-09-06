# IntelliOps4 — Feature Scope

Working document. Everything planned, in implementation order, with enough
reasoning attached that picking one up later does not mean re-deriving why it
mattered. Tick items as they land; do not delete them.

**Status key** — `[ ]` not started · `[~]` in progress · `[x]` done
**Effort** — S ≈ a day · M ≈ 2–4 days · L ≈ a week or more

---

## 1 · Where the product actually stands

Established by reading the code, not from memory. This section is the baseline
every estimate below is measured against — correct it when it drifts.

### Already built and working

| Capability | Where it lives |
|---|---|
| Multi-round tool loop, 8 rounds, bounded by wall-clock | `srv/lib/agent.js` — `MAX_ROUNDS` |
| Conversational memory within a conversation | `agent.js` — `loadHistory(conversationID)` |
| Autonomy gate: policy, write ceiling, second approver | `srv/lib/policy.js` — `shouldAutoApprove()` |
| Anomaly detection with configurable factor | `policy.js` — `detectAnomaly()` |
| Writes proposed, never executed unattended | `PendingAction` + `ApprovalPolicy` |
| One audit row per request, on every path | `AgentRun`, `AgentStep`, `SessionLog` |
| Provider failover: 2 OpenRouter keys → AI Core → offline | `srv/lib/llm.js` — `getProviderChain()` |
| Free-models-only guard | `llm.js` — `onlyFreeModels()` |
| Answer cache with per-object TTL and midnight clamp | `srv/lib/cache.js` + `CachePolicy` |
| Quota per user/role/default | `QuotaPolicy`, `srv/lib/quota.js` |
| 14 admin screens, create and edit | Fiori Elements apps under `app/` |
| Live S/4 reads via SAP Graph | `srv/lib/backend.js` — `GraphBackend` |

### Modelled but dead — no runtime behind the field

Someone designed proactive behaviour and never built the clock. **This is the
cheapest available progress**: the data model, approval gate and anomaly
detector are already paid for.

- `OrgSettings.autopilotEnabled` — no code reads it
- `OrgSettings.digestHour` (default 6) — no code reads it
- `OrgSettings.webhookUrl` — never called
- **There is no scheduler anywhere in the application**

### The actual gap

Reasoning is not the weakness. **Nothing ever happens unless a human types a
question.** That is the whole distance between a very good assistant and an
agent, and Tier 1 closes most of it.

---

## 2 · MVP for a paid client pilot

Past MVP on capability, short of it on proof. All but one item exists today.

- [ ] **Client's own data** — their business objects registered, not the 5 demo
      ones. A business object is a configuration row, so this is a day, not a
      project.
- [ ] **Client's identity** — their users in their XSUAA, role collections
      assigned in their cockpit.
- [ ] **One proactive behaviour** — the morning digest (Tier 1, item 1). This is
      what makes it read as a product rather than a demo.
- [ ] **A cost ceiling they trust** — per-user quota is built; it needs to be
      *shown* to them, not just enforced.
- [x] **AI Core option documented** — `docs/deployment/SAP_AI_CORE.md`, for when
      procurement asks where the prompts go.

---

## 3 · Tier 1 — Proactivity

The differentiator. A chat that answers questions is a commodity; a system that
tells you something you did not know is not.

**TIER 1 COMPLETE — 6 September 2026.** All five items shipped and deployed,
marked BETA. Verified running in production: `watcher-sweep` executed on the
live instance and recorded its result; the digest is scheduled for 06:00. This
is the first thing the product does without being asked.

Everything here depended on item 0, which is why it was built first.

- [x] **0 · Scheduler with an instance lock** — **M** · BETA · *6 Sep 2026*
      Cloud Foundry runs multiple instances; a naive `setInterval` fires once
      per instance, so a digest gets sent three times. Needs a database-backed
      lock so exactly one instance runs each job. This single piece unlocks all
      four items below and is the real work in this tier.

      **Landed.** `db/jobs.cds` (`ScheduledJob`, `JobRun`) and
      `srv/lib/scheduler.js`. The claim is a *lease*, not a boolean, so an
      instance killed mid-run stops renewing and the job becomes claimable
      again rather than stranded forever. 18 tests, including one that fires
      ten simultaneous claims and asserts exactly one wins — that is the test
      that says the feature works at all, since the bug it prevents is
      invisible on a single machine.

      One trap worth remembering: the CQN object predicate
      `where({ jobName, or: [...] })` generated
      `jobName = ? or ? lockedUntil is NULL and ?` — accepted by SQLite,
      semantically nonsense, and it would have let *every* instance claim the
      job. It now uses an explicit tagged template.

- [x] **1 · Morning digest** — **S** · BETA · *6 Sep 2026*
      **Landed.** `srv/lib/digest.js`, run by the `daily-digest` job at
      `OrgSettings.digestHour` — the field that had been dead since the model
      was written now drives the schedule.

      It reads through the *same* tools the chat uses, not a private query
      path: a digest that disagreed with what the chat says about the same data
      would make both untrustworthy, and the divergence would be invisible
      until someone checked by hand. Every section degrades on its own, and an
      unreadable section says *"could not be read — <reason>"* rather than
      showing zero. That distinction is the whole point at 6am: an empty result
      and a broken connection lead to opposite actions.

- [x] **2 · Watchers** — **M** · BETA · *6 Sep 2026*
      **Landed.** `db/jobs.cds` (`Watcher`), `srv/lib/watchers.js`, swept every
      15 minutes by the `watcher-sweep` job, managed at Admin → Watchers.

      The design turns on one thing: **alert on the edge, not on the state.** A
      breached condition is still breached at the next sweep, so notifying each
      time produces a message every fifteen minutes about something the
      recipient already knows — which gets muted, and a muted alert is worse
      than none because everyone still believes it works. Alerts fire on
      entering breach and again only after clearing and returning.

      Second rule: a watcher that cannot be *read* is never treated as "not
      breached". Losing the source system would otherwise silently clear every
      real alert at exactly the moment they matter.

- [x] **3 · Anomaly alerts on reads** — **S** · BETA · *6 Sep 2026*
      **Landed.** `db/jobs.cds` (`Observation`), `srv/lib/anomaly.js`, run every
      3 hours by `anomaly-sweep`.

      The roadmap assumed this would reuse `policy.detectAnomaly()`. It could
      not: that function compares a *proposed write quantity* against recent
      moves and only ever looks **upward**, because for a write the dangerous
      direction is 50× too much. For a read the opposite matters as much —
      stock at a third of its normal level is the alert someone wants. So this
      is a separate judgement, sharing only `OrgSettings.anomalyFactor` so
      there is one dial for "how surprised should this system get".

      Three decisions the tests pin down:
      **median, not mean** — one freak day drags a mean far enough that the
      next genuinely bad day reads as normal, so the metric stops working
      immediately after the event it should have learnt from;
      **silence until there is history** (5 observations) — alerting from a
      standing start trains the recipient to ignore it within a week;
      **a failed read is not an observation** — storing it as zero would poison
      the median and make the next real reading look like a spike.

- [x] **4 · Delivery channels** — **S** · BETA · *6 Sep 2026*
      **Landed.** `srv/lib/notify.js` finally calls `OrgSettings.webhookUrl`,
      another field that had never been read. One payload carries both a bare
      `text` field (which Teams and Slack both render) and the structured
      parts, so one webhook serves a chat channel and a custom consumer without
      configuration — a wider net than picking one vendor's API.

      Delivery never throws. "Built but not delivered" and "could not be built"
      are different facts, and conflating them would have someone debugging the
      digest when the webhook is what broke. Email is still to do.

---

## 4 · Tier 2 — Deeper reasoning

Moves the product from *what* to *why*.

**TIER 2 COMPLETE — 6 September 2026.** All three items shipped, marked BETA.
Items 5 and 6 came in under estimate because the eight-round loop already had
the machinery; what it lacked was date ranges and a prompt that told it a causal
question is the reason to chain. Item 7 took the longest and is almost entirely
guardrail rather than arithmetic.

- [x] **5 · Root-cause chains** — **M** · BETA · *6 Sep 2026*
      **Landed.** Two halves, as the estimate assumed: date ranges in
      `srv/lib/tools.js` (`dateRange`, nine presets) and rules 10–12 in the
      system prompt.

      The prompt half mattered more than expected. The eight-round loop could
      always chain calls; nothing had ever told it that a causal question is
      the case for doing so, so "why did stock drop?" was answered with the
      current stock level — which is what was asked *about*, not what was
      asked. Rule 10 also requires it to say when the data does not explain
      the change: a plausible story the rows do not support is worse than
      admitting the movements do not account for it.

- [x] **6 · Trend and comparison** — **M** · BETA · *6 Sep 2026*
      **Landed**, and cheaper than estimated because item 5 did the expensive
      part. With ranges available, a comparison is the same tool called twice
      with two presets — which the loop already supports. Rule 11 requires two
      calls and forbids inferring a trend from a single reading.

- [x] **7 · What-if simulation** — **L** · BETA · *6 Sep 2026*
      **Landed.** `srv/lib/simulate.js` and the `simulate_stock_change` tool.

      The arithmetic is a subtraction; all the risk is around it. A projection
      *reads* exactly like a reading — a confident figure, in a table, from the
      same assistant that has been quoting real stock all morning. So three
      rules, enforced structurally rather than by asking the model nicely:

      **Inputs are grounded; the output is not.** A simulation reads real stock,
      so its inputs are as trustworthy as any answer — the projected figure is
      not, and must never set the `grounded` flag. This is why it is a *third*
      kind of tool in the agent loop rather than a read: the simulation branch
      returns before the line that sets `grounded`.

      **The label travels inside the result.** `projection: true` and a `basis`
      naming the reading and the quantity field it used are part of the tool
      output, so the model cannot report the number with the caveat detached.

      **It never writes and never proposes.** `isWriteTool` is false for it, so
      it cannot reach the approval queue. "What if" is a question, and a
      question somebody could approve by accident is a trap.

      It also refuses rather than guesses: no matching stock returns no
      projection at all, because "0 − 500 = −500" is a confident answer built on
      nothing. An unrecognised quantity field is refused for the same reason.

---

## 5 · Tier 3 — Multi-agent

**TIER 3: one shipped, one deliberately deferred — 6 September 2026.** Item 9
landed in an adapted form; item 8 was checked against the database and found to
have no problem to solve yet. The trigger for revisiting it is written into the
item.

- [ ] **8 · Domain agents** — **M** — **DEFERRED, deliberately.** *6 Sep 2026*
      Procurement, inventory, logistics — each with its own tools and prompt,
      with a router in front.

      **Not built, because the condition for it is not met.** Checked against
      the database rather than assumed: all five active business objects carry
      `moduleDomain = 'SCM'`. There is exactly one domain, so a router would be
      choosing between one option, and every "domain agent" would hold the same
      tools as the single agent does now. That is infrastructure for a problem
      this deployment does not have, and it would have to be maintained through
      every change to the agent loop in the meantime.

      **Build it when either is true:**
      - Business objects span **two or more `moduleDomain` values** — e.g. a
        client registers FI or SD objects alongside SCM; or
      - The tool count passes roughly **15–20** and answer quality visibly drops
        because the model is choosing badly among too many similar tools.

      Today the count is 7 (5 reads, 1 simulation, 1 write), which is
      comfortably inside what one prompt holds. Revisit at the first client
      whose objects cross domains — that is the natural trigger, and it will be
      obvious when it happens.

- [x] **9 · Adaptive escalation** — **M** · BETA · *6 Sep 2026*
      *Delivered as escalation rather than a literal planner/executor split.*

      The roadmap framed this as "a stronger model plans, a cheap model
      executes". Two things about this deployment made that the wrong shape:
      every model in the chain is a free OpenRouter model, so the cost argument
      barely applies; and `route.pick` already chooses light or heavy per
      question, so per-question routing existed.

      The **real** gap was that `route.pick` decides once, up front, from a
      regex over the question text — before anything has been read. That guess
      is wrong in the expensive direction for exactly the questions Tier 2 made
      possible: *"why did stock drop in 1710"* reads like a lookup, then needs
      three or four rounds of chained calls. Difficulty is discovered, not
      predicted.

      **Landed.** A run still going after 2 rounds has demonstrated it is not a
      lookup, whatever it looked like, and the remaining rounds are served by
      the heavy route. Promotion happens at most once, never into a chain that
      is only the offline provider (which would trade a working light answer
      for a refusal), and is recorded on the outcome as `escalatedTo` so an
      operator asking why two similar questions cost differently gets an answer
      instead of a mystery.

      `FACTORYPILOT_ESCALATE_AFTER_ROUNDS` tunes the threshold.

---

## 6 · Tier 4 — Action

What "agent" means to a buyer.

**TIER 4: 2 of 3 shipped — 6 September 2026.** Item 11 is blocked on a writable
SAP tenant, which was discovered rather than assumed: no write has ever reached
SAP, because the Hub sandbox is read-only. The honesty fixes that came out of
finding it are listed under that item.

- [x] **10 · Multi-step workflows** — **L** · BETA · *6 Sep 2026*
      **Landed — and it turned out to be a bug fix first.**

      The write branch `return`ed on the *first* write tool call in a round and
      discarded the rest. So "rebalance these five materials" produced **one**
      confirmation card: the user approved it and had every reason to believe
      all five had happened. A partial action nobody was told about is the
      worst thing an approval gate can produce, and it is worse than having no
      batching at all. Every write in a round is now collected.

      On top of that: `PendingAction.batchID` / `batchSeq`, a `pendingBatch`
      card on `ChatResult`, and a `confirmBatch` action.

      Two rules the tests hold:
      **Batching never weakens a check.** Each action keeps its own policy
      decision and anomaly verdict, and `flagged` is surfaced on the batch —
      one button must not become a way to move an anomalous action past a gate
      by burying it among ordinary ones.
      **`confirmBatch` is a loop over `confirmAction`, not a parallel path.**
      Consumed-exactly-once, expiry, audit and second-approver all live in that
      handler; a bulk implementation would be a second place for those to be
      true, and therefore a second place for them to stop being true. It runs
      sequentially because these are movements against the same plant.

- [ ] **11 · More write-backs** — **M each** — **BLOCKED on a writable tenant.**
      *6 Sep 2026*

      Investigated and found the premise wrong: **no write reaches SAP today.**
      `executeWrite` returned `applied: true` for `move_stock` without posting
      anywhere, because the Accelerator Hub sandbox this tenant reads from is
      read-only. Adding `create_po` or `confirm_delivery` would add more of the
      same — tools that report success and change nothing.

      **Fixed while finding this out**, because it was an honesty defect in
      shipped code:
      - `applied` and `postedToSap` are now separate. They were one flag, and
        combined with an answer that began *"— done."* it read as a completed
        posting to anyone who did not reach the end of the sentence.
      - The audit no longer marks such a write `grounded`. `grounded` means
        "backed by what a real system actually did"; a local record is not
        that, and marking it so put it behind the badge that certifies real
        readings — the same conflation the simulation path avoids.
      - The answer now leads with *"recorded, not posted to SAP"*, and the note
        says *"Stock in SAP is unchanged"* rather than the previous
        *"Recorded against the local ledger"*, which is true and reads as
        jargon.
      - `scripts/e2e.js` asserts on that honesty against any running instance,
        not only on the status code.

      **Unblocks when** a tenant with a writable endpoint exists. The plug-in
      point is marked in `executeWrite`: resolve the endpoint the way
      `executeRead` does, post, and set `postedToSap` from the response.

- [x] **12 · Long-running questions** — **L** · BETA · *6 Sep 2026*
      **Landed.** `db/jobs.cds` (`AsyncRun`), `srv/lib/asyncrun.js`, the
      `async-questions` worker, and `askAsync` / `asyncResult` on the Insights
      service. Only possible because Tier 1 built somewhere for it to run.

      `ASK_BUDGET_MS` bounds a synchronous question at ~75s because a browser
      is waiting. That is right for a chat box and wrong for the questions
      Tier 2 made possible — a root-cause chain across a month of movements is
      legitimately slow, and today's honest answer is "that took longer than I
      am allowed to spend". Async runs get 10 minutes.

      Three decisions:
      **It does not re-implement the agent.** The worker calls `agent.run`
      exactly as the request path does — same tools, quota, grounding, audit.
      Same reasoning as `confirmBatch`: a second implementation is a second
      place for those guarantees to stop being true.
      **It never executes a write.** `agent.run` stops at a write and returns a
      proposal; an async run records it and goes no further. Nobody is watching
      a background job, so it is the last place that should change a real
      system unattended.
      **A dead worker is visible.** A run left RUNNING past 30 minutes is
      marked EXPIRED and its quota returned. The agent keeps no intermediate
      state so it cannot be resumed, and leaving it RUNNING would show the
      submitter a spinner that never resolves.

      Note for operators: `QuotaPolicy.perRequestMaxTokens` defaults to 4000,
      sized for chat. A deployment that wants genuinely long async work should
      raise it — the submit-time reservation is only a gate, and reconciliation
      records what was really spent.

---

## 7 · Tier 5 — Trust and learning

**TIER 5 COMPLETE — 6 September 2026.** All three shipped, marked BETA.

- [x] **13 · Feedback loop** — **S** · BETA · *6 Sep 2026*
      **Landed.** `rateAnswer` on AuditService (`audit-service.cds/.js`),
      `AnswerFeedback` keyed on the `SessionLog` row it rates, and a 👍/👎
      control under every answered turn in the Insights chat
      (`app/insights/assets/chat.js` — `feedback()`).

      Found already built at the service layer with full test coverage but
      never reachable from the chat surface itself — the exact gap this item
      exists to close, so wiring the button through was the actual work.
      **UP or DOWN only**, deliberately not a 1–5 scale: a scale invites an
      argument about what 3 means, and the only decision this feeds is "go
      and look at these answers". **Re-rating replaces** rather than adding a
      second opinion, so one person cannot double-count in a weekly summary.
      A rating is keyed to `sessionLogID`, which the chat only has for a live
      SUCCESS turn — so a replayed conversation renders no control at all
      rather than one that would rate the wrong thing.

      Reviewed at Admin → Answer Feedback, joined back to provider, model and
      grounding — "every negative rating this week was ungrounded" is the
      finding this makes possible.

- [x] **14 · Saved questions** — **S** · BETA · *6 Sep 2026*
      **Landed.** `SavedQuestion` (`db/config.cds`), `SavedQuestions` on
      ConfigService with a seeded starter library
      (`db/data/factorypilot.config-SavedQuestion.csv`), managed at Admin →
      Saved Questions, and offered on the Insights welcome screen in place of
      the four questions that used to be hard-coded in `chat.js`.

      Same story as item 13: the entity, service and seed data already
      existed, untouched by the chat surface. Two decisions in the wiring:
      **a use is counted, not just listed** — `useSavedQuestion` is a
      separate action rather than a client-side PATCH to `useCount`, because
      the chat surface holds `InsightsQuery`, not `ConfigMaintain`, and a
      direct write would let anyone who can ask questions edit the count on
      *any* row, not only the one they used. **Filtered by role client-side**
      against `whoami().scopes`, so a question aimed at a role this sign-in
      does not hold never clutters the welcome screen — empty `forRole` still
      means everyone. Falls back to the original four suggestions if the
      library has not loaded yet or cannot be read, so the welcome screen is
      never empty on first paint.

- [x] **15 · Cross-conversation memory** — **M** · BETA · *6 Sep 2026*
      **Landed as structured preferences, deliberately not as memory.**
      `UserPreference` in the admin namespace, `srv/lib/prefs.js`, and
      `setPreference` / `myPreferences` on the Admin service.

      The obvious implementation — remember what the user said and put it in
      the system prompt — is two problems at once, and neither is obvious until
      it bites:

      **It is a prompt-injection surface.** Anything a user can store, they can
      use to instruct the model. The system prompt is where grounding,
      write-refusal and plant-scoping live, and user-authored text sitting
      beside those has to be assumed hostile rather than merely untidy.

      **It is a correctness risk.** A sentence remembered in March reaches the
      model in September carrying the same confidence as a figure read from
      SAP, with nothing attached to say it has expired.

      So: an allowlisted key set (`defaultPlant`, `preferredView`,
      `defaultDateWindow`), a validator per key, and values that flow through
      paths that already existed — `defaultPlant` becomes `defaults.warehouse`,
      the field the plant dropdown fills. **Nothing here ever becomes a
      sentence in a prompt.** A preference cannot express anything the schema
      does not already permit, which is the property that makes it safe.

      Precedence is most-specific-first: the plant chosen now, then the one
      remembered, then the org default. A remembered answer must never beat one
      given this time.

      Whose preference it is comes from the authenticated caller — the action
      has no `userID` parameter at all, so the protocol layer refuses one
      rather than the handler having to remember to ignore it.

---

## 8 · Tier 6 — Enterprise gates

These do not win deals. They lose them when missing.

- [ ] **16 · Multi-tenancy** — **L**
      One deployment serving many clients. Currently single-tenant; the CDS
      model would need tenant discrimination throughout.

- [x] **17 · Scheduled exports** — **S** · BETA · *6 Sep 2026*
      **Landed.** `srv/lib/exports.js`, the `weekly-export` job, and
      `exportReport` on the Jobs service for fetching one on demand.

      Three reports, each answering a question somebody asks out loud rather
      than dumping a table because the table exists: **usage** (who is using
      this and what does it cost), **quality** (grounded rate and ratings by
      day — the join item 13 made possible), and **failures** (what to fix).

      **CSV, not Excel or PDF.** A spreadsheet library is a dependency and a
      rendering surface for something every tool on the receiving end opens
      natively. PDF is worse: it is the format people ask for and then
      immediately try to get the numbers back out of. CSV survives being pasted
      somewhere else, which is what actually happens to it.

      The job ships **inactive**. A weekly file arriving unrequested is the
      definition of noise, and `ensureSeeded` never re-enables what an
      administrator has switched off.

      Most of the test weight is on CSV escaping, because that is where the
      real risk is: a mis-escaped comma shifts every later column of a row and
      the corruption is invisible until a total is wrong in a meeting — after
      which nobody trusts any of the figures, including the correct ones.

- [ ] **18 · Teams / Slack as a channel** — **M**
      `SessionLog.channel` already exists on every audit row, so the model
      anticipated this.

- [ ] **19 · Data residency via AI Core** — **S**
      Provider and probe exist; needs a client tenant to point at.
      See `docs/deployment/SAP_AI_CORE.md`.

- [ ] **20 · Bring-your-own infrastructure** — **[x] mechanism, [ ] proven**
      AWS / GCP / Azure Postgres and Redis work today via user-provided
      services. Probes exist. Not yet proven against a real client instance.
      See `docs/deployment/MULTI_CLOUD.md`.

---

## 9 · Recommended order

1. **Tier 1 item 0** — the scheduler. Nothing proactive exists without it.
2. **Tier 1 item 1** — the morning digest. Changes the sales story from "ask it
   anything" to "it told me before I asked".
3. **Tier 1 items 3 and 4** — anomaly alerts and delivery. Both small once the
   scheduler exists.
4. **Tier 5 item 13** — the feedback loop. Small, and it starts collecting data
   you will want later.
5. Then reassess. Tier 2 is worth more once real users are asking real
   questions, because their questions will say which of items 5–7 matters.

---

## 10 · Fixed along the way

- **The Tier 1 job screens were never annotated.** *6 Sep 2026.* CAP loads
  `.cds` files at the root of `srv/` but does not recurse into subfolders, and
  `srv/annotations/jobs.cds` — the carefully written LineItem, Facets and
  criticality colouring for Scheduled Jobs, Watchers and Job Runs — was never
  pulled in from `srv/annotations.cds`, which lists every other domain but
  that one. All three screens have been rendering Fiori Elements' generic
  every-field default instead, silently, since the day they were built.
  Confirmed by compiling the model and checking for `@UI.LineItem` on
  `JobsService.ScheduledJobs` before and after adding the missing `using
  from './annotations/jobs'` line. Caught while adding the same kind of
  annotation for items 13 and 14 below — worth checking any future domain
  the same way, since a missing include produces no error, just a plainer
  screen nobody thought to compare against the source.

- **Date filters resolved to the wrong day outside UTC.** *6 Sep 2026.* The
  filter builder took `new Date().toISOString().slice(0, 10)`, which converts
  to UTC before taking the date. East of Greenwich every question asked between
  midnight and the UTC offset resolved "today" to *yesterday* — so an early
  shift in India got the previous day's figures, and the answer looked
  entirely plausible. West of Greenwich the same fault appears late in the
  evening. Nothing in the output indicated anything was wrong. Now built from
  local date parts, with tests at 00:30 and 23:45.

---

## 11 · Known debt

Carry these; they are not features but they will bite.

- [ ] **Rotate exposed secrets** — the Hub key, both OpenRouter keys, the OpenAI
      key, the CPI client secret and the Redis password have all appeared in
      session transcripts.
- [ ] **Remove `OPENAI_API_KEY` from the deployed environment** — it is no
      longer reachable by any automatic path, but it is still set.
- [ ] **`factorypilot-db-deployer` restart loop** — the MTA declares it
      correctly (`no-start`, `no-route`, one-shot task) yet CF holds it in
      `started`, so every clean exit is counted as a crash. Stopped manually on
      5 September 2026; check after each deploy until the cause is found.
- [ ] **Redis attribution unknown** — it now connects in ~230ms, but it is not
      established which change fixed it or whether the original failure was
      transient. Diagnostics are in place, so a recurrence will name its cause.
- [ ] **Structural rename not done** — CDS namespaces, `FACTORYPILOT_*` env
      vars, `factorypilot-srv` and the four XSUAA role collections still carry
      the old name. Deliberate: renaming the namespaces renames every table.
- [ ] **Docs and deck still branded FactoryPilot** — architecture document, PPT
      and diagrams.
