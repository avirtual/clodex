// library-drawers.js — the prompts / agents / skills CRUD drawers (list +
// editor for each library under ~/.clodex/{prompts,agents,skills}).
//
// MOVED AS-IS, NOT DE-DUPED (R2 judgment call). The plan floated collapsing the
// three into one factory, but they are not parallel enough to do so without
// smuggling behavior changes onto a zero-coverage file:
//   - Prompts diverge structurally: a `kind` (system/append) dimension, an
//     Inject action + body-click-injects into the active session, a synchronous
//     body load (from the list item, not an async get), and NO rename-on-save
//     (kind+name are the locked file identity).
//   - Agents and skills are near-mirrors but still differ in list-preview
//     rendering (agents fold model/tools into a meta line), the new-item
//     template string, every window.api method name, and entity labels.
// Forcing one factory would require parameterizing all of that as callbacks —
// exactly the behavior-change risk move-only forbids here. A future dedicated
// pass could de-dup agents+skills alone as a reviewable change; it is NOT
// smuggled into this move. Each block is byte-identical modulo the +2 factory
// indent and the getActiveSession() seam below.
//
// FLAG (cross-island params): getActiveSession (prompt inject → activeSession is
// a reassignable let), and setAgentLibCache / setSkillLibCache (checklists.js
// owns those caches; the two refresh lists re-seed them). esc from lib/format.
//
// DOM-bound, so no unit tests per the R1 rule — move-only fidelity is the
// guarantee.

const { esc } = require('./lib/format');
const { splitModelArg } = require('./lib/args-model');
const { deniedIntentCount } = require('../intent-catalog');

