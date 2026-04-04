# Matchmaking (Socket.io + Upstash Redis)

## Environment

Set in `.env`:

- `UPSTASH_REDIS_REST_URL` — from Upstash dashboard (REST API URL)
- `UPSTASH_REDIS_REST_TOKEN` — from Upstash dashboard

Without these, `join_queue` responds with `queue_error` (matching disabled).

## Database

Run migration for `user_blocks` (pair blocking):

```bash
npx prisma migrate deploy
```

## Redis keys

| Key | Purpose |
|-----|---------|
| `matching:{collegeId}` | List of **socket IDs** (FIFO: `RPUSH` / scan with `LRANGE`) |
| `matching:socket:{socketId}` | JSON: `userId`, `username`, `collegeId`, `joinedAt` |
| `matching:active_colleges` | SET of `collegeId` values that have a non-empty queue |
| `cloak:lastmatch:{userA}:{userB}` | Sorted pair (`userA` &lt; `userB` lexicographically); value = timestamp; **TTL 30 minutes** — prevents rematch within window |

## Socket events (client → server)

- **Handshake:** `auth.token` = JWT access token (same as `cloak_access_token`).
- **`join_queue`** `{ username }` — 2–20 chars; user must be authenticated; queues by JWT `collegeId`.
- **`leave_queue`** — remove from queue (also runs on disconnect).

## Socket events (server → client)

- **`connected`** — hello after connect.
- **`joined_queue`** `{ ok: true }` — queued successfully.
- **`match_found`** `{ room_id, peer_username, peer_user_id }` — both peers get the same `room_id`.
- **`queue_timeout`** `{ message }` — no match within **60 seconds** of joining.
- **`queue_error`** `{ message }` — validation / Redis / duplicate join.

## Algorithm

1. Every **500ms**, iterate `matching:active_colleges` and run pairing for each college queue.
2. If **≥2** waiters, scan pairs in FIFO order until a pair passes:
   - not the same user
   - no **UserBlock** row either direction (Postgres)
   - no **`cloak:lastmatch:*`** key for the pair (Redis, 30 min cooldown)
3. On match: remove both from queue, set cooldown key (30 min TTL), emit `match_found` to both sockets.
4. **60s** after `join_queue`, if still waiting → `queue_timeout` and remove from queue.
5. **Disconnect** → remove socket from Redis queue and metadata.

## Frontend

Dev server proxies WebSocket `/socket.io` to `http://localhost:4000` (see root `vite.config.js`).
