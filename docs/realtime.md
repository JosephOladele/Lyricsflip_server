# Realtime (WebSocket) API

This document describes the WebSocket error contract used by the game and
realtime gateways.

## Error contract

All errors emitted over the socket share a single shape:

```json
{
  "event": "error",
  "data": {
    "code": 400,
    "message": "Validation failed",
    "details": [
      { "field": "guess", "message": "guess must be a string" }
    ]
  }
}
```

- `code` — numeric status code (HTTP-style, e.g. `400`, `403`, `500`).
- `message` — human-readable summary.
- `details` — optional array of field-level messages (present for validation
  failures).
## Rooms

| Room            | Joined by                                                   |
| --------------- | ----------------------------------------------------------- |
| `user:<id>`     | Automatically. Carries that player's own events.            |
| `session:<id>`  | `subscribe { type: 'session', id }`, players of the session |
| `room:<id>`     | `subscribe { type: 'room', id }`, members of the room       |

`subscribe` and `unsubscribe` are acknowledged with `{ ok: true, room }` or `{ ok: false, error }`. A session or room you do not belong to answers `Not found`, the same as one that does not exist.

## Events (server → client)

Every payload also carries `at`, the ISO time the server sent it. No payload contains a lyric or an answer.

| Event                    | Sent to                          | Payload                                                                                          |
| ------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------ |
| `session.player_joined`  | `session:<id>` or `room:<id>`, and the joining player | `{ scope: 'session' \| 'room', sessionId?, roomId?, userId }`                       |
| `round.started`          | the player, and `session:<id>`   | `{ roundId, sessionId \| null, userId, issuedAt, expiresAt, answerWindowSeconds }`               |
| `round.ended`            | the player, and `session:<id>`   | `{ roundId, sessionId \| null, userId, isCorrect, points, speedBonus, timedOut, hintsUsed }`     |
| `session.completed`      | `session:<id>` and both players  | `{ sessionId, playerId, playerTwoId, winnerId, score, playerTwoScore }`                          |
| `wager.staked`           | `session:<id>` and both players  | `{ wagerId, sessionId, playerAId, playerBId, stakeStroops, totalPotStroops }`                    |
| `wager.settled`          | `session:<id>` and both players  | `{ wagerId, sessionId, playerAId, playerBId, outcome: 'won' \| 'refunded', winnerId, totalPotStroops }` |

`round.*` events carry a `sessionId` when the round was served with `GET /game/lyric?sessionId=<id>`, which is how an opponent sees a player's progress. Rounds without one are only sent to the player.

`round.ended` is also sent when a round expires unanswered (`timedOut: true`, `points: 0`).

## `/game` gateway messages (client → server)

The `/game` namespace runs the same round loop as the HTTP API: every message is backed by `GameLogicService`, so a round row, its answer window, speed bonus, hints and history are created identically whether you play over WebSocket or HTTP. Socket-local state is keyed by `client.id`, so two tabs of the same user play independently and disconnecting one tab does not affect the other. Authoritative state lives in the database.

| Message        | Payload                                                       | Ack                                                                                                                              |
| -------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `requestLyric` | `{ sessionId? }`                                              | `{ roundId, issuedAt, answerWindowSeconds, lyric }` — or `{ error }` when the pool is exhausted (`NotFoundException`)          |
| `submitGuess`  | `{ roundId, guess }`                                          | `{ roundId, isCorrect, points, speedBonus, timedOut, hintsUsed }` — same scoring as `POST /game/guess`                          |
| `requestHint`  | `{ roundId }`                                                 | `{ roundId, hint, hintsUsed, pointsPenalty }` — same as `POST /game/hint`                                                        |

`requestLyric` returns `roundId`, `issuedAt` and `answerWindowSeconds` so the client can render the countdown; the answer window, hard expiry and anti-replay checks are enforced server-side. `submitGuess` and `requestHint` persist a round and a history row, so every WebSocket guess is scored and recorded exactly like an HTTP one.

## Where events come from

Services raise events on the in-process `EventEmitter2` bus under the names above (`src/realtime/realtime.events.ts`), and `RealtimeGateway` fans them out. Game rounds raise theirs directly. Session, wager and room changes are picked up by a TypeORM subscriber (`EntityEventsSubscriber`), so anything that saves those rows announces them, and events raised inside a transaction are held until it commits.

### Ack callbacks

When a client sends an event with an acknowledgement callback, the same
`{ code, message, details }` object is passed to the ack instead of (or in
addition to) the `error` event, so callers can handle failures inline.

### Validation failures

Gateway handlers validate payloads with a `ValidationPipe` configured with an
exception factory that throws `WsException`. An invalid payload (for example an
invalid `submitGuess` body) therefore returns a `400`-style error with
field-level messages over the socket rather than a generic
`Internal server error`.
