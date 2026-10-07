'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Room, GameError } = require('../src/game');
const { TOPICS, PAIRS } = require('../src/questions');

function seeded(seed = 7) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function roomWith(names, options = { rng: seeded() }) {
  const room = new Room('TEST', options);
  const players = names.map((name) => room.join(name));
  return { room, players, host: players[0] };
}

const answerAll = (room) => room.round.participants.forEach((id) => room.submitAnswer(id, `secret-${id}`));

function playToVote(room, host) {
  answerAll(room);
  room.advance(host.id); // reveal -> discuss
  room.advance(host.id); // discuss -> vote
}

// Everyone votes for `target`; the target votes for `fallback`.
function voteFor(room, target, fallback) {
  for (const id of room.round.participants) room.submitVote(id, id === target ? fallback : target);
}

test('question bank: every topic has at least 20 well-formed pairs', () => {
  assert.equal(TOPICS.length, 10);
  for (const topic of TOPICS) {
    const pairs = PAIRS.filter((p) => p.topic === topic.id);
    assert.ok(pairs.length >= 20, `${topic.name} has ${pairs.length} pairs`);
  }
  assert.equal(new Set(PAIRS.map((p) => p.id)).size, PAIRS.length);
  const questions = PAIRS.flatMap((p) => [p.real, p.imposter]);
  assert.equal(new Set(questions).size, questions.length, 'no question appears twice');
  for (const pair of PAIRS) {
    assert.ok(pair.real.endsWith('?') && pair.imposter.endsWith('?'), pair.id);
    assert.ok(pair.real.length <= 80 && pair.imposter.length <= 80, `${pair.id} is short`);
  }
  assert.ok(PAIRS.filter((p) => p.topic === 'group').every((p) => p.answerType === 'player' && p.real.startsWith('Who')));
});

test('lobby: needs 3 players, holds 10, and only the host can start', () => {
  const { room, host, players } = roomWith(['Ana', 'Ben']);
  assert.throws(() => room.startRound(host.id), GameError);
  for (let i = 3; i <= 10; i++) room.join(`Player ${i}`);
  assert.throws(() => room.join('One too many'), /full/);
  assert.throws(() => room.startRound(players[1].id), /host/);
  room.startRound(host.id);
  assert.equal(room.phase, 'answer');
  assert.equal(room.round.participants.length, 10);
});

test('lobby: names must be unique while that player is connected', () => {
  const { room } = roomWith(['Ana', 'Ben', 'Cy']);
  assert.throws(() => room.join('  ana '), /already in this room/);
  assert.throws(() => room.join('   '), /name/);
});

test('rejoin: same seat by token, or by name once disconnected', () => {
  const { room, players, host } = roomWith(['Ana', 'Ben', 'Cy']);
  const ben = players[1];
  ben.score = 2;
  room.startRound(host.id);

  room.disconnect(ben.id);
  assert.equal(room.join('ignored', ben.token), ben, 'token restores the seat mid-round');

  room.disconnect(ben.id);
  const again = room.join('ben');
  assert.equal(again.id, ben.id);
  assert.equal(again.score, 2);
  assert.equal(again.connected, true);
  assert.ok(room.round.participants.includes(again.id), 'still in the running round');
  assert.equal(room.players.length, 3);
});

test('round: exactly one imposter gets the other question', () => {
  const { room, host } = roomWith(['Ana', 'Ben', 'Cy', 'Di']);
  room.startRound(host.id);
  const { pair, imposterId } = room.round;
  for (const p of room.players) {
    const view = room.viewFor(p.id);
    assert.equal(view.round.question, p.id === imposterId ? pair.imposter : pair.real);
  }
  const questions = room.players.map((p) => room.viewFor(p.id).round.question);
  assert.equal(questions.filter((q) => q === pair.real).length, 3);
  assert.equal(questions.filter((q) => q === pair.imposter).length, 1);
});

