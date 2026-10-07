# Imposta

A party game for 3 to 10 players. Everyone answers a question on their own phone or laptop, but one player secretly got a different question. Reveal the answers, argue about it, and vote out the imposter.

## Run it

```bash
npm install
npm start
```

The server prints two kinds of address:

- `http://localhost:3000` for the computer it runs on
- `http://<your-ip>:3000` for other devices on the same Wi-Fi

One player creates a room and shares the 4-letter code (or the invite link in the lobby). Everyone else opens the same address, types a name and the code.

To play with people on other networks, host it anywhere that runs Node and supports WebSockets (set `PORT` if the host requires it), or put a tunnel in front of your local server.

## How a round works

1. **Answer** – everyone types a short answer to the question on their own screen.
2. **Reveal** – the real question and all answers appear on every screen at once.
3. **Discuss** – talk it out, with an optional countdown the host can skip.
4. **Vote** – everyone votes for who they think got a different question.
5. **Result** – players win if the imposter alone gets the most votes. A tie, or anyone else on top, is a win for the imposter.

Winners get a point on the scoreboard. A question pair is never repeated in the same room.

## Tests

```bash
npm test
```

Covers the game rules and plays a full four-player round over real WebSockets, checking that no device is ever sent another player's question or answer early.

## Layout

- `server.js` – static files and the WebSocket server
- `src/game.js` – rooms, rounds, scoring, and what each player is allowed to see
- `src/questions.js` – topics and question pairs
- `public/` – the browser client (no build step)
