// popovers/context-popover.js — the context-breakdown popover, opened from the
// bar's context-% segment. Renders wirescope's composition/strip/utilization
// breakdown of what is filling the window, with manage-tools/skills links and a
// link out to the full report panel. Self-contained island: DOM handles +
// dismiss wiring live here; data comes through popoverApi(name).ctx/.report.
// popoverApi and ctxCatLabel STAY in renderer.js (core popover plumbing shared
// across islands) and are injected; openReportPanel/openToolsPopover/
// openSkillsPopover are the sibling islands' openers this one links to;
// proxyState (live poll payload) and sessionTypeOf are core, injected.
//
// DOM-bound, so no unit tests per the R1 rule — move-only fidelity is the guarantee.

const { esc, fmtTokens } = require('../lib/format');
const { groupMcpTools, mcpTotalTokens } = require('../lib/mcp-group');
const { placeAboveAnchor } = require('../lib/popover-place');

const CTX_SEG = '#proxy-bar [data-act="ctx"]';

function initContextPopover({ popoverApi, ctxCatLabel, openReportPanel, openToolsPopover, openSkillsPopover, proxyState, sessionTypeOf, barPopovers }) {
  // --- Context-breakdown popover -------------------------------------------
  // Opened from the ctx telemetry seg (only when wirescope advertises
  // context_view/context_composition). Pulls /_context for the live session and
  // renders the per-category composition (biggest-first), per agent line. Falls
  // back to the tools roster on a context_view-only proxy. Standalone clodex
  // (no proxy) never shows the button — see renderProxyBar.
  const ctxPopover = document.getElementById('ctx-popover');
  const ctxPopoverName = document.getElementById('ctx-popover-name');
  const ctxPopoverBody = document.getElementById('ctx-popover-body');
  function closeContextPopover() {
    ctxPopover.classList.add('hidden');
    ctxPopover.dataset.name = '';
  }
  const closeSiblings = barPopovers.register('ctx', closeContextPopover);

  // Every call downstream of the fetch below re-places on the SAME anchor object,
  // and a renderProxyBar landing during that fetch detaches it — so the live seg
  // is re-queried here rather than trusted from the caller's reference.
  function placeCtxPopover(anchor) {
    placeAboveAnchor(ctxPopover, anchor, CTX_SEG);
  }

  function renderCompositionLine(a, stripLevel = 0) {
    const comp = a.composition;
    const head = a.line === 'main' ? 'main' : (a.display_name || a.agent_id || 'subagent');
    const est = comp.basis === 'estimate' ? '<span class="ctx-est">~est</span>' : '';
    const rows = (comp.by_category || []).map((c) => {
      const pct = typeof c.pct === 'number' ? c.pct : 0;
      const pctTxt = pct < 10 ? pct.toFixed(1) : Math.round(pct);
      return `<div class="ctx-row"><div class="ctx-row-top">` +
        `<span class="ctx-cat">${esc(ctxCatLabel(c.category))}</span>` +
        `<span class="ctx-nums">${fmtTokens(c.tokens)} · ${pctTxt}%</span></div>` +
        `<div class="ctx-bar"><i style="width:${Math.max(1, Math.min(100, pct))}%"></i></div></div>`;
    }).join('');
    return `<div class="ctx-line-head"><span>${esc(head)}${est}</span>` +
      `<span class="ctx-line-total">${fmtTokens(comp.total_tokens)}</span></div>${rows}` +
      renderStripPanel(comp.strip_prior_thinking, stripLevel >= 1) +
      (stripLevel >= 2 ? (
        renderL2StripPanel(comp.strip_prior_tool_errors, true, 'prior tool errors',
          (comp.strip_prior_tool_errors ? (comp.strip_prior_tool_errors.failed_calls || 0) + (comp.strip_prior_tool_errors.error_results || 0) : 0)) +
        renderL2StripPanel(comp.strip_prior_edit_acks, true, 'prior edit acks',
          (comp.strip_prior_edit_acks ? (comp.strip_prior_edit_acks.collapsed_acks || 0) : 0))
      ) : '');
  }

  // The wirescope strip-prior-thinking story for one agent line, from
  // composition.strip_prior_thinking (always present when there's prior thinking
  // to evaluate; absent on turn 1 / right after a compact = nothing to strip).
  // `would_strip` is the gate's verdict on the window, independent of opt-in — so
  // "actually stripping" = stripOn AND would_strip. When opted-in but would_strip
  // is false, the monster guard skipped this turn (low thinking density).
  function renderStripPanel(sp, stripOn) {
    if (!sp || typeof sp.prior_thinking_tokens !== 'number' || sp.prior_thinking_tokens <= 0) return '';
    const tok = sp.prior_thinking_tokens;
    const usd = typeof sp.est_read_reclaim_usd_per_turn === 'number' ? sp.est_read_reclaim_usd_per_turn : null;
    const pct = typeof sp.pct_of_window === 'number' ? sp.pct_of_window : null;
    const usdTxt = usd == null ? '' : (usd >= 0.01 ? ` (~$${usd.toFixed(2)}/turn)` : ` (~$${usd.toFixed(4)}/turn)`);
    const pctTxt = pct == null ? '' : ` · ${pct < 10 ? pct.toFixed(1) : Math.round(pct)}% of window`;
    let verdict, cls;
    if (stripOn && sp.would_strip) {
      verdict = `Stripping ~${fmtTokens(tok)}/turn${usdTxt}`;
      cls = 'on';
    } else if (stripOn && !sp.would_strip) {
      const ratio = typeof sp.body_thinking_ratio === 'number' ? sp.body_thinking_ratio.toFixed(1) : '?';
      const max = typeof sp.max_body_ratio === 'number' ? sp.max_body_ratio.toFixed(1) : '?';
      verdict = `On, but this turn skipped: low thinking density (ratio ${ratio} > ${max})`;
      cls = 'skip';
    } else {
      verdict = `Off — turn on 🧠 strip to reclaim ~${fmtTokens(tok)}/turn${usdTxt}`;
      cls = 'off';
    }
    return `<div class="ctx-strip ctx-strip-${cls}">` +
      `<div class="ctx-strip-head">🧠 prior thinking: <b>${fmtTokens(tok)}</b>${pctTxt}</div>` +
      `<div class="ctx-strip-verdict">${esc(verdict)}</div></div>`;
  }

  // The two L2 add-ons, from composition.strip_prior_tool_errors (failed calls +
  // error results) and composition.strip_prior_edit_acks (succeeded Edit/Write
  // acks collapsed to "ok"). Same shape; each is present only on an L2-capable
  // proxy once the prior window holds collapsible items (edit_acks key landed in
  // wirescope v0.6.1 — gate on presence). `rides_thinking_bust` means the add-on
  // only reclaims on turns where L1's thinking strip ALSO rewrote the window, so
  // the stripping verdict gates on would_strip just like L1. Rendered at level 2.
  function renderL2StripPanel(d, stripOn, label, count) {
    if (!d) return '';
    const tok = typeof d.read_reclaim_tokens_per_turn === 'number' ? d.read_reclaim_tokens_per_turn : 0;
    if (!(tok > 0)) return '';
    const usd = typeof d.est_read_reclaim_usd_per_turn === 'number' ? d.est_read_reclaim_usd_per_turn : null;
    const usdTxt = usd == null ? '' : (usd >= 0.01 ? ` (~$${usd.toFixed(2)}/turn)` : ` (~$${usd.toFixed(4)}/turn)`);
    const n = count || 0;
    const countTxt = n > 0 ? ` · ${n} item${n === 1 ? '' : 's'}` : '';
    let verdict, cls;
    if (stripOn && d.would_strip) {
      verdict = `Also stripping ~${fmtTokens(tok)}/turn${usdTxt}`;
      cls = 'on';
    } else if (stripOn && !d.would_strip) {
      verdict = d.rides_thinking_bust
        ? 'On, but idle this turn — rides the thinking bust (nothing extra until thinking strips)'
        : 'On, but nothing to strip this turn';
      cls = 'skip';
    } else {
      verdict = `+~${fmtTokens(tok)}/turn${usdTxt} on top of thinking`;
      cls = 'off';
    }
    return `<div class="ctx-strip ctx-strip-${cls}">` +
      `<div class="ctx-strip-head">🧠 ${esc(label)}: <b>${fmtTokens(tok)}</b>${countTxt}</div>` +
      `<div class="ctx-strip-verdict">${esc(verdict)}</div></div>`;
  }

  // Below this many evaluable (tool-loading) turns, a `used:0` verdict is too
  // thin to trust — a never-called tool over 2 turns is inconclusive, over 40
  // it's genuine deadweight. We say so rather than crying "deadweight" early.
  // Aligned to wirescope's analyze_tools.DEFAULT_MIN_TURNS so the popover's
  // idle→dead graduation matches the offline ledger exactly (a floor, not a
  // cliff: confidence keeps rising with turns; 0/40 is just more damning).
  const UTIL_MIN_TURNS = 3;
  // Cap the unused trim-list; the rest collapse into a "+N more" summary.
  const UTIL_UNUSED_CAP = 12;

  // Renders one utilization block (the "did it pay off" view) from a rollup +
  // deadweight-first per-item list. Shared by tools and skills — wirescope ships
  // both as the exact same shape ({evaluable_turns, loaded, used_distinct,
  // deadweight_tokens} + per-item {name, est_tokens, used}). '' when the agent
  // carries no utilization for this surface (Codex/openai lines, a non-utilization
  // proxy build, or a pre-context_skills proxy for skills).
  function renderUtilBlock(u, items, title) {
    if (!u || !Array.isArray(items)) return '';
    const turns = u.evaluable_turns || 0;
    const loaded = u.loaded != null ? u.loaded : items.length;
    const usedDistinct = u.used_distinct != null ? u.used_distinct : items.filter((x) => (x.used || 0) > 0).length;
    const deadweight = u.deadweight_tokens || 0;
    const lowConf = turns < UTIL_MIN_TURNS;
    // "dead" is a verdict; only claim it once enough turns back it. Until then
    // the same tokens are merely "idle" — present but not yet proven wasted.
    const deadWord = lowConf ? 'idle' : 'dead';

    // Token figures are char-based estimates (≈chars/4, wirescope's basis); a real
    // tokenizer (what the CLI's native /context shows) reads ~25% higher. The `~`
    // prefix signals estimate; the tooltip explains the systematic direction so the
    // gap vs native /context doesn't read as a mismatch.
    const estHint = 'Char-based estimate (≈chars/4); a tokenizer reads ~25% higher.';
    const head = `<div class="ctx-util-head"><span>${title}</span>` +
      `<span class="ctx-util-stat" title="${estHint}">${loaded} loaded · ${usedDistinct} used` +
      (deadweight > 0 ? ` · <b>~${fmtTokens(deadweight)} ${deadWord}</b>` : '') + `</span></div>`;

    // No loading turn has actually run yet — nothing to judge.
    if (turns === 0) {
      return `<div class="ctx-util">${head}` +
        `<div class="ctx-util-conf">No evaluable turns yet — run the session to see usage.</div></div>`;
    }
    const conf = lowConf
      ? `<div class="ctx-util-conf">Only ${turns} turn${turns === 1 ? '' : 's'} evaluated — unused ≠ dead yet.</div>`
      : `<div class="ctx-util-conf">Over ${turns} turns.</div>`;

    // Items arrive deadweight-first (used==0, then highest est_tokens); keep
    // wirescope's order and just split the two groups.
    const unused = items.filter((pt) => (pt.used || 0) === 0);
    const used = items.filter((pt) => (pt.used || 0) > 0);

    let body = '';
    if (unused.length) {
      body += `<div class="ctx-util-group">Unused${lowConf ? '' : ' — trim to save'}` +
        (!lowConf && deadweight > 0 ? ` ~${fmtTokens(deadweight)}` : '') + `</div>`;
      body += unused.slice(0, UTIL_UNUSED_CAP).map((pt) =>
        `<div class="ctx-row ctx-dead"><div class="ctx-row-top">` +
        `<span class="ctx-cat">${esc(pt.name)}</span>` +
        `<span class="ctx-nums">~${fmtTokens(pt.est_tokens || 0)}</span></div></div>`).join('');
      if (unused.length > UTIL_UNUSED_CAP) {
        body += `<div class="ctx-util-more">+${unused.length - UTIL_UNUSED_CAP} more unused</div>`;
      }
    }
    if (used.length) {
      body += `<div class="ctx-util-group">Used</div>`;
      body += used.map((pt) =>
        `<div class="ctx-row"><div class="ctx-row-top">` +
        `<span class="ctx-cat">${esc(pt.name)}</span>` +
        `<span class="ctx-nums">~${fmtTokens(pt.est_tokens || 0)} · ${pt.used}×</span></div></div>`).join('');
    }
    return `<div class="ctx-util">${head}${conf}${body}</div>`;
  }
  // The MCP block renders NOTHING AT ALL when there are no MCP tools — not an
  // empty section, not a zero row. "Surface them when they are there" is the requirement, and a user
  // with no MCP servers must see no new UI whatsoever.
  //
  // Deliberately NOT a config inventory: this is what the session is CARRYING
  // right now, per the live roster. A configured-but-not-loaded server does not
  // appear here, which is why the heading says "loaded" rather than implying a
  // complete list of what the user has configured.
  //
  // The remove hint POINTS AT THE USER'S OWN TOOL and never acts. Clodex does
  // not write user config files — that rule is affirmed here, not worked
  // around, so there is no button and nothing that could run this for them.
  // `claude mcp remove <name>` resolves the scope itself when none is given
  // ("removes from whichever scope it exists in", verified from --help), so the
  // generic form is correct rather than a hedge.
  function renderMcpServers(a) {
    const groups = groupMcpTools(a.tools && a.tools.per_tool);
    if (!groups.length) return '';
    const total = mcpTotalTokens(groups);
    const turns = (a.utilization && a.utilization.evaluable_turns) || 0;
    const conclusive = turns >= UTIL_MIN_TURNS;

    const head = `<div class="ctx-util-head"><span>MCP servers</span>` +
      `<span class="ctx-util-stat" title="Char-based estimate (≈chars/4); a tokenizer reads ~25% higher.">` +
      `${groups.length} loaded · <b>~${fmtTokens(total)}/turn</b></span></div>`;

    const rows = groups.map((g) => {
      // Usage is only a verdict once enough turns back it — same floor the tool
      // and skill blocks use, and the same vocabulary.
      const usage = turns === 0
        ? ''
        : (g.usedTotal > 0
          ? ` · ${g.usedTotal}×`
          : (conclusive ? ' · <b>unused</b>' : ' · idle'));
      return `<div class="ctx-row${(conclusive && g.usedTotal === 0) ? ' ctx-dead' : ''}">` +
        `<div class="ctx-row-top"><span class="ctx-cat">${esc(g.server)}</span>` +
        `<span class="ctx-nums">~${fmtTokens(g.estTokens)} · ${g.toolCount} tool${g.toolCount === 1 ? '' : 's'}${usage}</span>` +
        `</div></div>`;
    }).join('');

    // Only offer the removal hint once a server is CONCLUSIVELY unused —
    // telling someone to remove a server they simply have not called yet is
    // worse than saying nothing.
    const deadServers = conclusive ? groups.filter((g) => g.usedTotal === 0) : [];
    const hint = deadServers.length
      ? `<div class="ctx-util-conf">Unused over ${turns} turns. To remove one, run ` +
        `<code>claude mcp remove ${esc(deadServers[0].server)}</code> yourself — Clodex never edits your MCP config. ` +
        `It removes from whichever scope defines the server; for project <code>.mcp.json</code> approvals see ` +
        `<code>claude mcp reset-project-choices</code>.</div>`
      : '';
    return `<div class="ctx-util">${head}${rows}${hint}</div>`;
  }

  // Tool + skill utilization for one agent line. Mirror shapes (a.tools.per_tool +
  // a.utilization; a.skills.per_skill + a.skills_utilization), same renderer.
  function renderUtilization(a) {
    return renderUtilBlock(a.utilization, a.tools && a.tools.per_tool, 'Tool utilization');
  }
  function renderSkillUtilization(a) {
    return renderUtilBlock(a.skills_utilization, a.skills && a.skills.per_skill, 'Skill utilization');
  }
  async function openContextPopover(name, anchor) {
    closeSiblings();
    ctxPopoverName.textContent = name;
    ctxPopover.dataset.name = name;
    ctxPopoverBody.innerHTML = '<div class="ctx-note">Loading…</div>';
    ctxPopover.classList.remove('hidden');
    placeCtxPopover(anchor);
    // Opt into the (heavier) utilization capture-scan only when the proxy
    // advertises it — otherwise this is byte-identical to the composition fetch.
    // Skill usage rides the same &utilization=1 flag, so fetch it when either
    // tool-utilization or the v0.4.14 skills roster is available.
    const pl = proxyState.get(name)?.payload || {};
    const caps = pl.capabilities || {};
    const peerQueries = Array.isArray(pl.queries) ? pl.queries : [];
    const wantUtil = !!(caps.context_utilization || caps.context_skills);
    const res = await popoverApi(name).ctx({ utilization: wantUtil });
    // Bail if the popover was closed or retargeted while the fetch was in flight.
    if (ctxPopover.dataset.name !== name || ctxPopover.classList.contains('hidden')) return;
    if (!res || !res.ok) {
      ctxPopoverBody.innerHTML = `<div class="ctx-note">${esc(res && res.error ? res.error : 'Unavailable')}</div>`;
      placeCtxPopover(anchor); return;
    }
    const agents = (res.data && Array.isArray(res.data.agents)) ? res.data.agents : [];
    if (!agents.length) {
      const note = (res.data && res.data.note) || 'No live context for this session.';
      ctxPopoverBody.innerHTML = `<div class="ctx-note">${esc(note)}</div>`;
      placeCtxPopover(anchor); return;
    }
    const withComp = agents.filter((a) => a.composition && Array.isArray(a.composition.by_category));
    let html;
    if (withComp.length) {
      withComp.sort((a, b) => (a.line === 'main' ? -1 : b.line === 'main' ? 1 : 0));
      // Two columns so the popover stays short: composition (what's loaded) on the
      // left, tool + skill utilization (did it pay off) on the right. Falls back to
      // a single column when there's no utilization (composition-only proxy).
      const stripLevel = (proxyState.get(name)?.payload?.stripLevel || 0);
      const compCol = withComp.map((a) => renderCompositionLine(a, stripLevel)).join('');
      // MCP leads the right-hand column when present: it is typically the
      // largest single addition to a user's per-turn carriage, and it renders to
      // '' when the line carries no MCP tools — so on a session without MCP the
      // column is byte-identical to before this feature existed.
      const utilCol = withComp.map((a) => renderMcpServers(a) + renderUtilization(a) + renderSkillUtilization(a)).join('');
      html = utilCol.trim()
        ? `<div class="ctx-cols"><div class="ctx-col">${compCol}</div><div class="ctx-col">${utilCol}</div></div>`
        : compCol;
    } else {
      // context_view-only proxy: no composition, but the tools roster is there.
      const main = agents.find((a) => a.line === 'main') || agents[0];
      const t = main && main.tools;
      if (t && Array.isArray(t.per_tool)) {
        const rows = t.per_tool.slice(0, 12).map((pt) =>
          `<div class="ctx-row"><div class="ctx-row-top"><span class="ctx-cat">${esc(pt.name)}</span>` +
          `<span class="ctx-nums">${fmtTokens(pt.est_tokens)}</span></div></div>`).join('');
        html = `<div class="ctx-line-head"><span>tools (${t.count})</span>` +
          `<span class="ctx-line-total">${fmtTokens(t.est_tokens)}</span></div>${rows}` +
          `<div class="ctx-note">Composition breakdown not available from this proxy build.</div>`;
      } else {
        html = '<div class="ctx-note">No breakdown available.</div>';
      }
    }
    // Cross-link to the tools manager for Claude sessions. When utilization data
    // is present, frame it as the trim lever: how many tools to drop and the
    // tokens it frees (the main agent's deadweight, only once it's conclusive).
    const mainAgent = agents.find((a) => a.line === 'main');
    const mainTools = mainAgent?.tools;
    if (mainTools && sessionTypeOf(name) === 'claude') {
      const mu = mainAgent.utilization;
      const conclusive = mu && (mu.evaluable_turns || 0) >= UTIL_MIN_TURNS;
      const unusedCount = mainTools.per_tool
        ? mainTools.per_tool.filter((pt) => (pt.used || 0) === 0).length : 0;
      const label = (conclusive && unusedCount > 0)
        ? `Trim ${unusedCount} unused tool${unusedCount === 1 ? '' : 's'}` +
          (mu.deadweight_tokens > 0 ? ` (~${fmtTokens(mu.deadweight_tokens)})` : '') + ' →'
        : `Manage tools (${mainTools.count}) →`;
      html += `<span class="ctx-tools-link" data-act="manage-tools">${label}</span>`;
    }
    // Cross-link to the skills manager. With the v0.4.14 per-skill roster
    // (capabilities.context_skills) it becomes the trim lever — N unused skills +
    // the deadweight tokens skillOverrides:off would reclaim, mirroring tools.
    // Falls back to the aggregate composition category on a pre-context_skills
    // proxy. The popover itself sources skill names standalone (transcript + seed).
    const mainSkills = mainAgent?.skills;
    if (sessionTypeOf(name) === 'claude') {
      if (mainSkills && Array.isArray(mainSkills.per_skill)) {
        const su = mainAgent.skills_utilization;
        const conclusive = su && (su.evaluable_turns || 0) >= UTIL_MIN_TURNS;
        const unusedCount = mainSkills.per_skill.filter((ps) => (ps.used || 0) === 0).length;
        const label = (conclusive && unusedCount > 0)
          ? `Trim ${unusedCount} unused skill${unusedCount === 1 ? '' : 's'}` +
            (su.deadweight_tokens > 0 ? ` (~${fmtTokens(su.deadweight_tokens)})` : '') + ' →'
          : `Manage skills (${mainSkills.count}) →`;
        html += `<span class="ctx-tools-link" data-act="manage-skills">${label}</span>`;
      } else {
        const skillsCat = mainAgent?.composition?.by_category?.find((c) => c.category === 'skills');
        if (skillsCat) {
          html += `<span class="ctx-tools-link" data-act="manage-skills">Manage skills (~${fmtTokens(skillsCat.tokens)}/turn) →</span>`;
        }
      }
    }
    // Full report → the deep, ground-truth cost/efficiency analysis (wirescope
    // /_report, report_version 1). Capability-gated; opens the report modal.
    if (caps.context_report || peerQueries.includes('report')) {
      html += `<span class="ctx-tools-link" data-act="report">Full cost &amp; efficiency report →</span>`;
    }
    ctxPopoverBody.innerHTML = html;
    placeCtxPopover(anchor);
  }

  ctxPopoverBody.addEventListener('click', (e) => {
    const toolsLink = e.target.closest('[data-act="manage-tools"]');
    const skillsLink = e.target.closest('[data-act="manage-skills"]');
    const reportLink = e.target.closest('[data-act="report"]');
    if (!toolsLink && !skillsLink && !reportLink) return;
    const name = ctxPopover.dataset.name;
    closeContextPopover();
    if (!name) return;
    if (reportLink) { openReportPanel(name); return; }
    // Anchor the target popover to the live ctx seg (still visible in the bar).
    const anchor = document.querySelector(CTX_SEG);
    if (!anchor) return;
    if (toolsLink) openToolsPopover(name, anchor);
    else openSkillsPopover(name, anchor);
  });

  document.addEventListener('mousedown', (e) => {
    if (ctxPopover.classList.contains('hidden')) return;
    if (ctxPopover.contains(e.target)) return;
    if (e.target.closest('[data-act="ctx"]')) return; // toggle handled by the bar
    closeContextPopover();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !ctxPopover.classList.contains('hidden')) closeContextPopover();
  });
  // Always-reachable close buttons (a tall popover can put outside-click/Escape
  // out of a user's reach — the ✕ never moves).
  document.getElementById('ctx-popover-close').addEventListener('click', closeContextPopover);

  return { openContextPopover };
}

module.exports = { initContextPopover };