test('the imposter is chosen at random', () => {
  const { room, host } = roomWith(['Ana', 'Ben', 'Cy', 'Di']);
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    room.startRound(host.id);
    seen.add(room.round.imposterId);
    room.backToLobby(host.id);
  }
  assert.equal(seen.size, 4);
});

test('privacy: nothing about other players leaks before the reveal', () => {
  const { room, host } = roomWith(['Ana', 'Ben', 'Cy', 'Di']);
  room.startRound(host.id);
  const { pair, imposterId, participants } = room.round;
  participants.slice(0, 3).forEach((id) => room.submitAnswer(id, `secret-${id}`));
  assert.equal(room.phase, 'answer');

  for (const p of room.players) {
    const view = room.viewFor(p.id);
    const raw = JSON.stringify(view);
    const otherQuestion = p.id === imposterId ? pair.real : pair.imposter;
    assert.ok(!raw.includes(otherQuestion), `${p.name} cannot see the other question`);
    assert.ok(!raw.includes('imposter'), `${p.name} is not told who the imposter is`);
    for (const id of participants) {
      if (id !== p.id) assert.ok(!raw.includes(`secret-${id}`), `${p.name} cannot see ${id}'s answer`);
    }
    assert.equal(view.round.answers, undefined);
    assert.deepEqual(
      view.players.map((x) => x.answered),
      [true, true, true, false],
      'everyone sees who has answered'
    );
  }
});

test('reveal: all screens get the real question and every answer at once', () => {
  const { room, host } = roomWith(['Ana', 'Ben', 'Cy', 'Di']);
  room.startRound(host.id);
  const { pair } = room.round;
  answerAll(room);
  assert.equal(room.phase, 'reveal');
  const views = room.players.map((p) => room.viewFor(p.id).round);
  for (const view of views) {
    assert.equal(view.realQuestion, pair.real);
    assert.equal(view.question, undefined, 'screens look the same from here on');
    assert.deepEqual(view.answers, views[0].answers);
    assert.equal(view.answers.length, 4);
    assert.ok(!JSON.stringify(view).includes(pair.imposter), 'the imposter question stays hidden until the result');
  }
});

test('timers: reveal and discussion move on by themselves', () => {
  let now = 1_000_000;
  const { room, host } = roomWith(['Ana', 'Ben', 'Cy'], { rng: seeded(), now: () => now });
  room.updateSettings(host.id, { timer: 60 });
  room.startRound(host.id);
  answerAll(room);
  assert.equal(room.phase, 'reveal');
  assert.equal(room.expire(), false);
  now = room.endsAt;
  assert.equal(room.expire(), true);
  assert.equal(room.phase, 'discuss');
  assert.equal(room.endsAt, now + 60_000);
  now += 59_000;
  assert.equal(room.expire(), false);
  now += 1_000;
  assert.equal(room.expire(), true);
  assert.equal(room.phase, 'vote');
  assert.equal(room.endsAt, null);
});

test('timers: with the timer off, discussion waits for the host', () => {
  const { room, host, players } = roomWith(['Ana', 'Ben', 'Cy']);
  room.updateSettings(host.id, { timer: 0 });
  room.startRound(host.id);
  answerAll(room);
  room.advance(host.id);
  assert.equal(room.phase, 'discuss');
  assert.equal(room.endsAt, null);
  assert.throws(() => room.advance(players[1].id), /host/);
  room.advance(host.id);
  assert.equal(room.phase, 'vote');
});

test('vote: no self votes, one vote each, hidden until everyone is in', () => {
  const { room, host, players } = roomWith(['Ana', 'Ben', 'Cy', 'Di']);
  room.startRound(host.id);
  playToVote(room, host);
  const [a, b, c, d] = players.map((p) => p.id);
  assert.throws(() => room.submitVote(a, a), /yourself/);
  assert.throws(() => room.submitVote(a, 'nobody'), GameError);
  room.submitVote(a, b);
  assert.throws(() => room.submitVote(a, c), /locked/);
  room.submitVote(b, c);
  room.submitVote(c, b);

  const view = room.viewFor(d);
  assert.equal(view.phase, 'vote');
  assert.equal(view.round.result, undefined);
  assert.equal(view.round.myVote, null);
  assert.deepEqual(view.players.map((p) => p.voted), [true, true, true, false]);
  assert.equal(room.viewFor(a).round.myVote, b);

  room.submitVote(d, a);
  assert.equal(room.phase, 'result');
});

