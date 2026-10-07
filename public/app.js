(() => {
  'use strict';

  const SESSION_KEY = 'imposta.session';
  const NAME_KEY = 'imposta.name';
  const COLORS = ['#ff5a3c', '#19d3c5', '#ffc933', '#ff6fae', '#7be07b', '#8fa8ff', '#ff9f43', '#c58cff', '#5fd0ff', '#f4f06b'];
  const STEPS = [['answer', 'Answer'], ['reveal', 'Reveal'], ['discuss', 'Discuss'], ['vote', 'Vote'], ['result', 'Result']];
  const TIMER_LABELS = { 0: 'Off', 60: '1 min', 120: '2 min', 180: '3 min' };

  // ---------- storage ----------

  const read = (area, key) => {
    try {
      return JSON.parse(area.getItem(key));
    } catch {
      return null;
    }
  };
  const write = (area, key, value) => {
    try {
      if (value == null) area.removeItem(key);
      else area.setItem(key, JSON.stringify(value));
    } catch {
      /* private mode: carry on without it */
    }
  };

  // ---------- state ----------

  const freshUi = () => ({ editing: false, voteTarget: null, stage: 0, customOpen: false, confirmEnd: false, copied: false });

  const S = {
    ws: null,
    online: false,
    wasOnline: false,
    retry: 0,
    replaced: false,
    joining: false,
    topics: [],
    limits: { min: 3, max: 10 },
    timers: [0, 60, 120, 180],
    lan: null,
    // Per tab, so a refresh rejoins the same seat and several tabs can play side by side.
    session: read(sessionStorage, SESSION_KEY),
    view: null,
    offset: 0,
    key: 'home',
    ui: freshUi(),
    toast: null,
    toastTimer: null,
    stageTimers: [],
  };

  const urlRoom = () =>
    (new URLSearchParams(location.search).get('room') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);

  // ---------- tiny DOM layer ----------

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs || {})) {
      if (value == null || value === false) continue;
      if (name.startsWith('on')) {
        (el._on ||= {})[name] = value;
        el[name] = value;
      } else if (name === 'key') el.dataset.key = value;
      else el.setAttribute(name, value === true ? '' : value);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  const keyOf = (node) => (node.nodeType === 1 ? node.dataset.key ?? null : null);
  const same = (a, b) => a.nodeType === b.nodeType && a.nodeName === b.nodeName && keyOf(a) === keyOf(b);

  // Update the live DOM to match a freshly rendered tree. Elements that are still
  // there are kept, so inputs keep their text and animations do not replay.
  function morph(from, to) {
    if (!same(from, to)) {
      from.replaceWith(to);
      return;
    }
    if (from.nodeType !== 1) {
      if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
      return;
    }
    for (const { name } of [...from.attributes]) if (!to.hasAttribute(name)) from.removeAttribute(name);
    for (const { name, value } of [...to.attributes]) if (from.getAttribute(name) !== value) from.setAttribute(name, value);
    for (const name in from._on || {}) from[name] = null;
    for (const name in to._on || {}) from[name] = to._on[name];
    from._on = to._on;

    const keyed = new Map();
    for (const child of from.children) if (child.dataset.key != null) keyed.set(child.dataset.key, child);
    const wanted = new Set([...to.children].map(keyOf).filter((k) => k != null));
    let cursor = from.firstChild;
    for (const next of [...to.childNodes]) {
      while (cursor && keyOf(cursor) != null && !wanted.has(keyOf(cursor))) {
        const gone = cursor;
        cursor = cursor.nextSibling;
        gone.remove();
      }
      const key = keyOf(next);
      const match = key != null ? keyed.get(key) : cursor && same(cursor, next) ? cursor : null;
      if (!match) {
        from.insertBefore(next, cursor);
        continue;
      }
      if (match === cursor) cursor = cursor.nextSibling;
      else from.insertBefore(match, cursor);
      morph(match, next);
    }
    while (cursor) {
      const gone = cursor;
      cursor = cursor.nextSibling;
      gone.remove();
    }
  }

  function render() {
    const next = h(
      'div',
      { class: 'shell' },
      !S.online && S.wasOnline && !S.replaced && h('div', { class: 'banner', key: 'banner' }, 'Reconnecting', dots()),
      S.toast && h('div', { class: 'toast', key: 'toast', role: 'alert' }, S.toast),
      screen()
    );
    const root = document.getElementById('app');
    if (root.firstElementChild) morph(root.firstElementChild, next);
    else root.append(next);
  }

  function toast(text) {
    S.toast = text;
    clearTimeout(S.toastTimer);
    S.toastTimer = setTimeout(() => {
      S.toast = null;
      render();
    }, 3200);
    render();
  }

  // ---------- connection ----------

  function connect() {
    if (S.replaced) return;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
    S.ws = ws;
    ws.onopen = () => {
      S.online = true;
      S.wasOnline = true;
      S.retry = 0;
      if (S.session) {
        S.joining = true;
        send({ t: 'join', ...S.session });
      }
      render();
    };
    ws.onmessage = (event) => receive(JSON.parse(event.data));
    ws.onclose = () => {
      if (S.ws !== ws) return;
      S.online = false;
      render();
      setTimeout(connect, Math.min(4000, 400 * 2 ** S.retry++));
    };
  }

  function send(msg) {
    if (S.ws && S.ws.readyState === WebSocket.OPEN) S.ws.send(JSON.stringify(msg));
    else toast('Not connected yet. Give it a second');
  }

  function receive(msg) {
    switch (msg.t) {
      case 'hello':
        S.topics = msg.topics;
        S.limits = msg.limits;
        S.timers = msg.timers;
        S.lan = msg.lan;
        break;
      case 'joined':
        S.session = { code: msg.code, token: msg.token, name: msg.name };
        write(sessionStorage, SESSION_KEY, S.session);
        write(localStorage, NAME_KEY, msg.name);
        history.replaceState(null, '', `?room=${msg.code}`);
        return;
      case 'state':
        onState(msg.state);
        return;
      case 'error':
        // A saved seat that no longer exists: drop it and go back to the start.
        if (S.joining && S.session) exit();
        S.joining = false;
        toast(msg.message);
        return;
      case 'kicked':
        exit();
        toast('The host removed you from the room');
        return;
      case 'left':
        exit();
        return;
      case 'replaced':
        S.replaced = true;
        break;
    }
    render();
  }

  function onState(view) {
    S.view = view;
    S.offset = view.now - Date.now();
    S.joining = false;
    const key = `${view.phase}:${view.round ? view.round.number : 0}`;
    const moved = key !== S.key;
    if (moved) {
      S.key = key;
      S.ui = freshUi();
      clearStage();
      if (view.phase === 'result') playResult(view);
    }
    render();
    if (moved) {
      window.scrollTo(0, 0);
      if (view.phase === 'answer' && matchMedia('(pointer: fine)').matches) document.getElementById('answer')?.focus();
    }
  }

  function exit() {
    S.session = null;
    write(sessionStorage, SESSION_KEY, null);
    S.view = null;
    S.key = 'home';
    S.ui = freshUi();
    clearStage();
    history.replaceState(null, '', location.pathname);
    render();
  }

  function clearStage() {
    S.stageTimers.forEach(clearTimeout);
    S.stageTimers = [];
  }

  // The result is revealed in beats: votes, then the imposter, then the winner.
  function playResult(view) {
    const votes = 1100;
    const imposter = votes + 1500 + view.round.result.tally.length * 160;
    const winner = imposter + 2200;
    [votes, imposter, winner].forEach((ms, i) => {
      S.stageTimers.push(
        setTimeout(() => {
          S.ui.stage = i + 1;
          render();
          // On a phone each beat lands below the fold, so follow it down.
          const beat = document.querySelector(['.tally', '.unmask', '.verdict'][i]);
          const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
          if (i > 0 && beat) beat.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'center' });
          if (i === 2 && S.view.round.result.winners.includes(S.view.youId)) confetti();
        }, ms)
      );
    });
  }

  // ---------- actions ----------

  const val = (id) => (document.getElementById(id)?.value || '').trim();
  const onEnter = (fn) => (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    fn();
  };

  function createRoom() {
    const name = val('name');
    if (!name) return toast('Enter your name first');
    S.joining = true;
    send({ t: 'create', name });
  }

  function joinRoom() {
    const name = val('name');
    const code = val('code').toUpperCase();
    if (!name) return toast('Enter your name first');
    if (code.length !== 4) return toast('The room code is 4 letters');
    S.joining = true;
    send({ t: 'join', code, name });
  }

  function leave() {
    if (S.online) send({ t: 'leave' });
    else exit();
  }

  function toggleTopic(id) {
    let topics = S.view.settings.topics.filter((t) => t !== 'surprise');
    if (id === 'surprise') topics = [];
    else topics = topics.includes(id) ? topics.filter((t) => t !== id) : [...topics, id];
    send({ t: 'settings', topics: topics.length ? topics : ['surprise'] });
  }

  function addPair() {
    const real = val('pair-real');
    const imposter = val('pair-imposter');
    if (!real || !imposter) return toast('Write both questions first');
    send({ t: 'addPair', real, imposter });
    document.getElementById('pair-real').value = '';
    document.getElementById('pair-imposter').value = '';
    document.getElementById('pair-real').focus();
  }

  function submitAnswer(text) {
    if (!text) return toast('Type an answer first');
    S.ui.editing = false;
    send({ t: 'answer', text });
  }

  function endRound() {
    if (S.ui.confirmEnd) return send({ t: 'lobby' });
    const ui = S.ui;
    ui.confirmEnd = true;
    render();
    setTimeout(() => {
      ui.confirmEnd = false;
      render();
    }, 3000);
  }

  function shareLink(code) {
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    const origin = local && S.lan ? `http://${S.lan}${location.port ? `:${location.port}` : ''}` : location.origin;
    return `${origin}/?room=${code}`;
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API needs https; fall back for plain http on the local network.
      const area = h('textarea', { style: 'position:fixed;opacity:0' });
      area.value = text;
      document.body.append(area);
      area.select();
      try {
        document.execCommand('copy');
      } catch {
        /* nothing else to try */
      }
      area.remove();
    }
    const ui = S.ui;
    ui.copied = true;
    render();
    setTimeout(() => {
      ui.copied = false;
      render();
    }, 1800);
  }

  // ---------- shared pieces ----------

  const colorOf = (id) => COLORS[(parseInt(String(id).slice(1), 10) - 1) % COLORS.length];
  const nameOf = (view, id) => view.players.find((p) => p.id === id)?.name || 'Someone';
  const isHost = (view) => view.youId === view.hostId;
  const secondsLeft = (view) => Math.max(0, Math.ceil((view.endsAt - (Date.now() + S.offset)) / 1000));
  const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

  const dots = () => h('span', { class: 'dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'));
  const avatar = (id, name) =>
    h('span', { class: 'avatar', style: `--c:${colorOf(id)}`, 'aria-hidden': 'true' }, [...name][0].toUpperCase());

  function logo(size) {
    return h(
      size === 'big' ? 'h1' : 'div',
      { class: `logo ${size}`, 'aria-label': 'Imposta' },
      [...'IMPOSTA'].map((letter, i) => h('span', { class: i === 3 ? 'odd' : null, 'aria-hidden': 'true' }, letter))
    );
  }

  function playerChip(view, p, extra = {}) {
    return h(
      'div',
      { class: `player${p.connected ? '' : ' offline'}`, key: p.id },
      avatar(p.id, p.name),
      h('span', { class: 'player-name' }, p.name),
      p.id === view.hostId && h('span', { class: 'tag host' }, 'Host'),
      p.id === view.youId && h('span', { class: 'tag' }, 'You'),
      !p.connected && h('span', { class: 'tag off' }, 'Away'),
      extra.state != null && h('span', { class: `state ${extra.state ? 'done' : 'wait'}` }, extra.state ? '✓' : dots()),
      extra.kick &&
        h('button', { class: 'kick', 'aria-label': `Remove ${p.name}`, onclick: () => send({ t: 'kick', id: p.id }) }, '✕')
    );
  }

  // Who has answered or voted, never what they chose.
  function progress(view, field, verb) {
    const seated = view.players.filter((p) => p.inRound);
    const done = seated.filter((p) => p[field]).length;
    return h(
      'section',
      { class: 'panel', key: 'progress' },
      h('div', { class: 'panel-head' }, h('h2', null, `${done} of ${seated.length} ${verb}`)),
      h('div', { class: 'players' }, seated.map((p) => playerChip(view, p, { state: p[field] })))
    );
  }

  function scoreboard(view, winners = []) {
    const rows = [...view.players].sort((a, b) => b.score - a.score);
    if (!rows.some((p) => p.score > 0)) return null;
    return h(
      'section',
      { class: 'panel scores', key: 'scores' },
      h('div', { class: 'panel-head' }, h('h2', null, 'Scoreboard'), h('span', { class: 'count' }, 'wins')),
      rows.map((p, i) =>
        h(
          'div',
          { class: 'score-row', key: p.id },
          h('span', { class: 'rank' }, i + 1),
          avatar(p.id, p.name),
          h('span', { class: 'player-name' }, p.name),
          winners.includes(p.id) && h('span', { class: 'plus' }, '+1'),
          h('b', { class: 'score' }, p.score)
        )
      )
    );
  }

  function steps(phase) {
    const at = STEPS.findIndex(([id]) => id === phase);
    return h(
      'ol',
      { class: 'steps' },
      STEPS.map(([, label], i) =>
        h(
          'li',
          { class: i < at ? 'done' : i === at ? 'now' : null, 'aria-current': i === at ? 'step' : null },
          h('b', null, i + 1),
          h('span', null, label)
        )
      )
    );
  }

  function frame(view, ...content) {
    return h(
      'main',
      { class: `screen game phase-${view.phase}`, key: S.key },
      h(
        'header',
        { class: 'topbar' },
        logo('mini'),
        h('span', { class: 'pill' }, 'Room ', h('b', null, view.code)),
        h('span', { class: 'pill' }, 'Round ', h('b', null, view.round.number))
      ),
      steps(view.phase),
      content,
      isHost(view) &&
        view.phase !== 'result' &&
        h(
          'button',
          { class: 'link', key: 'end', onclick: endRound },
          S.ui.confirmEnd ? 'Tap again to end this round' : 'End round and return to the lobby'
        )
    );
  }

  const realQuestion = (view) =>
    h(
      'section',
      { class: 'question', key: 'question' },
      h('div', { class: 'question-label' }, 'The real question'),
      h('h1', null, view.round.realQuestion)
    );

  function answerCards(view, { stagger = false, pick = false, chosen = null } = {}) {
    return h(
      'div',
      { class: `answers${stagger ? ' stagger' : ''}`, key: 'answers' },
      view.round.answers.map((answer, i) => {
        const mine = answer.playerId === view.youId;
        const selectable = pick && !mine;
        return h(
          selectable ? 'button' : 'div',
          {
            class: `answer${mine ? ' mine' : ''}${chosen === answer.playerId ? ' chosen' : ''}${selectable ? ' pick' : ''}`,
            key: answer.playerId,
            style: `--i:${i};--c:${colorOf(answer.playerId)}`,
            type: selectable ? 'button' : null,
            'aria-label': selectable ? `Vote for ${answer.name}, who answered ${answer.text ?? 'nothing'}` : null,
            'aria-pressed': selectable ? String(chosen === answer.playerId) : null,
            onclick: selectable
              ? () => {
                  S.ui.voteTarget = answer.playerId;
                  render();
                }
              : null,
          },
          h(
            'div',
            { class: 'answer-who' },
            avatar(answer.playerId, answer.name),
            h('span', null, answer.name),
            mine && h('span', { class: 'tag' }, 'You'),
            chosen === answer.playerId && h('span', { class: 'tag vote', key: 'vote' }, 'Your vote')
          ),
          h('div', { class: `answer-text${answer.text == null ? ' none' : ''}` }, answer.text ?? 'No answer')
        );
      })
    );
  }

  // ---------- screens ----------

  function screen() {
    if (S.replaced) {
      return h(
        'main',
        { class: 'screen home', key: 'replaced' },
        logo('big'),
        h('section', { class: 'panel center' }, h('h2', null, 'Playing in another tab'), h('p', { class: 'hint' }, 'This seat was opened somewhere else.')),
        h('button', { class: 'btn', onclick: () => location.reload() }, 'Play here instead')
      );
    }
    const view = S.view;
    if (!view) {
      if (S.session) {
        return h('main', { class: 'screen home', key: 'loading' }, logo('big'), h('p', { class: 'waiting' }, `Rejoining room ${S.session.code}`, dots()));
      }
      return screenHome();
    }
    switch (view.phase) {
      case 'lobby':
        return screenLobby(view);
      case 'answer':
        return screenAnswer(view);
      case 'reveal':
        return screenReveal(view);
      case 'discuss':
        return screenDiscuss(view);
      case 'vote':
        return screenVote(view);
      default:
        return screenResult(view);
    }
  }

  function screenHome() {
    const invited = urlRoom();
    const joinRow = h(
      'div',
      { class: 'join-row' },
      h('input', {
        id: 'code',
        class: 'input code-input',
        maxlength: 4,
        placeholder: 'CODE',
        autocomplete: 'off',
        autocapitalize: 'characters',
        spellcheck: 'false',
        'aria-label': 'Room code',
        value: invited,
        oninput: (event) => {
          event.target.value = event.target.value.toUpperCase().replace(/[^A-Z]/g, '');
        },
        onkeydown: onEnter(joinRoom),
      }),
      h('button', { class: `btn${invited ? '' : ' teal'}`, onclick: joinRoom }, 'Join')
    );
    const create = h('button', { class: `btn${invited ? ' ghost' : ''}`, onclick: createRoom }, 'Create a room');
    return h(
      'main',
      { class: 'screen home', key: 'home' },
      logo('big'),
      h('p', { class: 'tagline' }, 'Everyone answers a question. ', h('b', null, 'One of you got a different one.')),
      h(
        'section',
        { class: 'panel' },
        h('label', { class: 'label', for: 'name' }, 'Your name'),
        h('input', {
          id: 'name',
          class: 'input',
          maxlength: 14,
          placeholder: 'Type your name',
          autocomplete: 'off',
          value: read(localStorage, NAME_KEY) || '',
          onkeydown: onEnter(() => (val('code') ? joinRoom() : createRoom())),
        }),
        invited
          ? [h('div', { class: 'label' }, 'Room code'), joinRow, h('div', { class: 'or' }, 'or'), create]
          : [create, h('div', { class: 'or' }, 'or join with a code'), joinRow]
      ),
      h(
        'ol',
        { class: 'how' },
        h('li', null, h('b', null, '1'), 'Answer the question on your screen.'),
        h('li', null, h('b', null, '2'), 'See every answer. Spot the one that does not fit.'),
        h('li', null, h('b', null, '3'), 'Vote out the imposter. They might not even know it is them.')
      )
    );
  }

  function screenLobby(view) {
    const host = isHost(view);
    const hostName = nameOf(view, view.hostId);
    const here = view.players.filter((p) => p.connected).length;
    const missing = S.limits.min - here;
    const link = shareLink(view.code);
    return h(
      'main',
      { class: 'screen lobby', key: S.key },
      logo('small'),
      h(
        'section',
        { class: 'panel code-panel' },
        h('div', { class: 'label' }, 'Room code'),
        h('div', { class: 'room-code', 'aria-label': [...view.code].join(' ') }, [...view.code].map((c) => h('span', { 'aria-hidden': 'true' }, c))),
        h('button', { class: 'btn small teal', onclick: () => copy(link) }, S.ui.copied ? 'Copied!' : 'Copy invite link'),
        h('div', { class: 'hint' }, link.replace(/^https?:\/\//, ''))
      ),
      h(
        'section',
        { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h2', null, 'Players'), h('span', { class: 'count' }, `${view.players.length} of ${S.limits.max}`)),
        h('div', { class: 'players' }, view.players.map((p) => playerChip(view, p, { kick: host && p.id !== view.youId })))
      ),
      host ? hostSetup(view) : guestSetup(view),
      scoreboard(view),
      host
        ? h(
            'div',
            { class: 'actions', key: 'actions' },
            h(
              'button',
              { class: 'btn big', id: 'start', disabled: missing > 0, onclick: () => send({ t: 'start' }) },
              missing > 0 ? `Waiting for ${missing} more player${missing === 1 ? '' : 's'}` : 'Start the game'
            )
          )
        : h('p', { class: 'waiting', key: 'actions' }, `Waiting for ${hostName} to start`, dots()),
      h('button', { class: 'link', key: 'leave', onclick: leave }, 'Leave room')
    );
  }

  function hostSetup(view) {
    const chosen = view.settings.topics;
    const chips = [
      { id: 'surprise', name: 'Surprise me', emoji: '🎲' },
      ...S.topics,
      ...(view.customCount ? [{ id: 'custom', name: 'Your own', emoji: '✍️' }] : []),
    ];
    return [
      h(
        'section',
        { class: 'panel', key: 'topics' },
        h('div', { class: 'panel-head' }, h('h2', null, 'Topics')),
        h(
          'div',
          { class: 'topics' },
          chips.map((topic) =>
            h(
              'button',
              { class: 'topic', key: topic.id, 'aria-pressed': String(chosen.includes(topic.id)), onclick: () => toggleTopic(topic.id) },
              h('span', { 'aria-hidden': 'true' }, topic.emoji),
              topic.name
            )
          )
        )
      ),
      h(
        'section',
        { class: 'panel', key: 'timer' },
        h('div', { class: 'panel-head' }, h('h2', null, 'Discussion timer')),
        h(
          'div',
          { class: 'segments' },
          S.timers.map((seconds) =>
            h(
              'button',
              { 'aria-pressed': String(view.settings.timer === seconds), onclick: () => send({ t: 'settings', timer: seconds }) },
              TIMER_LABELS[seconds] || `${seconds}s`
            )
          )
        )
      ),
      h(
        'section',
        { class: 'panel', key: 'custom' },
        h(
          'button',
          {
            class: 'disclosure',
            'aria-expanded': String(S.ui.customOpen),
            onclick: () => {
              S.ui.customOpen = !S.ui.customOpen;
              render();
            },
          },
          h('span', { class: 'title' }, 'Your own questions'),
          h('span', { class: 'count' }, view.customCount ? `${view.customCount} added` : 'Add some')
        ),
        S.ui.customOpen &&
          h(
            'div',
            { class: 'custom', key: 'body' },
            h('p', { class: 'hint' }, 'Write two questions with the same kind of answer. Only you can see these.'),
            h('label', { class: 'label', for: 'pair-real' }, 'Everyone gets'),
            h('input', { id: 'pair-real', class: 'input', maxlength: 120, placeholder: 'What is the best pizza topping?', autocomplete: 'off' }),
            h('label', { class: 'label', for: 'pair-imposter' }, 'The imposter gets'),
            h('input', {
              id: 'pair-imposter',
              class: 'input',
              maxlength: 120,
              placeholder: 'What is your favourite vegetable?',
              autocomplete: 'off',
              onkeydown: onEnter(addPair),
            }),
            h('button', { class: 'btn small pink', onclick: addPair }, 'Add pair'),
            (view.customPairs || []).map((pair) =>
              h(
                'div',
                { class: 'pair', key: pair.id },
                h('div', null, h('p', null, pair.real), h('p', { class: 'imposter-q' }, pair.imposter)),
                h('button', { class: 'kick', 'aria-label': 'Remove this pair', onclick: () => send({ t: 'removePair', id: pair.id }) }, '✕')
              )
            )
          )
      ),
    ];
  }

  function guestSetup(view) {
    const label = (id) => {
      if (id === 'surprise') return '🎲 Surprise me';
      if (id === 'custom') return "✍️ The host's own";
      const topic = S.topics.find((t) => t.id === id);
      return topic ? `${topic.emoji} ${topic.name}` : id;
    };
    const timer = view.settings.timer;
    return h(
      'section',
      { class: 'panel', key: 'topics' },
      h('div', { class: 'panel-head' }, h('h2', null, 'Topics'), h('span', { class: 'count' }, timer ? `${TIMER_LABELS[timer]} to discuss` : 'No timer')),
      h('div', { class: 'topics readonly' }, view.settings.topics.map((id) => h('span', { class: 'topic', key: id, 'aria-pressed': 'true' }, label(id))))
    );
  }

  function screenAnswer(view) {
    const round = view.round;
    const seated = view.players.filter((p) => p.inRound);
    const done = seated.filter((p) => p.answered).length;
    let mine;
    if (round.spectator) {
      mine = h('section', { class: 'panel center', key: 'spectator' }, h('h2', null, 'Round in progress'), h('p', { class: 'hint' }, 'You will be dealt in for the next one.'));
    } else {
      const locked = round.myAnswer && !S.ui.editing;
      let entry;
      if (locked) {
        entry = h(
          'section',
          { class: 'panel locked', key: 'locked' },
          h('div', { class: 'label' }, 'Your answer'),
          h('div', { class: 'locked-text' }, round.myAnswer),
          h(
            'button',
            {
              class: 'link',
              onclick: () => {
                S.ui.editing = true;
                render();
                document.getElementById('answer')?.focus();
              },
            },
            'Change answer'
          )
        );
      } else if (round.answerType === 'player') {
        entry = h(
          'div',
          { class: 'name-picker', key: 'picker' },
          seated.map((p) => h('button', { class: 'name-pick', key: p.id, style: `--c:${colorOf(p.id)}`, onclick: () => submitAnswer(p.name) }, avatar(p.id, p.name), p.name))
        );
      } else {
        entry = h(
          'form',
          {
            class: 'answer-form',
            key: 'form',
            onsubmit: (event) => {
              event.preventDefault();
              submitAnswer(val('answer'));
            },
          },
          h('input', {
            id: 'answer',
            class: 'input big',
            maxlength: 50,
            placeholder: 'Your short answer',
            autocomplete: 'off',
            enterkeyhint: 'send',
            'aria-label': 'Your answer',
            value: round.myAnswer,
          }),
          h('button', { class: 'btn', type: 'submit' }, 'Lock it in')
        );
      }
      mine = [
        h('section', { class: 'question', key: 'question' }, h('div', { class: 'question-label' }, 'Your question'), h('h1', null, round.question)),
        entry,
        h('p', { class: 'hint center', key: 'hush' }, 'Keep your screen to yourself.'),
      ];
    }
    return frame(
      view,
      mine,
      progress(view, 'answered', 'answered'),
      isHost(view) &&
        done >= 2 &&
        done < seated.length &&
        h('button', { class: 'btn small ghost', key: 'skip', onclick: () => send({ t: 'skip' }) }, 'Reveal without waiting')
    );
  }

  function screenReveal(view) {
    return frame(
      view,
      h('div', { class: 'headline', key: 'headline' }, 'All answers are in!'),
      realQuestion(view),
      answerCards(view, { stagger: true }),
      isHost(view) && h('button', { class: 'btn small ghost', key: 'skip', onclick: () => send({ t: 'skip' }) }, 'Start the discussion')
    );
  }

  function screenDiscuss(view) {
    const timed = view.endsAt != null;
    const left = timed ? secondsLeft(view) : 0;
    const share = timed ? Math.max(0, (view.endsAt - (Date.now() + S.offset)) / (view.settings.timer * 1000)) : 0;
    return frame(
      view,
      h(
        'section',
        { class: 'discuss', key: 'discuss' },
        h('div', { class: 'headline' }, 'Who got a different question?'),
        timed
          ? [
              h('div', { class: `clock${left <= 10 ? ' hurry' : ''}`, role: 'timer' }, clock(left)),
              h('div', { class: 'bar' }, h('i', { style: `width:${(share * 100).toFixed(1)}%` })),
            ]
          : h('p', { class: 'hint center' }, 'Talk it out. No timer this round.')
      ),
      realQuestion(view),
      answerCards(view),
      isHost(view)
        ? h('div', { class: 'actions', key: 'actions' }, h('button', { class: 'btn', onclick: () => send({ t: 'skip' }) }, timed ? 'Skip to the vote' : 'Open the vote'))
        : h('p', { class: 'waiting', key: 'actions' }, timed ? 'Voting opens when the timer ends' : `${nameOf(view, view.hostId)} opens the vote`)
    );
  }

  function screenVote(view) {
    const round = view.round;
    const seated = view.players.filter((p) => p.inRound);
    const done = seated.filter((p) => p.voted).length;
    const canVote = !round.spectator && !round.myVote;
    const target = S.ui.voteTarget;
    let action;
    if (canVote) {
      action = h(
        'div',
        { class: 'actions float', key: 'actions' },
        h(
          'button',
          { class: 'btn pink', id: 'cast', disabled: !target, onclick: () => send({ t: 'vote', target }) },
          target ? `Vote for ${nameOf(view, target)}` : 'Tap a player to vote'
        )
      );
    } else if (round.myVote) {
      action = h('p', { class: 'waiting', key: 'actions' }, `You voted for ${nameOf(view, round.myVote)}. Waiting for the rest`, dots());
    }
    return frame(
      view,
      h('div', { class: 'headline', key: 'headline' }, 'Who is the imposter?'),
      realQuestion(view),
      answerCards(view, { pick: canVote, chosen: round.myVote || target }),
      action,
      progress(view, 'voted', 'voted'),
      isHost(view) &&
        done >= 1 &&
        done < seated.length &&
        h('button', { class: 'btn small ghost', key: 'skip', onclick: () => send({ t: 'skip' }) }, 'Count the votes now')
    );
  }

  function screenResult(view) {
    const round = view.round;
    const result = round.result;
    const stage = S.ui.stage;
    const most = Math.max(1, ...result.tally.map((row) => row.votes));
    const caught = result.winner === 'players';
    const imposter = result.imposterName;
    const iAmImposter = result.imposterId === view.youId;
    const iWon = result.winners.includes(view.youId);

    let story;
    if (caught) story = `${imposter} was caught.`;
    else if (result.tied) story = `The vote was tied, so ${imposter} slips away.`;
    else if (!result.tally[0].votes) story = `Nobody voted, so ${imposter} walks free.`;
    else story = `${result.tally[0].name} took the fall. ${imposter} got away with it.`;

    let personal = null;
    if (!round.spectator) {
      if (iAmImposter) personal = iWon ? 'That was you. Nicely bluffed.' : 'That was you. Better luck next time.';
      else personal = iWon ? 'A win for you.' : 'No win this time.';
    }

    return frame(
      view,
      stage < 1 && h('div', { class: 'drumroll', key: 'drumroll' }, 'The votes are in', dots()),
      stage >= 1 &&
        h(
          'section',
          { class: 'panel tally', key: 'tally' },
          h('div', { class: 'panel-head' }, h('h2', null, 'The votes')),
          result.tally.map((row, i) => {
            const unmasked = stage >= 2 && row.playerId === result.imposterId;
            return h(
              'div',
              { class: `tally-row${unmasked ? ' unmasked' : ''}`, key: row.playerId, style: `--i:${i};--c:${colorOf(row.playerId)}` },
              h('div', { class: 'tally-name' }, avatar(row.playerId, row.name), h('span', null, row.name), unmasked && h('span', { class: 'tag imposter', key: 'imposter' }, 'Imposter')),
              h('b', { class: 'tally-count' }, row.votes),
              h('div', { class: 'tally-bar' }, h('i', { style: `width:${(row.votes / most) * 100}%` })),
              h('div', { class: 'tally-voters' }, row.voters.length ? `from ${row.voters.join(', ')}` : 'no votes')
            );
          })
        ),
      stage >= 2 &&
        h(
          'section',
          { class: 'unmask', key: 'unmask', style: `--c:${colorOf(result.imposterId)}` },
          h('div', { class: 'unmask-label' }, 'The imposter was'),
          h('div', { class: 'unmask-name' }, imposter),
          h('div', { class: 'unmask-q' }, h('span', null, 'Their question'), h('p', null, result.imposterQuestion)),
          h('div', { class: 'unmask-q plain' }, h('span', null, 'Everyone else'), h('p', null, round.realQuestion))
        ),
      stage >= 3 && [
        h(
          'section',
          { class: `verdict ${caught ? 'caught' : 'escaped'}`, key: 'verdict' },
          h('div', { class: 'verdict-title' }, caught ? 'Players win!' : 'Imposter wins!'),
          h('p', null, story),
          personal && h('p', { class: 'verdict-you' }, personal)
        ),
        scoreboard(view, result.winners),
        isHost(view)
          ? h(
              'div',
              { class: 'actions stack', key: 'actions' },
              h('button', { class: 'btn big', id: 'next', onclick: () => send({ t: 'start' }) }, 'Next round'),
              h('button', { class: 'btn small ghost', onclick: () => send({ t: 'lobby' }) }, 'Back to the lobby')
            )
          : h('p', { class: 'waiting', key: 'actions' }, `Waiting for ${nameOf(view, view.hostId)} to start the next round`, dots()),
      ]
    );
  }

  // ---------- confetti ----------

  function confetti() {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const canvas = h('canvas', { class: 'confetti' });
    document.body.append(canvas);
    const ctx = canvas.getContext('2d');
    const width = (canvas.width = innerWidth);
    const height = (canvas.height = innerHeight);
    const bits = Array.from({ length: 150 }, () => ({
      x: width / 2 + (Math.random() - 0.5) * width * 0.4,
      y: height * 0.4,
      vx: (Math.random() - 0.5) * 18,
      vy: -Math.random() * 18 - 4,
      size: 6 + Math.random() * 9,
      turn: Math.random() * 6,
      spin: (Math.random() - 0.5) * 0.4,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
    }));
    const started = performance.now();
    const life = 2800;
    (function draw(now) {
      const age = now - started;
      ctx.clearRect(0, 0, width, height);
      ctx.globalAlpha = Math.max(0, 1 - age / life);
      for (const bit of bits) {
        bit.vy += 0.45;
        bit.vx *= 0.99;
        bit.x += bit.vx;
        bit.y += bit.vy;
        bit.turn += bit.spin;
        ctx.save();
        ctx.translate(bit.x, bit.y);
        ctx.rotate(bit.turn);
        ctx.fillStyle = bit.color;
        ctx.fillRect(-bit.size / 2, -bit.size / 3, bit.size, bit.size / 1.5);
        ctx.restore();
      }
      if (age < life) requestAnimationFrame(draw);
      else canvas.remove();
    })(started);
  }

  // ---------- go ----------

  // An invite link to a different room beats a seat saved from an older game.
  if (S.session && urlRoom() && urlRoom() !== S.session.code) {
    S.session = null;
    write(sessionStorage, SESSION_KEY, null);
  }

  render();
  connect();
  setInterval(() => {
    if (S.view && S.view.phase === 'discuss' && S.view.endsAt) render();
  }, 250);
})();
