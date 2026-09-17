# Hosted Demo deployment

The hosted Sprint 2 shape is one non-root Node 22 container on the Lightsail
instance. The container owns the HTTP runtime and FFmpeg; SQLite and media are
bind-mounted from persistent instance storage. The service is exposed only on
`127.0.0.1:8787` until a public HTTPS distribution/reverse proxy is configured.

## Build and start

From the repository root:

```sh
cp deploy/rewind.env.example deploy/rewind.env
docker compose --env-file deploy/rewind.env -f deploy/compose.yaml build
docker compose --env-file deploy/rewind.env -f deploy/compose.yaml run --rm runtime migrate
docker compose --env-file deploy/rewind.env -f deploy/compose.yaml up -d
curl --fail http://127.0.0.1:8787/health
```

The migration command is idempotent and seeds the deterministic five-member
Demo fixture. `server/dist`, migrations, and fixtures are compiled/copied into
the image; no source checkout is required at runtime.

## Backup

`backup.sh` uses SQLite `VACUUM INTO` for a consistent online snapshot,
archives persistent media separately, uploads both with server-side AES256
encryption, and writes a checksum manifest. It removes local archives older
than seven days. The S3 bucket is private and its lifecycle policy is the
remote retention control.

The systemd unit files are templates. Install them on the host only after the
restricted backup AWS identity has been configured:

```sh
sudo install -m 0644 deploy/rewind-backup.service /etc/systemd/system/
sudo install -m 0644 deploy/rewind-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now rewind-backup.timer
```

Do not put AWS access keys in this repository or in `rewind.env`; use the
dedicated `AWS_PROFILE` credential store on the host. The intended policy is
limited to listing the backup bucket and writing objects under the
`rewind-demo/` prefix.

## Pause and resume

Normal pause runs **on the Lightsail host**:

```sh
cd /srv/rewind
./deploy/pause-host.sh
```

It backs up and verifies SQLite plus media in S3, stops Docker, and then powers
off the host. A failed backup prevents shutdown. Resume from the trusted
operator machine with:

```sh
./infra/scripts/wake-demo.sh
```

The local command assumes the restricted `rewind-demo-operator` AWS profile
and invokes the controller Lambda; it has no direct Lightsail permission. To
stop from the operator machine after a host backup, pass the uploaded manifest:

```sh
./infra/scripts/stop-demo.sh rewind-demo/rewind-<timestamp>.manifest.json
```

`infra/scripts/emergency-stop-demo.sh --i-have-a-current-s3-backup` is only
for when the host cannot be reached; it deliberately requires acknowledgement
because it cannot make the backup itself.

Stopping Lightsail does **not** stop its fixed monthly bundle charge. For
near-zero recurring compute cost, make a verified backup and deliberately
delete the instance and static IP through a separately reviewed Terraform
teardown. S3 and CloudTrail storage remain as the small residual cost.