test('result: players win when the imposter alone has the most votes', () => {
  const { room, host } = roomWith(['Ana', 'Ben', 'Cy', 'Di']);
  room.startRound(host.id);
  playToVote(room, host);
  const { imposterId, pair, participants } = room.round;
  const innocent = participants.find((id) => id !== imposterId);
  voteFor(room, imposterId, innocent);

  const { result } = room.viewFor(host.id).round;
  assert.equal(result.winner, 'players');
  assert.equal(result.imposterId, imposterId);
  assert.equal(result.imposterQuestion, pair.imposter);
  assert.equal(result.tally[0].playerId, imposterId);
  assert.equal(result.tally[0].votes, 3);
  assert.equal(result.tally[0].voters.length, 3);
  for (const p of room.players) assert.equal(p.score, p.id === imposterId ? 0 : 1);
});

test('result: imposter wins when someone else has the most votes', () => {
  const { room, host } = roomWith(['Ana', 'Ben', 'Cy', 'Di']);
  room.startRound(host.id);
  playToVote(room, host);
  const { imposterId, participants } = room.round;
  const innocent = participants.find((id) => id !== imposterId);
  voteFor(room, innocent, imposterId);

  const { result } = room.viewFor(host.id).round;
  assert.equal(result.winner, 'imposter');
  assert.equal(result.tied, false);
  for (const p of room.players) assert.equal(p.score, p.id === imposterId ? 1 : 0);
});

test('result: a tied vote goes to the imposter', () => {
  const { room, host } = roomWith(['Ana', 'Ben', 'Cy', 'Di']);
  room.startRound(host.id);
  playToVote(room, host);
  const { imposterId, participants } = room.round;
  const [x, y, z] = participants.filter((id) => id !== imposterId);
  room.submitVote(x, imposterId);
  room.submitVote(y, imposterId);
  room.submitVote(z, x);
  room.submitVote(imposterId, x);

  const { result } = room.viewFor(host.id).round;
  assert.equal(result.winner, 'imposter');
  assert.equal(result.tied, true);
  assert.equal(room.player(imposterId).score, 1);
});

test('scoreboard: wins add up across rounds', () => {
  const { room, host } = roomWith(['Ana', 'Ben', 'Cy']);
  let imposterWins = 0;
  for (let i = 0; i < 6; i++) {
    room.startRound(host.id);
    playToVote(room, host);
    const { imposterId, participants } = room.round;
    const innocent = participants.find((id) => id !== imposterId);
    if (i % 2) voteFor(room, imposterId, innocent);
    else {
      voteFor(room, innocent, imposterId);
      imposterWins++;
    }
  }
  const total = room.players.reduce((sum, p) => sum + p.score, 0);
  assert.equal(total, imposterWins * 1 + (6 - imposterWins) * 2);
  assert.equal(room.roundNumber, 6);
});

test('questions: a pair is never used twice in a session', () => {
  const { room, host } = roomWith(['Ana', 'Ben', 'Cy']);
  const seen = new Set();
  for (let i = 0; i < PAIRS.length; i++) {
    room.startRound(host.id);
    assert.ok(!seen.has(room.round.pair.id), `round ${i + 1} repeated ${room.round.pair.id}`);
    seen.add(room.round.pair.id);
    room.backToLobby(host.id);
  }
  assert.equal(seen.size, PAIRS.length);
  assert.throws(() => room.startRound(host.id), /every question/);
});

