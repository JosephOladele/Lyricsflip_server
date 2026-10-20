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
