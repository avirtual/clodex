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
});

test('these real ops-log lines carry a key word in PROSE and survive byte-identical', () => {
  for (const line of [
    'web host listening on 127.0.0.1:8080 (token required)',
    'web host listening on 127.0.0.1:8080 (localhost-trust)',
    'web host listening on 0.0.0.0:8080 (INSECURE: no token on a non-loopback bind)',
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

test('rule (a) and the flag branch: API key, access key, private key and credential spellings', () => {
  assert.strictEqual(maskSecrets('ANTHROPIC_API_KEY=sk-ant-abc123 claude'), 'ANTHROPIC_API_KEY=[redacted] claude');
  assert.strictEqual(maskSecrets('export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI'), 'export AWS_SECRET_ACCESS_KEY=[redacted]');
  assert.strictEqual(maskSecrets('x-api-key: sk-ant-zzz'), 'x-api-key=[redacted]');
  assert.strictEqual(maskSecrets('--api-key sk-ant-q'), '--api-key=[redacted]');
  assert.strictEqual(maskSecrets('https://h/x?api_key=zzz'), 'https://h/x?api_key=[redacted]');
  assert.strictEqual(maskSecrets('API_KEY_ID=AKIA1'), 'API_KEY_ID=[redacted]');
  assert.strictEqual(maskSecrets('--private-key k.pem'), '--private-key=[redacted]');
  assert.strictEqual(maskSecrets('credentials: x'), 'credentials=[redacted]');
  assert.strictEqual(maskSecrets('refreshToken=abc'), 'refreshToken=[redacted]');
});

test('the key-word suffix must open with `-` or `_`, so a word merely containing a key word survives', () => {
  for (const line of ['--keyboard foo', 'monkey=1', 'author: bob', 'tokenizer=x']) {
    assert.strictEqual(maskSecrets(line), line);
  }
});

test('a long identifier with no separator is masked in linear time, not cubic', () => {
  for (const line of ['_auth'.repeat(4000), '_auth'.repeat(20000)]) {
    const started = process.hrtime.bigint();
    assert.strictEqual(maskSecrets(line), line);
    assert.ok(process.hrtime.bigint() - started < 2_000_000_000n, `a ${line.length}-byte key-word run took over 2 s`);
  }
});

test('a dense run of rejected `k=v` pairs is masked in linear time', () => {
  const url = 'https://h/p?' + Array.from({ length: 8000 }, (_, i) => `k${i}=v${i}&`).join('');
  for (const line of [url, 'a=b'.repeat(33333), 'a=b'.repeat(133333)]) {
    const started = process.hrtime.bigint();
    assert.strictEqual(maskSecrets(line), line);
    assert.ok(process.hrtime.bigint() - started < 2_000_000_000n, `a ${line.length}-byte k=v run took over 2 s`);
  }
});

test('a long dotted, dashed or path run with no separator is masked in linear time', () => {
  for (const line of ['a.'.repeat(50000), 'a.'.repeat(150000), 'a'.repeat(100000), 'a-'.repeat(50000), 'x.y.z/'.repeat(16667)]) {
    const started = process.hrtime.bigint();
    assert.strictEqual(maskSecrets(line), line);
    assert.ok(process.hrtime.bigint() - started < 2_000_000_000n, `a ${line.length}-byte separator-less run took over 2 s`);
  }
});

test('a run of rejected `x://` scheme candidates is masked in linear time', () => {
  for (const line of ['_a://'.repeat(20000), '_a://'.repeat(80000), '1://'.repeat(40000)]) {
    const started = process.hrtime.bigint();
    assert.strictEqual(maskSecrets(line), line);
    assert.ok(process.hrtime.bigint() - started < 2_000_000_000n, `a ${line.length}-byte rejected-scheme run took over 2 s`);
  }
  const mixed = ('_a://'.repeat(1000) + ' https://h/?sig=x ').repeat(20);
  const started = process.hrtime.bigint();
  assert.strictEqual(maskSecrets(mixed), ('_a://'.repeat(1000) + ' https://h/?sig=[redacted] ').repeat(20));
  assert.ok(process.hrtime.bigint() - started < 2_000_000_000n, 'a mixed rejected-scheme line took over 2 s');
});

test('a URL whose scheme starts mid-run is still found, and a digit-led run is not a scheme', () => {
  assert.strictEqual(maskSecrets('9.https://h/p?sig=abc'), '9.https://h/p?sig=[redacted]');
  assert.strictEqual(maskSecrets('a_b.https://h/?key=abc'), 'a_b.https://h/?key=[redacted]');
  assert.strictEqual(maskSecrets('9://a://h?sig=abc'), '9://a://h?sig=[redacted]');
  assert.strictEqual(maskSecrets('_https://h?sig=abc'), '_https://h?sig=abc');
});

test('the `passwd` and `auth` key words mask', () => {
  assert.strictEqual(maskSecrets('passwd=x'), 'passwd=[redacted]');
  assert.strictEqual(maskSecrets('auth=x'), 'auth=[redacted]');
});

test('the URL credential spellings outside the query rule are masked by the key/value rule', () => {
  for (const name of ['apikey', 'access_token', 'secret', 'password']) {
    assert.strictEqual(maskSecrets(`https://h/p?${name}=x`), `https://h/p?${name}=[redacted]`);
  }
});

test('a quote-led query value is masked through to the next `&`, `#` or whitespace', () => {
  assert.strictEqual(maskSecrets('https://h/p?access_token="v"SECRET'), 'https://h/p?access_token=[redacted]');
  assert.strictEqual(maskSecrets("https://h/p?password='x'tail&a=1"), 'https://h/p?password=[redacted]&a=1');
  assert.strictEqual(maskSecrets('https://h/p?secret="x"tail#f'), 'https://h/p?secret=[redacted]#f');
  assert.strictEqual(maskSecrets('https://h/p?apikey="x"tail z'), 'https://h/p?apikey=[redacted] z');
  assert.strictEqual(maskSecrets('GET https://h/p?token="v"SECRET&x=1'), 'GET https://h/p?token=[redacted]&x=1');
  assert.strictEqual(maskSecrets('https://h/p?api_key="v"LEAK'), 'https://h/p?api_key=[redacted]');
  assert.strictEqual(maskSecrets('https://h/p?api-key="v"LEAK'), 'https://h/p?api-key=[redacted]');
});

test('the URL query rule masks any secret-named parameter through to the next `&` or `#`', () => {
  for (const [url, expected] of [
    ['https://h/p?client_secret="v"a,b&c=1', 'https://h/p?client_secret=[redacted]&c=1'],
    ['https://h/p?x_client_secret="v"a,b&c=1', 'https://h/p?x_client_secret=[redacted]&c=1'],
    ['https://h/p?my-auth-token="v"a,b&c=1', 'https://h/p?my-auth-token=[redacted]&c=1'],
    ['https://h/p?passwd="v"a,b#f', 'https://h/p?passwd=[redacted]#f'],
    ['https://h/p?mykey=v&c=1', 'https://h/p?mykey=v&c=1'],
    ['https://h/p?author=v&c=1', 'https://h/p?author=v&c=1'],
    ['https://h/p?sig=v&c=1', 'https://h/p?sig=[redacted]&c=1'],
    ['https://h/p?clientSecret="v"a,b&c=1', 'https://h/p?clientSecret=[redacted]&c=1'],
    ['https://h/p?accessToken="v"a,b&c=1', 'https://h/p?accessToken=[redacted]&c=1'],
    ['https://h/p?token_type="v"a,b&c=1', 'https://h/p?token_type=[redacted]&c=1'],
    ['https://h/p?bearer="v"a,b&c=1', 'https://h/p?bearer=[redacted]&c=1'],
    ['https://h/p?monkey=v&c=1', 'https://h/p?monkey=v&c=1'],
    ['https://h/p?next=/cb?access_token="v"a,b&c=1', 'https://h/p?next=/cb?access_token=[redacted]&c=1'],
    ['https://h/p?next=/cb?token="v"LEAK,MORE', 'https://h/p?next=/cb?token=[redacted]'],
    ['https://h/p?a=x?password="p"q,r#f', 'https://h/p?a=x?password=[redacted]#f'],
    ['https://h/p?next=/cb?page=2&c=1', 'https://h/p?next=/cb?page=2&c=1'],
    ['https://h/p?sig=abc?def&c=1', 'https://h/p?sig=[redacted]&c=1'],
    ['https://h/p?sig="a?b"c&c=1', 'https://h/p?sig=[redacted]&c=1'],
    ['https://h/?sig=AB?x=CD&y', 'https://h/?sig=[redacted]&y'],
    ['https://h/?key=AB?page=CD&y', 'https://h/?key=[redacted]&y'],
  ]) {
    assert.strictEqual(maskSecrets(url), expected);
  }
});

test('a quote-led secret value with a tail past the closing quote is masked to the next delimiter', () => {
  for (const [line, expected] of [
    ['client_secret="v"LEAK x=1', 'client_secret=[redacted] x=1'],
    ["--passwd='v'LEAK --x=1", '--passwd=[redacted] --x=1'],
    ["--passwd 'v'LEAK --x=1", '--passwd=[redacted] --x=1'],
    ['GET https://h/p?client_secret="v"LEAK&x=1', 'GET https://h/p?client_secret=[redacted]&x=1'],
    ['https://h/p?auth="v"LEAK&y', 'https://h/p?auth=[redacted]&y'],
    ['password="x y" next=1', 'password=[redacted] next=1'],
    ['{"token":"abc123"LEAK,"n":1}', '{"token=[redacted],"n":1}'],
    ['token="v"', 'token=[redacted]'],
    ["--passwd 'v'LEAK&x=1", '--passwd=[redacted]&x=1'],
  ]) {
    assert.strictEqual(maskSecrets(line), expected);
  }
});

test('a long key-word identifier with a value is masked whole', () => {
  assert.strictEqual(maskSecrets('x_token'.repeat(2000) + '=secret'), 'x_token'.repeat(2000) + '=[redacted]');
  assert.strictEqual(maskSecrets('a=token=xyz'), 'a=token=[redacted]');
});