test('questions: chosen topics are respected, then fall back when they run out', () => {
  const { room, host } = roomWith(['Ana', 'Ben', 'Cy']);
  room.updateSettings(host.id, { topics: ['food', 'sport', 'nonsense'] });
  assert.deepEqual(room.settings.topics, ['food', 'sport']);
  const available = PAIRS.filter((p) => p.topic === 'food' || p.topic === 'sport').length;
  const topics = new Set();
  for (let i = 0; i < available; i++) {
    room.startRound(host.id);
    topics.add(room.round.pair.topic);
    room.backToLobby(host.id);
  }
  assert.deepEqual([...topics].sort(), ['food', 'sport']);
  room.startRound(host.id);
  assert.ok(!['food', 'sport'].includes(room.round.pair.topic));
});

test('questions: "Surprise me" mixes topics and is the default', () => {
  const { room, host } = roomWith(['Ana', 'Ben', 'Cy']);
  assert.deepEqual(room.settings.topics, ['surprise']);
  room.updateSettings(host.id, { topics: [] });
  assert.deepEqual(room.settings.topics, ['surprise']);
  const topics = new Set();
  for (let i = 0; i < 60; i++) {
    room.startRound(host.id);
    topics.add(room.round.pair.topic);
    room.backToLobby(host.id);
  }
  assert.equal(topics.size, TOPICS.length);
});

test('custom pairs: host only, hidden from other players, and playable', () => {
  const { room, host, players } = roomWith(['Ana', 'Ben', 'Cy']);
  assert.throws(() => room.addCustomPair(players[1].id, 'A?', 'B?'), /host/);
  assert.throws(() => room.addCustomPair(host.id, 'Same?', 'same?'), /different/);
  room.addCustomPair(host.id, 'Best biscuit?', 'Best cracker?');

  assert.equal(room.viewFor(host.id).customPairs.length, 1);
  const guest = room.viewFor(players[1].id);
  assert.equal(guest.customPairs, undefined);
  assert.equal(guest.customCount, 1);
  assert.ok(!JSON.stringify(guest).includes('biscuit'));

  room.updateSettings(host.id, { topics: ['custom'] });
  room.startRound(host.id);
  assert.equal(room.round.pair.real, 'Best biscuit?');
  assert.equal(room.round.pair.imposter, 'Best cracker?');
});

test('late joiners watch the current round and play the next one', () => {
  const { room, host } = roomWith(['Ana', 'Ben', 'Cy']);
  room.startRound(host.id);
  const late = room.join('Di');
  const view = room.viewFor(late.id);
  assert.equal(view.round.spectator, true);
  assert.equal(view.round.question, undefined);
  assert.throws(() => room.submitAnswer(late.id, 'hello'), /sitting this round out/);
  answerAll(room);
  assert.equal(room.phase, 'reveal', 'the round does not wait for spectators');
  room.backToLobby(host.id);
  room.startRound(host.id);
  assert.ok(room.round.participants.includes(late.id));
});

test('host can move a stuck round along and the host role is handed on', () => {
  const { room, host, players } = roomWith(['Ana', 'Ben', 'Cy', 'Di']);
  room.startRound(host.id);
  assert.throws(() => room.advance(host.id), /two answers/);
  room.submitAnswer(players[0].id, 'one');
  room.submitAnswer(players[1].id, 'two');
  room.advance(host.id);
  assert.equal(room.phase, 'reveal');
  assert.equal(room.viewFor(host.id).round.answers[3].text, null);

  room.disconnect(host.id);
  room.ensureHost();
  assert.equal(room.hostId, players[1].id);
});

test('lobby: host can remove a player, who can then come back', () => {
  const { room, host, players } = roomWith(['Ana', 'Ben', 'Cy']);
  assert.throws(() => room.kick(players[1].id, players[2].id), /host/);
  room.kick(host.id, players[2].id);
  assert.equal(room.players.length, 2);
  room.join('Cy');
  assert.equal(room.players.length, 3);
});
