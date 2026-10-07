'use strict';

// Game rules and room state. No networking in here: the server calls these
// methods and sends each player the result of viewFor(), which is the only
// place that decides what a given player is allowed to see.

const crypto = require('crypto');
const { TOPICS, PAIRS } = require('./questions');

const MIN_PLAYERS = 3;
const MAX_PLAYERS = 10;
const NAME_MAX = 14;
const ANSWER_MAX = 50;
const QUESTION_MAX = 120;
const CUSTOM_MAX = 40;
const TIMER_OPTIONS = [0, 60, 120, 180];
const DEFAULT_TIMER = 120;
const REVEAL_BASE_MS = 3500;
const REVEAL_PER_ANSWER_MS = 700;
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const NEXT_PHASE = { answer: 'reveal', reveal: 'discuss', discuss: 'vote', vote: 'result' };
const TOPIC_IDS = new Set(TOPICS.map((t) => t.id));

class GameError extends Error {}

const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const pick = (list, rng) => list[Math.floor(rng() * list.length)];
const newToken = () => crypto.randomBytes(12).toString('hex');

class Room {
  constructor(code, { rng = Math.random, now = Date.now } = {}) {
    this.code = code;
    this.rng = rng;
    this.clock = now;
    this.players = [];
    this.hostId = null;
    this.phase = 'lobby';
    this.settings = { topics: ['surprise'], timer: DEFAULT_TIMER };
    this.customPairs = [];
    this.used = new Set();
    this.round = null;
    this.roundNumber = 0;
    this.endsAt = null;
    this.lastActivity = now();
    this.seq = 0;
  }

  touch() {
    this.lastActivity = this.clock();
  }

  player(id) {
    return this.players.find((p) => p.id === id) || null;
  }

  requireHost(id) {
    if (id !== this.hostId) throw new GameError('Only the host can do that');
  }

  requireParticipant(id) {
    if (!this.round || !this.round.participants.includes(id)) {
      throw new GameError('You are sitting this round out');
    }
  }

  // ----- joining and leaving -----

  join(rawName, token) {
    const known = token && this.players.find((p) => p.token === token);
    if (known) {
      known.connected = true;
      known.gone = false;
      return known;
    }
    const name = clean(rawName, NAME_MAX);
    if (!name) throw new GameError('Enter your name first');
    const namesake = this.players.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (namesake) {
      if (namesake.connected) throw new GameError(`${namesake.name} is already in this room. Pick another name`);
      namesake.token = newToken();
      namesake.connected = true;
      namesake.gone = false;
      return namesake;
    }
    if (this.players.length >= MAX_PLAYERS) throw new GameError('This room is full');
    const player = { id: `p${++this.seq}`, name, token: newToken(), connected: true, gone: false, score: 0 };
    this.players.push(player);
    if (!this.hostId) this.hostId = player.id;
    return player;
  }

  disconnect(id) {
    const player = this.player(id);
    if (player) player.connected = false;
  }

  // Hand the host role to someone who is actually here.
  ensureHost() {
    const host = this.player(this.hostId);
    if (host && host.connected) return;
    const next = this.players.find((p) => p.connected);
    if (next) this.hostId = next.id;
    else if (!host) this.hostId = this.players[0] ? this.players[0].id : null;
  }

  remove(id) {
    this.players = this.players.filter((p) => p.id !== id);
    this.ensureHost();
  }

  kick(actorId, targetId) {
    this.requireHost(actorId);
    if (this.phase !== 'lobby') throw new GameError('You can only remove players in the lobby');
    if (targetId === actorId) throw new GameError('You cannot remove yourself');
    this.remove(targetId);
  }

  leave(id) {
    const player = this.player(id);
    if (!player) return;
    const midRound = this.round && this.round.participants.includes(id);
    if (!midRound) return this.remove(id);
    // Keep their seat until the round is over so answers and votes still add up.
    player.connected = false;
    player.gone = true;
    this.ensureHost();
  }

  purgeGone() {
    this.players = this.players.filter((p) => !p.gone);
    this.ensureHost();
  }

  // ----- lobby setup -----

  updateSettings(actorId, { topics, timer } = {}) {
    this.requireHost(actorId);
    if (this.phase !== 'lobby') throw new GameError('Settings can only change in the lobby');
    if (Array.isArray(topics)) {
      let wanted = [...new Set(topics)].filter(
        (t) => TOPIC_IDS.has(t) || t === 'surprise' || (t === 'custom' && this.customPairs.length)
      );
      if (wanted.length > 1) wanted = wanted.filter((t) => t !== 'surprise');
      this.settings.topics = wanted.length ? wanted : ['surprise'];
    }
    if (TIMER_OPTIONS.includes(timer)) this.settings.timer = timer;
  }

