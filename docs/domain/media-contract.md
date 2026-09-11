# Local clip contract

Contributions are portrait MP4 clips with microphone audio and a hard
15-second maximum. Client review keeps trim bounds inside the recorded clip,
requires at least half a second, and offers the original **Soft Focus** and
**High Contrast** modes. Trim and mode are persisted as pending metadata until
the upload job is created.

The local runtime validates session, group membership, media type, size,
duration, orientation, and audio before creating a contribution and pending
clip job. Upload requests carry an idempotency key. A retry returns the same
pending job without consuming quota twice; cancellation removes the temporary
job/contribution and releases its quota. Raw media paths are not durable
metadata or cloud objects.
