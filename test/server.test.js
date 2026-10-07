'use strict';

// Plays a full round over real WebSockets and checks what each device is sent.

const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { start } = require('../server');

function connect(port) {
  const ws = new WebSocket(`ws://localhost:${port}`);
  const client = { ws, raw: [], state: null, joined: null, errors: [], waiters: [] };
  ws.on('message', (data) => {
    const text = data.toString();
    const msg = JSON.parse(text);
    if (msg.t === 'hello') return;
    client.raw.push(text);
    if (msg.t === 'state') client.state = msg.state;
    if (msg.t === 'joined') client.joined = msg;
    if (msg.t === 'error') client.errors.push(msg.message);
    client.waiters = client.waiters.filter((waiter) => !waiter());
  });
  client.send = (msg) => ws.send(JSON.stringify(msg));
  client.until = (check, label = 'condition') =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 3000);
      const waiter = () => {
        if (!check(client)) return false;
        clearTimeout(timer);
        resolve(client);
        return true;
      };
      if (!waiter()) client.waiters.push(waiter);
    });
  client.phase = (phase) => client.until((c) => c.state && c.state.phase === phase, `phase ${phase}`);
  return new Promise((resolve) => ws.on('open', () => resolve(client)));
}

test('a full round with four devices stays in sync and keeps secrets', async (t) => {
  const server = await start({ port: 0 });
  t.after(() => server.close());

  const names = ['Ana', 'Ben', 'Cy', 'Di'];
  const clients = await Promise.all(names.map(() => connect(server.port)));
  const [host, ...guests] = clients;
  const everyone = (phase) => Promise.all(clients.map((c) => c.phase(phase)));

  // Lobby
  host.send({ t: 'create', name: names[0] });
  await host.phase('lobby');
  const code = host.joined.code;
  assert.match(code, /^[A-Z]{4}$/);
  guests.forEach((guest, i) => guest.send({ t: 'join', code: code.toLowerCase(), name: names[i + 1] }));
  await Promise.all(clients.map((c) => c.until((x) => x.state && x.state.players.length === 4, 'four players')));
  assert.deepEqual(guests[2].state.players.map((p) => p.name), names);

  guests[0].send({ t: 'start' });
  await guests[0].until((c) => c.errors.length === 1, 'host-only error');
  assert.equal(host.state.phase, 'lobby');

  host.send({ t: 'settings', topics: ['food'], timer: 60 });
  host.send({ t: 'start' });
  await everyone('answer');

  // Answer: three matching questions and one odd one out
  const questions = clients.map((c) => c.state.round.question);
  const real = questions.find((q) => questions.filter((x) => x === q).length === 3);
  const odd = questions.find((q) => q !== real);
  assert.ok(real && odd, `expected a 3 + 1 split, got ${JSON.stringify(questions)}`);
  const imposter = clients[questions.indexOf(odd)];

  clients.slice(0, 3).forEach((c, i) => c.send({ t: 'answer', text: `secret-${names[i]}` }));
  await Promise.all(clients.map((c) => c.until((x) => x.state.players.filter((p) => p.answered).length === 3, 'three answers')));

  clients.forEach((client, i) => {
    const seen = client.raw.join('\n');
    assert.ok(!seen.includes(client === imposter ? real : odd), `${names[i]} was never sent the other question`);
    assert.ok(!seen.includes('imposter'), `${names[i]} was not told who the imposter is`);
    names.forEach((name, j) => {
      if (j !== i) assert.ok(!seen.includes(`secret-${name}`), `${names[i]} was not sent ${name}'s answer early`);
    });
  });

  // Reveal, for everyone at once
  clients[3].send({ t: 'answer', text: 'secret-Di' });
  await everyone('reveal');
  for (const client of clients) {
    assert.equal(client.state.round.realQuestion, real);
    assert.deepEqual(client.state.round.answers.map((a) => a.text), names.map((n) => `secret-${n}`));
    assert.ok(!client.raw.join('\n').includes('imposterId'));
  }

  // Discussion with a timer the host can skip
  host.send({ t: 'skip' });
  await everyone('discuss');
  assert.ok(host.state.endsAt > host.state.now);
  host.send({ t: 'skip' });
  await everyone('vote');

  // Vote: hidden until the last one lands
  const scapegoat = clients.find((c) => c !== imposter);
  const idOf = (c) => c.state.youId;
  const voters = clients.filter((c) => c !== imposter);
  voters.forEach((c) => c.send({ t: 'vote', target: idOf(imposter) }));
  await Promise.all(clients.map((c) => c.until((x) => x.state.players.filter((p) => p.voted).length === 3, 'three votes')));
  for (const client of clients) {
    assert.equal(client.state.phase, 'vote');
    assert.ok(!client.raw.join('\n').includes('"result"'));
  }
  imposter.send({ t: 'vote', target: idOf(imposter) });
  await imposter.until((c) => c.errors.includes('You cannot vote for yourself'), 'self-vote error');
  imposter.send({ t: 'vote', target: idOf(scapegoat) });
  await everyone('result');

  // Result
  for (const client of clients) {
    const { result } = client.state.round;
    assert.equal(result.winner, 'players');
    assert.equal(result.imposterId, idOf(imposter));
    assert.equal(result.imposterQuestion, odd);
    assert.equal(result.tally[0].votes, 3);
    const scores = Object.fromEntries(client.state.players.map((p) => [p.id, p.score]));
    for (const c of clients) assert.equal(scores[idOf(c)], c === imposter ? 0 : 1);
  }

  // A refresh rejoins the same seat
  const ben = guests[0];
  ben.ws.close();
  await host.until((c) => c.state.players[1].connected === false, 'Ben away');
  const back = await connect(server.port);
  back.send({ t: 'join', code, name: 'Ben', token: ben.joined.token });
  await back.phase('result');
  assert.equal(back.state.youId, idOf(ben));
  await host.until((c) => c.state.players[1].connected === true, 'Ben back');

  // Next round uses a new question
  host.send({ t: 'start' });
  await Promise.all([host, back, guests[1], guests[2]].map((c) => c.until((x) => x.state.phase === 'answer' && x.state.round.number === 2, 'round 2')));
  const next = [host, back, guests[1], guests[2]].map((c) => c.state.round.question);
  assert.ok(!next.includes(real) && !next.includes(odd));
});

test('joining a room that does not exist fails cleanly', async (t) => {
  const server = await start({ port: 0 });
  t.after(() => server.close());
  const client = await connect(server.port);
  client.send({ t: 'join', code: 'ZZZZ', name: 'Ana' });
  await client.until((c) => c.errors.length === 1, 'error');
  assert.match(client.errors[0], /No room/);
  assert.equal(client.state, null);
});