  addCustomPair(actorId, rawReal, rawImposter) {
    this.requireHost(actorId);
    if (this.phase !== 'lobby') throw new GameError('Add questions in the lobby');
    const real = clean(rawReal, QUESTION_MAX);
    const imposter = clean(rawImposter, QUESTION_MAX);
    if (!real || !imposter) throw new GameError('Write both questions first');
    if (real.toLowerCase() === imposter.toLowerCase()) throw new GameError('The two questions need to be different');
    if (this.customPairs.length >= CUSTOM_MAX) throw new GameError('That is plenty of custom questions');
    this.customPairs.push({ id: `custom-${++this.seq}`, topic: 'custom', real, imposter, answerType: 'text' });
    const { topics } = this.settings;
    if (!topics.includes('surprise') && !topics.includes('custom')) topics.push('custom');
  }

  removeCustomPair(actorId, pairId) {
    this.requireHost(actorId);
    this.customPairs = this.customPairs.filter((p) => p.id !== pairId);
    if (!this.customPairs.length) {
      const rest = this.settings.topics.filter((t) => t !== 'custom');
      this.settings.topics = rest.length ? rest : ['surprise'];
    }
  }

  // ----- rounds -----

  unusedPairs() {
    return [...PAIRS, ...this.customPairs].filter((p) => !this.used.has(p.id));
  }

  // Pick a topic first, then a pair, so every chosen topic comes up equally often.
  drawPair() {
    const unused = this.unusedPairs();
    if (!unused.length) throw new GameError('You have played every question! Add some of your own to keep going');
    const wanted = this.settings.topics;
    let candidates = wanted.includes('surprise') ? unused : unused.filter((p) => wanted.includes(p.topic));
    if (!candidates.length) candidates = unused;
    const topic = pick([...new Set(candidates.map((p) => p.topic))], this.rng);
    return pick(candidates.filter((p) => p.topic === topic), this.rng);
  }

  startRound(actorId) {
    this.requireHost(actorId);
    if (this.phase !== 'lobby' && this.phase !== 'result') throw new GameError('A round is already running');
    this.purgeGone();
    const seated = this.players.filter((p) => p.connected);
    if (seated.length < MIN_PLAYERS) throw new GameError(`You need at least ${MIN_PLAYERS} players to start`);
    const pair = this.drawPair();
    this.used.add(pair.id);
    this.round = {
      number: ++this.roundNumber,
      pair,
      imposterId: pick(seated, this.rng).id,
      participants: seated.map((p) => p.id),
      answers: {},
      votes: {},
      result: null,
    };
    this.setPhase('answer');
  }

  setPhase(phase) {
    this.phase = phase;
    this.endsAt = null;
    if (phase === 'reveal') {
      this.endsAt = this.clock() + REVEAL_BASE_MS + REVEAL_PER_ANSWER_MS * this.round.participants.length;
    } else if (phase === 'discuss' && this.settings.timer > 0) {
      this.endsAt = this.clock() + this.settings.timer * 1000;
    } else if (phase === 'result') {
      this.scoreRound();
    } else if (phase === 'lobby') {
      this.round = null;
      this.purgeGone();
    }
  }

  submitAnswer(playerId, raw) {
    if (this.phase !== 'answer') throw new GameError('Answers are closed');
    this.requireParticipant(playerId);
    const text = clean(raw, ANSWER_MAX);
    if (!text) throw new GameError('Type an answer first');
    const { answers, participants } = this.round;
    answers[playerId] = text;
    if (participants.every((id) => id in answers)) this.setPhase('reveal');
  }

  submitVote(playerId, targetId) {
    if (this.phase !== 'vote') throw new GameError('Voting is closed');
    this.requireParticipant(playerId);
    const { votes, participants } = this.round;
    if (targetId === playerId) throw new GameError('You cannot vote for yourself');
    if (!participants.includes(targetId)) throw new GameError('Pick a player from this round');
    if (playerId in votes) throw new GameError('Your vote is already locked in');
    votes[playerId] = targetId;
    if (participants.every((id) => id in votes)) this.setPhase('result');
  }

  // Host moves the round on without waiting (for a stuck player or the timer).
  advance(actorId) {
    this.requireHost(actorId);
    const next = NEXT_PHASE[this.phase];
    if (!next) throw new GameError('Nothing to skip right now');
    if (this.phase === 'answer' && Object.keys(this.round.answers).length < 2) {
      throw new GameError('Wait for at least two answers');
    }
    this.setPhase(next);
  }