// Scope caption for a library row (point 7 of the scope feature): a dim label
// derived from the two optional frontmatter keys — `workspace: <name>` and/or
// `sessions: a, b`. No keys → global → no badge. Agent rows carry parsed `meta`;
// skill rows carry only raw `content`, so parse a minimal frontmatter subset for
// just the two scope keys (mirrors scope-util's grammar — display only).
function scopeMetaFromContent(content) {
  const m = String(content || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const meta = {};
  if (m) for (const line of m[1].split(/\r?\n/)) {
    const mm = line.match(/^(workspace|sessions):\s*(.*)$/);
    if (!mm) continue;
    let v = mm[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    meta[mm[1]] = v;
  }
  return meta;
}
function scopeBadgeHtml(meta) {
  meta = meta || {};
  const parts = [];
  const ws = meta.workspace != null ? String(meta.workspace).trim() : '';
  const ss = meta.sessions != null ? String(meta.sessions).trim() : '';
  if (ws) parts.push(`workspace: ${ws}`);
  if (ss) parts.push(`sessions: ${ss}`);
  return parts.length ? `<div class="prompt-item-scope">${esc(parts.join(' · '))}</div>` : '';
}

function initLibraryDrawers({ getActiveSession, setAgentLibCache, setSkillLibCache, openTemplateEditor }) {
  const promptsDrawer = document.getElementById('prompts-drawer');
  const promptsList = document.getElementById('prompts-list');
  const promptsEmpty = document.getElementById('prompts-empty');
  const promptEditor = document.getElementById('prompt-editor');
  const promptEditorTitle = document.getElementById('prompt-editor-title');
  const promptKind = document.getElementById('prompt-kind');
  const promptName = document.getElementById('prompt-name');
  const promptBody = document.getElementById('prompt-body');
  const promptSave = document.getElementById('prompt-save');
  const promptCancel = document.getElementById('prompt-cancel');
  const promptDelete = document.getElementById('prompt-delete');
  const promptsNew = document.getElementById('prompts-new');
  const promptsClose = document.getElementById('prompts-close');

  // {kind, name} of the prompt being edited (its filename identity is locked while
  // editing — rename = delete + new), or null when authoring a new one.
  let editingPrompt = null;

  async function refreshPromptsList() {
    const items = await window.api.listPrompts();
    promptsList.innerHTML = '';
    if (items.length === 0) {
      promptsEmpty.style.display = '';
      return;
    }
    promptsEmpty.style.display = 'none';
    for (const p of items) {
      const el = document.createElement('div');
      el.className = 'prompt-item';
      const preview = p.body.split('\n')[0].slice(0, 80) + (p.body.length > 80 ? '…' : '');
      el.innerHTML = `
        <div class="prompt-item-title">${esc(p.name)} <span class="prompt-kind-badge">${esc(p.kind)}</span></div>
        <div class="prompt-item-preview">${esc(preview)}</div>
        <div class="prompt-item-actions">
          <button class="primary" data-action="inject">Inject</button>
          <button data-action="edit">Edit</button>
        </div>
      `;
      el.querySelector('[data-action="inject"]').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!getActiveSession()) {
          alert('No active session. Select one first.');
          return;
        }
        await window.api.injectPrompt(getActiveSession(), p.body);
      });
      el.querySelector('[data-action="edit"]').addEventListener('click', (e) => {
        e.stopPropagation();
        openPromptEditor(p);
      });
      // Clicking the body (not a button) = inject
      el.addEventListener('click', async () => {
        if (!getActiveSession()) { alert('No active session. Select one first.'); return; }
        await window.api.injectPrompt(getActiveSession(), p.body);
      });
      promptsList.appendChild(el);
    }
  }

  function openPromptsDrawer() {
    promptsDrawer.classList.remove('hidden');
    refreshPromptsList();
  }

  function closePromptsDrawer() {
    promptsDrawer.classList.add('hidden');
  }

  function openPromptEditor(prompt = null) {
    if (prompt) {
      editingPrompt = { kind: prompt.kind, name: prompt.name };
      promptEditorTitle.textContent = 'Edit Prompt';
      promptKind.value = prompt.kind;
      promptKind.disabled = true; // kind+name = the file identity; locked while editing
      promptName.value = prompt.name;
      promptName.readOnly = true;
      promptBody.value = prompt.body;
      promptDelete.style.display = '';
    } else {
      editingPrompt = null;
      promptEditorTitle.textContent = 'New Prompt';
      promptKind.value = 'append';
      promptKind.disabled = false;
      promptName.value = '';
      promptName.readOnly = false;
      promptBody.value = '';
      promptDelete.style.display = 'none';
    }
    promptEditor.classList.remove('hidden');
    setTimeout(() => (editingPrompt ? promptBody : promptName).focus(), 50);
  }

  function closePromptEditor() {
    promptEditor.classList.add('hidden');
    editingPrompt = null;
  }

  promptsClose.addEventListener('click', closePromptsDrawer);
  promptsNew.addEventListener('click', () => openPromptEditor(null));

  promptSave.addEventListener('click', async () => {
    const kind = promptKind.value;
    const name = promptName.value.trim();
    const body = promptBody.value;
    if (!name || !body.trim()) return;
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(name)) {
      promptName.style.borderColor = '#e94560';
      return;
    }
    promptName.style.borderColor = '';
    const res = await window.api.savePrompt(kind, name, body);
    if (res && res.ok === false) { alert(`Failed: ${res.error || 'unknown error'}`); return; }
    closePromptEditor();
    refreshPromptsList();
  });

  promptCancel.addEventListener('click', closePromptEditor);
  promptDelete.addEventListener('click', async () => {
    if (!editingPrompt) return;
    if (!confirm(`Delete prompt "${editingPrompt.name}"?`)) return;
    await window.api.removePrompt(editingPrompt.kind, editingPrompt.name);
    closePromptEditor();
    refreshPromptsList();
  });

  // Prevent keyboard shortcuts from firing inside the editor
  promptName.addEventListener('keydown', (e) => e.stopPropagation());
  promptBody.addEventListener('keydown', (e) => e.stopPropagation());

  // ---------------------------------------------------------------------------
  // Agents library — custom subagents stored as ~/.clodex/agents/*.md
  // ---------------------------------------------------------------------------

  const agentsDrawer = document.getElementById('agents-drawer');
  const agentsListEl = document.getElementById('agents-list');
  const agentsEmpty = document.getElementById('agents-empty');
  const agentEditor = document.getElementById('agent-editor');
  const agentEditorTitle = document.getElementById('agent-editor-title');
  const agentNameInput = document.getElementById('agent-name');
  const agentContent = document.getElementById('agent-content');
  const agentSave = document.getElementById('agent-save');
  const agentCancel = document.getElementById('agent-cancel');
  const agentDelete = document.getElementById('agent-delete');
  const agentsNew = document.getElementById('agents-new');
  const agentsClose = document.getElementById('agents-close');

  let editingAgentName = null;

  async function refreshAgentsList() {
    const items = await window.api.listAgents();
    setAgentLibCache(items || []);
    agentsListEl.innerHTML = '';
    if (!items || items.length === 0) {
      agentsEmpty.style.display = '';
      return;
    }
    agentsEmpty.style.display = 'none';
    for (const a of items) {
      const meta = [a.model && `model: ${a.model}`, a.tools && `tools: ${a.tools}`].filter(Boolean).join(' · ');
      const preview = a.description || meta || '(no description)';
      const el = document.createElement('div');
      el.className = 'prompt-item';
      el.innerHTML = `
        <div class="prompt-item-title">${esc(a.name)}</div>
        <div class="prompt-item-preview">${esc(preview)}</div>
        ${scopeBadgeHtml(a.meta)}
        <div class="prompt-item-actions">
          <button data-action="edit">Edit</button>
        </div>
      `;
      el.querySelector('[data-action="edit"]').addEventListener('click', (e) => {
        e.stopPropagation();
        openAgentEditor(a);
      });
      el.addEventListener('click', () => openAgentEditor(a));
      agentsListEl.appendChild(el);
    }
  }

  function openAgentsDrawer(name) {
    agentsDrawer.classList.remove('hidden');
    refreshAgentsList();
    // Deep-link from the Agents menu: ':new' opens a blank editor, any other
    // name jumps straight into that type's editor.
    if (name === ':new') openAgentEditor(null);
    else if (name) openAgentEditor({ name });
  }
  function closeAgentsDrawer() {
    agentsDrawer.classList.add('hidden');
  }

  async function openAgentEditor(agent = null) {
    if (agent) {
      editingAgentName = agent.name;
      agentEditorTitle.textContent = 'Edit Agent';
      agentNameInput.value = agent.name;
      agentContent.value = (await window.api.getAgent(agent.name)) || '';
      agentDelete.style.display = '';
    } else {
      editingAgentName = null;
      agentEditorTitle.textContent = 'New Agent';
      agentNameInput.value = '';
      agentContent.value = '---\ndescription: Fast read-only repo search.\ntools: Read, Grep, Glob\nmodel: haiku\n---\nYou are a focused explorer. Return conclusions, not file dumps.';
      agentDelete.style.display = 'none';
    }
    agentNameInput.style.borderColor = '';
    agentEditor.classList.remove('hidden');
    setTimeout(() => agentNameInput.focus(), 50);
  }
  function closeAgentEditor() {
    agentEditor.classList.add('hidden');
    editingAgentName = null;
  }

  agentsClose.addEventListener('click', closeAgentsDrawer);
  agentsNew.addEventListener('click', () => openAgentEditor(null));

  agentSave.addEventListener('click', async () => {
    const name = agentNameInput.value.trim();
    const content = agentContent.value;
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(name)) {
      agentNameInput.style.borderColor = '#e94560';
      return;
    }
    const res = await window.api.saveAgent(name, content);
    if (!res || !res.ok) {
      alert(`Failed: ${res && res.error ? res.error : 'unknown error'}`);
      return;
    }
    // Rename: a changed Name field writes a new file — drop the old one.
    if (editingAgentName && editingAgentName !== name) {
      await window.api.removeAgent(editingAgentName);
    }
    closeAgentEditor();
    refreshAgentsList();
  });

  agentCancel.addEventListener('click', closeAgentEditor);
  agentDelete.addEventListener('click', async () => {
    if (!editingAgentName) return;
    if (!confirm(`Delete agent "${editingAgentName}"?`)) return;
    await window.api.removeAgent(editingAgentName);
    closeAgentEditor();
    refreshAgentsList();
  });

  // Keep keyboard shortcuts from firing inside the editor fields
  agentNameInput.addEventListener('keydown', (e) => e.stopPropagation());
  agentContent.addEventListener('keydown', (e) => e.stopPropagation());
  agentNameInput.addEventListener('input', () => { agentNameInput.style.borderColor = ''; });

  // ---------------------------------------------------------------------------
  // Skill library — custom skills stored as ~/.clodex/skills/*.md, injected per
  // session via --plugin-dir. Mirrors the agents drawer.
  // ---------------------------------------------------------------------------

  const skillsDrawer = document.getElementById('skills-drawer');
  const skillsListEl = document.getElementById('skills-list');
  const skillsEmpty = document.getElementById('skills-empty');
  const skillEditor = document.getElementById('skill-editor');
  const skillEditorTitle = document.getElementById('skill-editor-title');
  const skillNameInput = document.getElementById('skill-name');
  const skillContent = document.getElementById('skill-content');
  const skillSave = document.getElementById('skill-save');
  const skillCancel = document.getElementById('skill-cancel');
  const skillDelete = document.getElementById('skill-delete');
  const skillsNew = document.getElementById('skills-new');
  const skillsClose = document.getElementById('skills-close');

  let editingSkillName = null;

  async function refreshSkillsLibList() {
    const items = await window.api.listSkillLib();
    setSkillLibCache(items || []);
    skillsListEl.innerHTML = '';
    if (!items || items.length === 0) {
      skillsEmpty.style.display = '';
      return;
    }
    skillsEmpty.style.display = 'none';
    for (const s of items) {
      const el = document.createElement('div');
      el.className = 'prompt-item';
      el.innerHTML = `
        <div class="prompt-item-title">${esc(s.name)}</div>
        <div class="prompt-item-preview">${esc(s.description || '(no description)')}</div>
        ${scopeBadgeHtml(scopeMetaFromContent(s.content))}
        <div class="prompt-item-actions">
          <button data-action="edit">Edit</button>
        </div>
      `;
      el.querySelector('[data-action="edit"]').addEventListener('click', (e) => {
        e.stopPropagation();
        openSkillEditor(s);
      });
      el.addEventListener('click', () => openSkillEditor(s));
      skillsListEl.appendChild(el);
    }
  }

  function openSkillsDrawer(name) {
    skillsDrawer.classList.remove('hidden');
    refreshSkillsLibList();
    if (name === ':new') openSkillEditor(null);
    else if (name) openSkillEditor({ name });
  }
  function closeSkillsDrawer() {
    skillsDrawer.classList.add('hidden');
  }

  async function openSkillEditor(skill = null) {
    if (skill) {
      editingSkillName = skill.name;
      skillEditorTitle.textContent = 'Edit Skill';
      skillNameInput.value = skill.name;
      skillContent.value = (await window.api.getSkillLib(skill.name)) || '';
      skillDelete.style.display = '';
    } else {
      editingSkillName = null;
      skillEditorTitle.textContent = 'New Skill';
      skillNameInput.value = '';
      skillContent.value = '---\ndescription: When to use this skill — be specific so the model picks it at the right moment.\n---\nStep-by-step instructions for the model.';
      skillDelete.style.display = 'none';
    }
    skillNameInput.style.borderColor = '';
    skillEditor.classList.remove('hidden');
    setTimeout(() => skillNameInput.focus(), 50);
  }
  function closeSkillEditor() {
    skillEditor.classList.add('hidden');
    editingSkillName = null;
  }

  skillsClose.addEventListener('click', closeSkillsDrawer);
  skillsNew.addEventListener('click', () => openSkillEditor(null));

  skillSave.addEventListener('click', async () => {
    const name = skillNameInput.value.trim();
    const content = skillContent.value;
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(name)) {
      skillNameInput.style.borderColor = '#e94560';
      return;
    }
    const res = await window.api.saveSkillLib(name, content);
    if (!res || !res.ok) {
      alert(`Failed: ${res && res.error ? res.error : 'unknown error'}`);
      return;
    }
    // Rename: a changed Name field writes a new file — drop the old one.
    if (editingSkillName && editingSkillName !== name) {
      await window.api.removeSkillLib(editingSkillName);
    }
    closeSkillEditor();
    refreshSkillsLibList();
  });

  skillCancel.addEventListener('click', closeSkillEditor);
  skillDelete.addEventListener('click', async () => {
    if (!editingSkillName) return;
    if (!confirm(`Delete skill "${editingSkillName}"?`)) return;
    await window.api.removeSkillLib(editingSkillName);
    closeSkillEditor();
    refreshSkillsLibList();
  });

  skillNameInput.addEventListener('keydown', (e) => e.stopPropagation());
  skillContent.addEventListener('keydown', (e) => e.stopPropagation());
  skillNameInput.addEventListener('input', () => { skillNameInput.style.borderColor = ''; });

  // ---------------------------------------------------------------------------
  // Exec-command registry — operator-authored command defs as
  // ~/.clodex/library/exec/*.json. Mirrors the agents/skills drawer, but the
  // editor body is raw JSON (validated main-side on save) rather than markdown.
  // ---------------------------------------------------------------------------

  const execDrawer = document.getElementById('exec-drawer');
  const execListEl = document.getElementById('exec-list');
  const execEmpty = document.getElementById('exec-empty');
  const execEditor = document.getElementById('exec-editor');
  const execEditorTitle = document.getElementById('exec-editor-title');
  const execNameInput = document.getElementById('exec-name');
  const execContent = document.getElementById('exec-content');
  const execSave = document.getElementById('exec-save');
  const execCancel = document.getElementById('exec-cancel');
  const execDelete = document.getElementById('exec-delete');
  const execNew = document.getElementById('exec-new');
  const execClose = document.getElementById('exec-close');

  let editingExecName = null;

  async function refreshExecList() {
    const items = await window.api.listExecCommands();
    execListEl.innerHTML = '';
    if (!items || items.length === 0) {
      execEmpty.style.display = '';
      return;
    }
    execEmpty.style.display = 'none';
    for (const c of items) {
      const preview = (c.argv || []).join(' ') || '(no argv)';
      const el = document.createElement('div');
      el.className = 'prompt-item';
      el.innerHTML = `
        <div class="prompt-item-title">${esc(c.name)}</div>
        <div class="prompt-item-preview">${esc(preview)}</div>
        <div class="prompt-item-actions">
          <button data-action="edit">Edit</button>
        </div>
      `;
      el.querySelector('[data-action="edit"]').addEventListener('click', (e) => {
        e.stopPropagation();
        openExecEditor(c);
      });
      el.addEventListener('click', () => openExecEditor(c));
      execListEl.appendChild(el);
    }
  }

  function openExecDrawer(name) {
    execDrawer.classList.remove('hidden');
    refreshExecList();
    if (name === ':new') openExecEditor(null);
    else if (name) openExecEditor({ name });
  }
  function closeExecDrawer() {
    execDrawer.classList.add('hidden');
  }

  async function openExecEditor(cmd = null) {
    if (cmd) {
      editingExecName = cmd.name;
      execEditorTitle.textContent = 'Edit Exec Command';
      execNameInput.value = cmd.name;
      execContent.value = (await window.api.getExecCommand(cmd.name)) || '';
      execDelete.style.display = '';
    } else {
      editingExecName = null;
      execEditorTitle.textContent = 'New Exec Command';
      execNameInput.value = '';
      execContent.value = JSON.stringify({
        argv: ['/usr/bin/true'],
        cwd: '',
        timeoutMs: 10000,
        maxBytes: 65536,
        replyStderr: false,
        schema: { type: 'object', additionalProperties: false, required: [], properties: {} },
      }, null, 2);
      execDelete.style.display = 'none';
    }
    execNameInput.style.borderColor = '';
    execEditor.classList.remove('hidden');
    setTimeout(() => execNameInput.focus(), 50);
  }
  function closeExecEditor() {
    execEditor.classList.add('hidden');
    editingExecName = null;
  }

  execClose.addEventListener('click', closeExecDrawer);
  execNew.addEventListener('click', () => openExecEditor(null));

  execSave.addEventListener('click', async () => {
    const name = execNameInput.value.trim();
    const content = execContent.value;
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(name)) {
      execNameInput.style.borderColor = '#e94560';
      return;
    }
    const res = await window.api.saveExecCommand(name, content);
    if (!res || !res.ok) {
      alert(`Failed: ${res && res.error ? res.error : 'unknown error'}`);
      return;
    }
    // Rename: a changed Name field writes a new file — drop the old one.
    if (editingExecName && editingExecName !== name) {
      await window.api.removeExecCommand(editingExecName);
    }
    closeExecEditor();
    refreshExecList();
  });

  execCancel.addEventListener('click', closeExecEditor);
  execDelete.addEventListener('click', async () => {
    if (!editingExecName) return;
    if (!confirm(`Delete exec command "${editingExecName}"?`)) return;
    await window.api.removeExecCommand(editingExecName);
    closeExecEditor();
    refreshExecList();
  });

  execNameInput.addEventListener('keydown', (e) => e.stopPropagation());
  execContent.addEventListener('keydown', (e) => e.stopPropagation());
  execNameInput.addEventListener('input', () => { execNameInput.style.borderColor = ''; });

  window.api.onRequestOpenSkillsDrawer((name) => openSkillsDrawer(name));
  window.api.onRequestOpenAgentsDrawer((name) => openAgentsDrawer(name));
  window.api.onRequestOpenExecDrawer((name) => openExecDrawer(name));
  window.api.onRequestOpenPromptsDrawer(() => openPromptsDrawer());

  // ---------------------------------------------------------------------------
  // Templates library — saved session configs (~/Library/.../templates.json).
  // Unlike the other libraries this drawer has NO inline editor: New/Edit reuse
  // the New Session dialog in template-authoring mode (injected as
  // openTemplateEditor), so a template is edited by the same 8 controls that
  // author a session. This drawer is just the list + New / Edit / Delete.
  // ---------------------------------------------------------------------------

  const templatesDrawer = document.getElementById('templates-drawer');
  const templatesListEl = document.getElementById('templates-list');
  const templatesEmpty = document.getElementById('templates-empty');
  const templatesNew = document.getElementById('templates-new');
  const templatesClose = document.getElementById('templates-close');

  function templateSummary(t) {
    const parts = [];
    if (t.cwd) parts.push(t.cwd);
    // Model rides extraArgs' --model token (shared parser with the dialogs).
    const model = splitModelArg(t.extraArgs).model;
    if (model) parts.push(`model: ${model}`);
    if ((t.agents || []).length) parts.push(`${t.agents.length} agent${t.agents.length > 1 ? 's' : ''}`);
    const gated = (t.disabledTools || []).length + (t.disabledSkills || []).length + (t.denyBuiltins || []).length;
    if (gated) parts.push(`−${gated} gated`);
    // Send-side intent gating is a separate axis from the tool/skill/agent denies
    // above (those bound what the seat can DO; this bounds what [agent:…] verbs it
    // can SEND). Absent/all-enabled → 0 → no chip, matching the −N gated chip's
    // "present only when non-empty" polarity.
    const deniedIntents = deniedIntentCount(t.intents);
    if (deniedIntents) parts.push(`🔒${deniedIntents} intent${deniedIntents > 1 ? 's' : ''}`);
    if ((t.injectSkills || []).length) parts.push(`+${t.injectSkills.length} skill${t.injectSkills.length > 1 ? 's' : ''}`);
    if ((t.execCommands || []).length) parts.push(`⚙${t.execCommands.length} exec`);
    if (t.stripLevel) parts.push(`strip L${t.stripLevel}`);
    if (t.proxy === false) parts.push('proxy off');
    else if (typeof t.proxy === 'string') parts.push('proxy custom');
    return parts.join(' · ') || '(defaults)';
  }

  async function refreshTemplatesList() {
    const items = (await window.api.listTemplates()) || [];
    templatesListEl.innerHTML = '';
    if (items.length === 0) {
      templatesEmpty.style.display = '';
      return;
    }
    templatesEmpty.style.display = 'none';
    for (const t of items) {
      const el = document.createElement('div');
      el.className = 'prompt-item';
      el.innerHTML = `
        <div class="prompt-item-title">${esc(t.name)} <span class="prompt-kind-badge">${esc(t.type || 'claude')}</span></div>
        <div class="prompt-item-preview">${esc(templateSummary(t))}</div>
        <div class="prompt-item-actions">
          <button data-action="edit">Edit</button>
          <button data-action="delete">Delete</button>
        </div>
      `;
      el.querySelector('[data-action="edit"]').addEventListener('click', (e) => {
        e.stopPropagation();
        closeTemplatesDrawer();
        openTemplateEditor(t);
      });
      el.querySelector('[data-action="delete"]').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete template "${t.name}"?`)) return;
        await window.api.removeTemplate(t.id);
        refreshTemplatesList();
      });
      el.addEventListener('click', () => { closeTemplatesDrawer(); openTemplateEditor(t); });
      templatesListEl.appendChild(el);
    }
  }

  function openTemplatesDrawer() {
    templatesDrawer.classList.remove('hidden');
    refreshTemplatesList();
  }
  function closeTemplatesDrawer() {
    templatesDrawer.classList.add('hidden');
  }

  templatesClose.addEventListener('click', closeTemplatesDrawer);
  templatesNew.addEventListener('click', () => { closeTemplatesDrawer(); openTemplateEditor(null); });

  window.api.onRequestOpenTemplatesDrawer(() => openTemplatesDrawer());

  // Hand the core the drawer's list refresh so a dialog-side template save (from
  // the reused New Session dialog) can repaint an open drawer.
  return { refreshTemplatesList };
}

module.exports = { initLibraryDrawers };
