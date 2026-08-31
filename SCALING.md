# Casual multiplayer scaling plan

The client is intentionally not the authority for matchmaking or game results.
The existing `join_random_game` RPC uses a row lock with `SKIP LOCKED`, so two
players cannot join the same waiting seat. The accompanying migration adds the
partial indexes needed to keep that lookup fast as old games accumulate.

To operate at a five-million-account scale, apply the migration and use this
deployment shape:

1. Keep matchmaking, game settlement, bot assignment, and cleanup in
   server-side functions/jobs. The app should only request a match and submit a
   move; it must never decide a match result.
2. Schedule `expire_abandoned_casual_rooms(10)` every minute and archive
   completed games to cold storage. Keep the live `games` table small.
3. Partition active-match traffic by region and room ID, and broadcast only to
   the players in that game channel. Do not subscribe a lobby to all games or
   all users.
4. Load-test the actual Supabase project with realistic concurrent connections,
   then set connection, realtime, database, and edge-function limits from those
   measurements. Five million registered accounts does not mean five million
   simultaneous players, so capacity must be sized to the agreed peak
   concurrency and move rate.
5. Monitor matchmaking latency, locked-room retries, realtime disconnects,
   error rates, and stale-room cleanup. Alert before saturation and use
   exponential retry with a user-visible retry action for transient failures.

The app already catches screen-level crashes through its error boundary. Network
operations are handled with user-facing errors; production should additionally
send sanitized error events to a monitoring service so failures can be traced
without exposing player data.
