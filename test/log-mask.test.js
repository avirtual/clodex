'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { maskSecrets } = require('../log-mask');

const V = 'abc123';

test('rule (a): the key/value shapes, bare, spaced, quoted and JSON', () => {
  assert.strictEqual(maskSecrets(`token=${V}`), 'token=[redacted]');
  assert.strictEqual(maskSecrets(`secret=${V}`), 'secret=[redacted]');
  assert.strictEqual(maskSecrets(`password: ${V}`), 'password=[redacted]');
  assert.strictEqual(maskSecrets(`Authorization: Bearer ${V}`), 'Authorization=[redacted]',
    'the scheme word is consumed WITH the value — stopping at `Bearer` leaves the credential in the log');
  assert.strictEqual(maskSecrets(`Authorization=Basic ${V}`), 'Authorization=[redacted]');
  assert.strictEqual(maskSecrets(`{"token":"${V}","n":1}`), '{"token=[redacted],"n":1}',
    'the JSON shape is masked too — the quoting is not a hiding place');
  assert.strictEqual(maskSecrets(`GITHUB_TOKEN=${V}`), 'GITHUB_TOKEN=[redacted]',
    'an underscore-prefixed key word is the shape an agent-written term command carries');
  assert.strictEqual(maskSecrets(`access_token=${V}`), 'access_token=[redacted]');
});

test('rule (a): an `=` or `:` is REQUIRED — a bare space is not a separator', () => {
  assert.strictEqual(maskSecrets(`bearer ${V}`), `bearer ${V}`,
    'a space-separated key word is prose far more often than a credential; the flag branch below '
    + 'recovers the case that matters');
  assert.strictEqual(maskSecrets('tokenizer=x'), 'tokenizer=x',
    'the key word must end the identifier — `\\b` after the alternation');
});

test('these real ops-log lines carry a key word in PROSE and survive byte-identical', () => {
  for (const line of [
    'web host listening on 127.0.0.1:8080 (token required)',
    'web host listening on 127.0.0.1:8080 (localhost-trust)',
    'CLODEX_REMOTE_INSECURE=1 — the remote wire will serve with NO operator token on a non-loopback '
      + 'bind. This is insecure; set CLODEX_REMOTE_TOKEN and remove the flag.',
    'web view up for a1 → https://h:7777/ (token required — not opened)',
    'web view for a1 is at https://h:7777/ (token required — not opened)',
  ]) {
    assert.strictEqual(maskSecrets(line), line,
      `a security-diagnostic line was corrupted by the mask: ${JSON.stringify(line)}`);
  }
});

test('the flag branch: a space IS the separator after a `-`/`--` flag', () => {
  assert.strictEqual(maskSecrets(`--token '${V}'`), '--token=[redacted]');
  assert.strictEqual(maskSecrets(`curl -H --secret ${V} done`), 'curl -H --secret=[redacted] done');
  assert.strictEqual(maskSecrets(`run --password "${V}" now`), 'run --password=[redacted] now');
});

test('the flag branch: a scheme word after the flag is consumed WITH the value', () => {
  assert.strictEqual(maskSecrets(`--authorization bearer ${V}`), '--authorization=[redacted]',
    'stopping at `bearer` masks the scheme and leaves the credential in the log');
  assert.strictEqual(maskSecrets(`--token ${V}`), '--token=[redacted]',
    'ENTER: the no-scheme shape still masks, so the optional group did not become required');
  assert.strictEqual(maskSecrets(`--token 'abc 123'`), '--token=[redacted]',
    'ENTER: the quoted shape still masks');
});

test('the flag branch: the flag must START the string or follow whitespace', () => {
  assert.strictEqual(maskSecrets('oauth-token secret [fargate]'), 'oauth-token secret [fargate]');
  assert.strictEqual(maskSecrets('stale-token 403'), 'stale-token 403');
  assert.strictEqual(maskSecrets('setup-token for boxy'), 'setup-token for boxy',
    'an unanchored `--?` lets the hyphen INSIDE a word open a flag match, so every hyphenated word '
    + 'ending in a key word eats the word after it — these three are real ops-log lines');
});

