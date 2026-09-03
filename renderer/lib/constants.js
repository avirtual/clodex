// constants.js — static UI data tables shared across renderer.js and the
// render-html builders. Pure data: no DOM, no state, no imports. Extracted so
// the palette/label/color tables document themselves in one place and (for the
// simple ones) get a smoke test that they stay well-formed.
//
// NOTE: PEER_UI_KINDS is intentionally NOT here — its entries close over
// renderer functions (openFilePeek), so it is not pure data and stays in
// renderer.js.

// ---------------------------------------------------------------------------
// Themes — chrome retints via CSS [data-theme]; each theme also carries an
// xterm color object (incl. the 16-color ANSI palette) since the terminal's
// palette lives in JS, not CSS. 'midnight' is the default (matches :root).
// ---------------------------------------------------------------------------
const THEMES = {
  midnight: {
    label: 'Midnight (default)',
    xterm: {
      background: '#1a1a2e', foreground: '#eee', cursor: '#e94560',
      selectionBackground: '#3a4a6a',
      black: '#1a1a2e', red: '#e94560', green: '#4ade80', yellow: '#fbbf24',
      blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#eee',
      brightBlack: '#6b7689', brightRed: '#ff6b81', brightGreen: '#86efac',
      brightYellow: '#fde047', brightBlue: '#93c5fd', brightMagenta: '#d8b4fe',
      brightCyan: '#67e8f9', brightWhite: '#fff',
    },
    echo: { bg: '#262a44', fg: '#eeeeee', prompt: '#e94560' },
  },
  claude: {
    label: 'Claude (warm dark)',
    xterm: {
      background: '#262624', foreground: '#f5f4ef', cursor: '#d97757',
      selectionBackground: '#4a4641',
      black: '#3a3733', red: '#e0816b', green: '#a3b18a', yellow: '#d9a55b',
      blue: '#7da3c4', magenta: '#b08cba', cyan: '#6fb3b8', white: '#f5f4ef',
      brightBlack: '#9b9690', brightRed: '#eb9a85', brightGreen: '#bcc7a6',
      brightYellow: '#e6bd7c', brightBlue: '#9bbcd6', brightMagenta: '#c6a7ce',
      brightCyan: '#8ec9cd', brightWhite: '#fffefb',
    },
    echo: { bg: '#33312d', fg: '#f5f4ef', prompt: '#d97757' },
  },
  paper: {
    label: 'Paper (dim light)',
    // A toned light theme between Midnight and Light: warm sepia ground, ink
    // (not black) text. Palette derives from Light's, darkened a step so the
    // ANSI colors keep their contrast on the dimmer ground.
    xterm: {
      background: '#ece8dc', foreground: '#33302a', cursor: '#c15f3c',
      selectionBackground: '#d9d2bf',
      black: '#33302a', red: '#b03f2b', green: '#4a7136', yellow: '#8f6419',
      blue: '#28629c', magenta: '#7f4a92', cyan: '#2a7f84', white: '#5c5852',
      brightBlack: '#5c5852', brightRed: '#9c331d', brightGreen: '#3b5f2d',
      brightYellow: '#7c5413', brightBlue: '#20548c', brightMagenta: '#6e3b7f',
      brightCyan: '#226c71', brightWhite: '#33302a',
    },
    echo: { bg: '#dcd6c3', fg: '#33302a', prompt: '#9c331d' },
  },
  light: {
    label: 'Light',
    xterm: {
      background: '#faf9f5', foreground: '#1f1e1d', cursor: '#c15f3c',
      selectionBackground: '#d8e2ec',
      black: '#1f1e1d', red: '#c1442e', green: '#4f7a3a', yellow: '#9a6b1e',
      blue: '#2b6cb0', magenta: '#8a4f9e', cyan: '#2d8a8f', white: '#5c5852',
      brightBlack: '#6b6862', brightRed: '#a8351f', brightGreen: '#3f6630',
      brightYellow: '#855a14', brightBlue: '#225a96', brightMagenta: '#763f88',
      brightCyan: '#247479', brightWhite: '#1f1e1d',
    },
    echo: { bg: '#e8e4d9', fg: '#1f1e1d', prompt: '#a8351f' },
  },
};

const STRIP_LEVELS = [
  { lvl: 0, name: 'Off', desc: 'No stripping' },
  { lvl: 1, name: 'Level 1 — thinking', desc: 'Strip prior-turn reasoning (~30% off, no visible degradation)' },
  { lvl: 2, name: 'Level 2 — + edit-acks & failed calls', desc: 'Also collapse succeeded edit/write acks and stub failed tool calls (only reclaims while L1 is stripping)' },
];

const SEV_LINE = {
  current: 'Up to date with your Clodex.',
  patch: 'One patch release behind your Clodex.',
  minor: 'A minor version behind your Clodex.',
  major: 'A major version behind your Clodex.',
  newer: 'Newer than your Clodex — this machine is the older one.',
  unknown: '',
};

const CTX_CAT_LABELS = {
  tools: 'Tools', system: 'System prompt', claudemd: 'CLAUDE.md',
  useremail: 'User email', user: 'User messages', assistant: 'Assistant',
  thinking: 'Thinking', tool_calls: 'Tool calls', tool_results: 'Tool results',
  agents: 'Agents', skills: 'Skills',
};

// read = window carriage, write = cache toll, generation = output (receipt-exact).
const COST_SPINE = [
  { key: 'read', label: 'read · carriage', color: '#61afef' },
  { key: 'write', label: 'write · cache toll', color: '#e5c07b' },
  { key: 'generation', label: 'generation · output', color: '#98c379' },
];
// content_carriage_est apportions the READ dollars to content (estimate).
const COST_CONTENT = [
  { key: 'conversation', label: 'conversation', color: '#61afef' },
  { key: 'preamble', label: 'preamble', color: '#98c379' },
  { key: 'thinking', label: 'thinking', color: '#c678dd' },
];

// Fault → how the row reads. `content` is the actionable class (a real prefix
// change); `environment`/`self` are expected and render calm. Unknown/absent
// faults fall back to neutral so a pre-v0.6.20 proxy still renders cleanly.
const BUST_FAULT = {
  content:     { cls: 'bust-fault-content', label: 'prefix changed' },
  environment: { cls: 'bust-fault-env',     label: 'cache went cold' },
  self:        { cls: 'bust-fault-self',    label: 'designed strip cost' },
};

// Stable colors shared by each stacked bar and its legend.
const REP_BUCKET_COLOR = {
  cache_read: '#61afef', cache_write_initial: '#56b6c2',
  cache_write_rewrite: '#e5c07b', uncached_input: '#e06c75', output: '#98c379',
};
const REP_BUCKET_LABEL = {
  cache_read: 'Cache read', cache_write_initial: 'Cache write (initial)',
  cache_write_rewrite: 'Cache write (rewrite)', uncached_input: 'Uncached input',
  output: 'Output',
};
const REP_CAT_COLOR = {
  system: '#61afef', claudemd: '#e5c07b', useremail: '#c678dd',
  skills: '#56b6c2', tools: '#98c379',
};

module.exports = {
  THEMES, STRIP_LEVELS, SEV_LINE, CTX_CAT_LABELS,
  COST_SPINE, COST_CONTENT, BUST_FAULT,
  REP_BUCKET_COLOR, REP_BUCKET_LABEL, REP_CAT_COLOR,
};