  // Called by the server when the phase timer runs out. Returns true if the phase changed.
  expire() {
    if (!this.endsAt || this.clock() < this.endsAt) return false;
    if (this.phase !== 'reveal' && this.phase !== 'discuss') return false;
    this.setPhase(NEXT_PHASE[this.phase]);
    return true;
  }

  backToLobby(actorId) {
    this.requireHost(actorId);
    this.setPhase('lobby');
  }

  // The players win only if the imposter alone has the most votes.
  scoreRound() {
    const round = this.round;
    const counts = Object.fromEntries(round.participants.map((id) => [id, 0]));
    for (const target of Object.values(round.votes)) counts[target] += 1;
    const most = Math.max(...Object.values(counts));
    const top = round.participants.filter((id) => counts[id] === most);
    const caught = most > 0 && top.length === 1 && top[0] === round.imposterId;
    const winners = caught ? round.participants.filter((id) => id !== round.imposterId) : [round.imposterId];
    for (const id of winners) this.player(id).score += 1;
    round.result = { counts, caught, tied: most > 0 && top.length > 1, winners };
  }

  // ----- what one player is allowed to see -----

  viewFor(playerId) {
    const round = this.round;
    const nameOf = (id) => this.player(id).name;
    const view = {
      code: this.code,
      phase: this.phase,
      youId: playerId,
      hostId: this.hostId,
      now: this.clock(),
      endsAt: this.endsAt,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        connected: p.connected,
        score: p.score,
        inRound: !!round && round.participants.includes(p.id),
        answered: !!round && p.id in round.answers,
        voted: !!round && p.id in round.votes,
      })),
      settings: { topics: [...this.settings.topics], timer: this.settings.timer },
      customCount: this.customPairs.length,
      round: null,
    };
    if (playerId === this.hostId) {
      view.customPairs = this.customPairs.map(({ id, real, imposter }) => ({ id, real, imposter }));
    }
    if (!round) return view;

    const inRound = round.participants.includes(playerId);
    const mine = { number: round.number, answerType: round.pair.answerType, spectator: !inRound };

    if (this.phase === 'answer') {
      if (inRound) {
        mine.question = playerId === round.imposterId ? round.pair.imposter : round.pair.real;
        mine.myAnswer = round.answers[playerId] ?? null;
      }
    } else {
      mine.realQuestion = round.pair.real;
      mine.answers = round.participants.map((id) => ({
        playerId: id,
        name: nameOf(id),
        text: round.answers[id] ?? null,
      }));
    }

    if (this.phase === 'vote' || this.phase === 'result') mine.myVote = round.votes[playerId] ?? null;

    if (this.phase === 'result') {
      const { counts, caught, tied, winners } = round.result;
      mine.result = {
        winner: caught ? 'players' : 'imposter',
        tied,
        winners,
        imposterId: round.imposterId,
        imposterName: nameOf(round.imposterId),
        imposterQuestion: round.pair.imposter,
        tally: round.participants
          .map((id) => ({
            playerId: id,
            name: nameOf(id),
            votes: counts[id],
            voters: round.participants.filter((voter) => round.votes[voter] === id).map(nameOf),
          }))
          .sort((a, b) => b.votes - a.votes),
      };
    }

    view.round = mine;
    return view;
  }
}

class Rooms {
  constructor(options = {}) {
    this.options = options;
    this.rooms = new Map();
  }

  create() {
    const rng = this.options.rng || Math.random;
    let code;
    do {
      code = Array.from({ length: 4 }, () => pick(CODE_LETTERS, rng)).join('');
    } while (this.rooms.has(code));
    const room = new Room(code, this.options);
    this.rooms.set(code, room);
    return room;
  }

  get(code) {
    return this.rooms.get(clean(code, 8).toUpperCase()) || null;
  }

  // Drop rooms nobody is connected to any more.
  sweep(maxIdleMs, now = Date.now()) {
    const removed = [];
    for (const [code, room] of this.rooms) {
      const empty = !room.players.some((p) => p.connected);
      if (empty && now - room.lastActivity > maxIdleMs) {
        this.rooms.delete(code);
        removed.push(code);
      }
    }
    return removed;
  }
}

module.exports = {
  Room,
  Rooms,
  GameError,
  MIN_PLAYERS,
  MAX_PLAYERS,
  NAME_MAX,
  ANSWER_MAX,
  QUESTION_MAX,
  TIMER_OPTIONS,
};