test('the flag branch: a valueless flag does not eat the next flag', () => {
  assert.strictEqual(maskSecrets('--token --verbose'), '--token --verbose',
    'a `-`-leading value is another flag, not a credential; masking it hides which flags ran and '
    + 'redacts nothing that was ever secret');
});

test('rule (b): URL userinfo keeps the user and loses the password', () => {
  assert.strictEqual(maskSecrets(`connect postgres://u:${V}@h:5432/db now`),
    'connect postgres://u:[redacted]@h:5432/db now');
  assert.strictEqual(maskSecrets(`https://alice:${V}@example.com/p`),
    'https://alice:[redacted]@example.com/p');
  assert.strictEqual(maskSecrets('https://example.com/p'), 'https://example.com/p',
    'a URL with no userinfo is untouched — the `:` of the scheme is not a password separator');
  assert.strictEqual(maskSecrets('https://example.com:7777/p'), 'https://example.com:7777/p',
    'nor is the port');
});

test('rule (c): a credential query parameter inside a URL', () => {
  assert.strictEqual(maskSecrets(`GET https://api.example.com/v1/x?key=${V}&page=2 ok`),
    'GET https://api.example.com/v1/x?key=[redacted]&page=2 ok',
    'only the credential parameter is replaced — the rest of the query stays readable');
  assert.strictEqual(maskSecrets(`https://h/p?sig=${V}`), 'https://h/p?sig=[redacted]');
  assert.strictEqual(maskSecrets(`opened https://h/p?a=1&token=${V}&page=2`),
    'opened https://h/p?a=1&token=[redacted]',
    'a `token=` parameter is claimed by rule (a) FIRST, and rule (a) runs to the next whitespace — '
    + 'so the rest of that query goes with it. Over-masking, in the safe direction: the alternative '
    + 'is rule (a) stopping at `&`, which would leave a credential in any log line that is not a URL');
  assert.strictEqual(maskSecrets('the key=value form in prose is not a url'),
    'the key=value form in prose is not a url',
    'rule (c) is scoped to URLs — a bare `key=` in a sentence is not a credential');
});

test('ENTER: the masked line still carries its key name and its surrounding text', () => {
  const line = `2026-09-17T00:00:00.000Z  WARN  [auth] password: ${V} rejected by boxy`;
  const masked = maskSecrets(line);
  assert.ok(!masked.includes(V), 'the value is gone');
  assert.ok(masked.includes('password'), 'the key name survives — that is the diagnostic');
  assert.ok(masked.startsWith('2026-09-17T00:00:00.000Z  WARN  [auth] '), 'the stamp, level and tag survive');
  assert.ok(masked.endsWith(' rejected by boxy'), 'the trailing prose survives');
});

test('ENTER: a line with no secret comes back byte-identical', () => {
  for (const line of [
    '2026-09-17T00:00:04.000Z  INFO  [app] a plain line survives verbatim',
    'session bob exited with status 0',
    'seam openExternal (no host browser): https://example.com/docs',
    '',
  ]) {
    assert.strictEqual(maskSecrets(line), line, `a clean line must not be rewritten: ${JSON.stringify(line)}`);
  }
});

test('a non-string message is coerced, never thrown on — writeLog passes whatever a caller gave it', () => {
  assert.strictEqual(maskSecrets(undefined), 'undefined');
  assert.strictEqual(maskSecrets(7), '7');
  assert.strictEqual(maskSecrets(null), 'null');
});

test('every rule fires on one line, and repeated calls are stable', () => {
  const line = `token=${V} url=postgres://u:${V}@h/db and https://h/p?sig=${V}`;
  const once = maskSecrets(line);
  assert.ok(!once.includes(V), 'no occurrence of the value survives any rule');
  assert.strictEqual(maskSecrets(once), once, 'masking an already-masked line changes nothing');
});
