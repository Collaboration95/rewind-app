# Local Demo runbook

This runbook lets a non-author prove the complete local capsule journey without
camera hardware, cloud services, source edits, or personal media.

## Before you start

Use Node.js 22.13.0 or newer, npm 10 or newer, and an available `ffmpeg`
executable. From the repository root:

```sh
npm ci
npm run test:full-cycle
```

The command builds the local server and creates an isolated temporary data
directory. It does not reuse or modify `.local-data`, app storage, source
files, or AWS resources.

## Expected journey

The command reports one passing scenario named:

```text
full-cycle: reset → join → sealed clip → reveal → authorized archive
```

It proves these stages in order:

1. An owner starts local Demo access and creates a local group.
2. A second synthetic member joins through an owner-generated invite.
3. A generated portrait MP4 with audio is staged, accepted, processed, and
   sealed through the real local HTTP boundary.
4. A group message is accepted.
5. The premiere is confirmed locked before release.
6. The cycle lifecycle creates a durable film job; FFmpeg compiles and
   publishes a playable film.
7. An authorized member plays the released film and sees the released group
   film plus their own clip in the archive.

Each HTTP assertion labels its journey stage. If the command fails, use the
first stage named in the failure output rather than skipping forward.

## Reset and repeat

Run `npm run test:full-cycle` again. Its temporary database and media are
removed after every run, including failure, so no manual cleanup is required.

For the offline Expo shell, use `npm run web`. If a local runtime has been
started manually, `npm run server:reset` restores its deterministic five-member
fixture.

## Known limits and fallback

The automated command is the complete supported no-hardware demonstration.
The mobile fixture camera intentionally does not claim to record video, and
the current app has no owner-facing reveal control. Do not describe the fixture
as a physical recording or use the app UI to claim a manual end-to-end release.

The pending local-Demo reveal control and server-owned synthetic clip are tracked
in GitHub issues #102 and #103. Hosted deployment, backup, and shutdown work is
separate; follow the guarded [deployment guide](../deploy/README.md) rather
than using this local runbook for AWS operations.
