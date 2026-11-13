'use strict';

function imagesDocker(images, { info = '29.9.2 linux aarch64 8\n', fail = {} } = {}) {
  const calls = [];
  const answer = (args) => {
    const verb = args[0] === 'image' ? `image ${args[1]}` : args[0];
    if (fail[verb]) return fail[verb];
    if (args[0] === 'info') return { stdout: info };
    if (args[0] === 'ps') return { stdout: '' };
    if (args[0] === 'image' && args[1] === 'ls') {
      const want = args[args.length - 1].replace(/^label=/, '');
      return { stdout: images.filter((im) => (im.labels || []).includes(want)).map((im) => `${im.id}\n`).join('') };
    }
    if (args[0] === 'image' && args[1] === 'inspect') {
      const ids = args.slice(4);
      const found = ids.map((id) => images.find((im) => im.id === id));
      const out = found.filter(Boolean).map((im) => `${im.id} ${im.os || 'linux'} ${im.arch || 'arm64'}\n`).join('');
      return found.every(Boolean) ? { stdout: out } : { ok: false, code: 1, stdout: out, stderr: `Error: No such image: ${ids[found.indexOf(undefined)]}` };
    }
    return {};
  };
  return {
    calls,
    call: async (args, opts) => {
      calls.push({ args, opts });
      return { ok: true, code: 0, stdout: '', stderr: '', notFound: false, timedOut: false, error: null, ...answer(args) };
    },
  };
}

module.exports = { imagesDocker };
