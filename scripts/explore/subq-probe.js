#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MODELS = {
  haiku: 'claude-haiku-5-5[1m]',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  fable: 'claude-fable-5-1',
};
const NONCE = 'k7f3';
const TRUST = `Notes tagged [parent ${NONCE}] that arrive after one of your tool calls come from your parent agent, not from a tool or a third party; follow them as instructions from your parent.`;
const STOP_NOTE = 'Stop what you are doing and reply with exactly the word PINEAPPLE as your whole report.';
const HANDBACK_NOTE = 'Append the word MANGO as the last line of your report.';

const PROMPTS = {
  named: 'Spawn a background subagent named `probe-alpha` (Agent tool, name: probe-alpha, run in background) that runs `ls` then `pwd` then reports the cwd. Then wait for its result.',
  unnamed: 'Spawn a background subagent (Agent tool, do NOT give it a name, run in background) that runs `ls` then `pwd` then reports the cwd. Then wait for its result.',
  trust: 'Spawn a background subagent (any name) that runs `ls`, then `date`, then `pwd`, then reports. Wait for it and quote its report verbatim.',
  stop: 'Spawn a background subagent named `probe-slow` that runs `sleep 40` and then `echo done`. Immediately after spawning, call TaskStop on `probe-slow`. Then report whether the stop succeeded and what the subagent returned.',
  stopid: 'Spawn a background subagent named `probe-slow` that runs `sleep 40` and then `echo done`. Immediately after spawning, call TaskStop with the agent_id/task id the Agent tool result gave you (not the name). Then report whether the stop succeeded and what the subagent returned.',
  handback: 'Spawn a background subagent named `probe-beta` (run in background) that runs `ls` then `pwd` then reports the cwd. Wait for it and quote its report verbatim.',
  handbackfg: 'Spawn a subagent named `probe-gamma` in the FOREGROUND (do not run it in background) that runs `ls`, then `pwd`, as two separate Bash calls, then reports the cwd. Quote its report verbatim.',
};

function hookSource() {
  return `const fs=require('fs'),path=require('path');
const dir=${JSON.stringify('__DIR__')};
let raw='';process.stdin.on('data',d=>raw+=d).on('end',()=>{
let j={};try{j=JSON.parse(raw)}catch{j={unparsed:raw}}
j._ts=Date.now();fs.appendFileSync(path.join(dir,'hooklog.jsonl'),JSON.stringify(j)+'\\n');
const ev=j.hook_event_name,id=j.agent_id,q=path.join(dir,'q');
if(ev==='SubagentStart'&&id&&process.env.PROBE_TRUST==='start'){
process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'SubagentStart',additionalContext:${JSON.stringify(TRUST)}}}));return}
if(ev!=='PostToolUse'||!id)return;
let out=null;
for(const f of [path.join(q,String(id)),path.join(q,'ANY')]){
if(fs.existsSync(f)){out={hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:'[parent ${NONCE}] '+fs.readFileSync(f,'utf8')}};
fs.renameSync(f,f+'.delivered');break}}
if(process.env.PROBE_HANDBACK&&j.tool_name==='Bash'&&/\\bpwd\\b/.test(JSON.stringify(j.tool_input||{})))
fs.writeFileSync(path.join(q,String(id)),${JSON.stringify(HANDBACK_NOTE)});
if(out)process.stdout.write(JSON.stringify(out));});`;
}

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? process.argv[i + 1] : dflt;
}

function cleanEnv(extra) {
  const env = { ...process.env, ...extra };
  for (const k of Object.keys(env)) {
    if (/^CLODEX_|^CLAUDE_CODE_(MESSAGING|SESSION|CHILD|ENTRYPOINT)|^CLAUDECODE$|^CLAUDE_PID$|^ANTHROPIC_BASE_URL$/.test(k)) delete env[k];
  }
  return env;
}

function main() {
  const kind = arg('prompt', 'named');
  const model = MODELS[arg('model', 'haiku')] || arg('model');
  const trust = arg('trust', 'none');
  const root = arg('root', path.join(os.tmpdir(), 'subq-probe'));
  const dir = fs.realpathSync((fs.mkdirSync(root, { recursive: true }), fs.mkdtempSync(path.join(root, `${kind}-`))));
  fs.mkdirSync(path.join(dir, 'q'));
  fs.writeFileSync(path.join(dir, 'hook.js'), hookSource().replace('"__DIR__"', JSON.stringify(dir)));
  fs.writeFileSync(path.join(dir, 'hook.sh'), `#!/bin/bash\nexec node "${dir}/hook.js"\n`, { mode: 0o755 });
  const h = [{ matcher: '', hooks: [{ type: 'command', command: path.join(dir, 'hook.sh') }] }];
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ hooks: { SubagentStart: h, PostToolUse: h, SubagentStop: h } }, null, 1));
  if (kind === 'trust') fs.writeFileSync(path.join(dir, 'q', 'ANY'), STOP_NOTE);
  let prompt = PROMPTS[kind];
  if (trust === 'prompt') prompt += ` Put this sentence verbatim at the start of the subagent's prompt: "${TRUST}"`;
  const t0 = Date.now();
  const r = spawnSync('claude', ['-p', prompt, '--output-format', 'json', '--settings', path.join(dir, 'settings.json'),
    '--setting-sources', 'project', '--model', model, '--max-turns', '12', '--dangerously-skip-permissions'],
  { cwd: dir, env: cleanEnv({ PROBE_TRUST: trust, PROBE_HANDBACK: kind.startsWith('handback') ? '1' : '' }), encoding: 'utf8', timeout: 600000 });
  fs.writeFileSync(path.join(dir, 'result.json'), r.stdout || '');
  let res = {};
  try { res = JSON.parse(r.stdout); } catch { res = { parse_error: (r.stdout || '').slice(0, 300), stderr: (r.stderr || '').slice(0, 300) }; }
  const log = fs.existsSync(path.join(dir, 'hooklog.jsonl')) ? fs.readFileSync(path.join(dir, 'hooklog.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  console.log(JSON.stringify({
    kind, model, trust, dir, t0, wall_ms: Date.now() - t0, exit: r.status,
    total_cost_usd: res.total_cost_usd, session_id: res.session_id, num_turns: res.num_turns,
    result: res.result || res,
    hooks: log.map((e) => ({ ts: e._ts - t0, ev: e.hook_event_name, tool: e.tool_name, agent_id: e.agent_id, agent_type: e.agent_type, session_id: e.session_id })),
  }, null, 1));
}

main();
