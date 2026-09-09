#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${TMPDIR:-/tmp}/rewind-app-dev"
IOS_DEVICE_NAME="${IOS_DEVICE_NAME:-iPhone 15 Pro}"
IOS_DEVICE_UDID="${IOS_DEVICE_UDID:-}"
IOS_PORT="${IOS_PORT:-8081}"
WEB_PORT="${WEB_PORT:-8082}"
EXPO_GO_BUNDLE_ID="host.exp.Exponent"
EXPO_GO_APP_PATH="${EXPO_GO_APP_PATH:-}"

IOS_PID_FILE="$STATE_DIR/ios.pid"
IOS_DEVICE_FILE="$STATE_DIR/ios.device"
IOS_LOG="$STATE_DIR/ios.log"
WEB_PID_FILE="$STATE_DIR/web.pid"
WEB_LOG="$STATE_DIR/web.log"
IOS_LAUNCH_LABEL="rewind-app-ios"
WEB_LAUNCH_LABEL="rewind-app-web"

mkdir -p "$STATE_DIR"

say() {
  printf '[rewind-dev] %s\n' "$*"
}

die() {
  printf '[rewind-dev] ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage: scripts/rewind-dev.sh <command>

Commands:
  ios-up       Boot the explicitly selected iPhone 14+ simulator, start Expo,
               and open the project in Expo Go.
  ios-down     Stop the managed Expo server, terminate Expo Go, and shut down
               the selected simulator.
  web-up       Start the Expo web preview on port 8082 (or WEB_PORT).
  web-down     Stop the managed Expo web preview.
  up           Run ios-up followed by web-up.
  down         Run web-down followed by ios-down.
  status       Show managed PIDs and the selected simulator state.

Environment overrides:
  IOS_DEVICE_NAME  Exact simulator name; defaults to "iPhone 15 Pro".
  IOS_DEVICE_UDID  Optional exact simulator UDID; takes precedence by lookup.
  IOS_PORT         Expo native dev-server port; defaults to 8081.
  WEB_PORT         Expo web dev-server port; defaults to 8082.
  EXPO_GO_APP_PATH Optional local Expo Go .app bundle to install automatically.

Only iPhone 14+ simulators are accepted. iPhone SE devices are rejected.
USAGE
}

is_supported_iphone() {
  local name="$1"

  [[ "$name" != *SE* ]] || return 1
  [[ "$name" =~ ^iPhone[[:space:]](1[4-9]|[2-9][0-9])([[:space:]].*)?$ ]] || [[ "$name" == "iPhone Air" ]]
}

require_commands() {
  local command
  for command in npm xcrun ipconfig launchctl; do
    command -v "$command" >/dev/null 2>&1 || die "Required command not found: $command"
  done
}

lan_ip() {
  local interface address

  for interface in en0 en1; do
    address="$(ipconfig getifaddr "$interface" 2>/dev/null || true)"
    if [[ -n "$address" ]]; then
      printf '%s\n' "$address"
      return 0
    fi
  done

  die "Could not determine a LAN address for the Expo URL"
}

pid_is_alive() {
  [[ -n "$1" ]] && kill -0 "$1" 2>/dev/null
}

stop_pid_tree() {
  local pid="$1"
  local child

  pid_is_alive "$pid" || return 0
  while read -r child; do
    [[ -n "$child" ]] || continue
    stop_pid_tree "$child"
  done < <(pgrep -P "$pid" 2>/dev/null || true)
  kill "$pid" 2>/dev/null || true
}

read_pid() {
  local file="$1"
  [[ -f "$file" ]] || return 1
  tr -d '[:space:]' < "$file"
}

launch_job_pid() {
  local label="$1"
  launchctl list 2>/dev/null | awk -v target="$label" '$3 == target && $1 != "-" { print $1; exit }'
}

stop_managed_server() {
  local pid_file="$1"
  local label="$2"
  local launch_label="$3"
  local pid

  pid="$(read_pid "$pid_file" || true)"
  if [[ -n "$launch_label" ]] && [[ -n "$(launch_job_pid "$launch_label")" ]]; then
    say "Stopping $label (pid $pid)"
    launchctl remove "$launch_label" 2>/dev/null || true
  elif [[ -n "$pid" ]] && pid_is_alive "$pid"; then
    say "Stopping $label (pid $pid)"
    stop_pid_tree "$pid"
  fi
  rm -f "$pid_file"
}

simulator_line_for_name() {
  xcrun simctl list devices available | grep -F "    $IOS_DEVICE_NAME (" | head -1 || true
}

simulator_line_for_udid() {
  xcrun simctl list devices available | awk -v target="$IOS_DEVICE_UDID" '
    index($0, "(" target ")") { print; exit }
  '
}

resolve_simulator() {
  local line name udid

  if [[ -n "$IOS_DEVICE_UDID" ]]; then
    line="$(simulator_line_for_udid)"
    [[ -n "$line" ]] || die "Simulator UDID is not available: $IOS_DEVICE_UDID"
    name="${line#    }"
    name="${name%% (*}"
    IOS_DEVICE_NAME="$name"
  else
    line="$(simulator_line_for_name)"
    [[ -n "$line" ]] || die "Simulator not found: $IOS_DEVICE_NAME"
  fi

  is_supported_iphone "$IOS_DEVICE_NAME" || die "Refusing unsupported simulator '$IOS_DEVICE_NAME'. Use an iPhone 14+; iPhone SE is forbidden."
  udid="$(printf '%s\n' "$line" | sed -E 's/.*\(([A-F0-9-]{36})\).*/\1/')"
  [[ "$udid" =~ ^[A-F0-9-]{36}$ ]] || die "Could not parse simulator UDID for $IOS_DEVICE_NAME"
  IOS_DEVICE_UDID="$udid"
}

ensure_expo_go() {
  local app_path

  if xcrun simctl listapps "$IOS_DEVICE_UDID" 2>/dev/null | grep -q "\"$EXPO_GO_BUNDLE_ID\""; then
    return 0
  fi

  app_path="$EXPO_GO_APP_PATH"
  if [[ -z "$app_path" ]]; then
    app_path="$(find "$HOME/Library/Developer/CoreSimulator/Devices" -type d -name 'Expo-Go-*.app' -print -quit 2>/dev/null || true)"
  fi
  if [[ -n "$app_path" && -d "$app_path" ]]; then
    say "Installing Expo Go on $IOS_DEVICE_NAME"
    xcrun simctl install "$IOS_DEVICE_UDID" "$app_path"
    return 0
  fi

  say "Expo Go is not installed on $IOS_DEVICE_NAME and no local Expo Go bundle was found." >&2
  return 1
}

wait_for_log_pattern() {
  local log_file="$1"
  local pattern="$2"
  local attempt

  for attempt in {1..60}; do
    if grep -Eq "$pattern" "$log_file" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

start_native_server() {
  local pid launch_path

  pid="$(launch_job_pid "$IOS_LAUNCH_LABEL")"
  if [[ -n "$pid" ]]; then
    say "Expo native server already running (pid $pid); reusing it."
    printf '%s\n' "$pid" > "$IOS_PID_FILE"
    return 0
  fi
  if pid="$(read_pid "$IOS_PID_FILE" 2>/dev/null || true)"; then
    if [[ -n "$pid" ]] && pid_is_alive "$pid"; then
      say "Expo native server already running (pid $pid); reusing it."
      return 0
    fi
  fi

  : > "$IOS_LOG"
  launch_path="$PATH"
  launchctl remove "$IOS_LAUNCH_LABEL" 2>/dev/null || true
  launchctl submit -l "$IOS_LAUNCH_LABEL" -- /bin/bash -c "export PATH=\"$launch_path\"; cd \"$ROOT_DIR\"; exec npm start -- --lan --clear --port \"$IOS_PORT\" >> \"$IOS_LOG\" 2>&1"
  for _ in {1..10}; do
    pid="$(launch_job_pid "$IOS_LAUNCH_LABEL")"
    [[ -n "$pid" ]] && break
    sleep 1
  done
  [[ -n "$pid" ]] || pid="launchd:$IOS_LAUNCH_LABEL"
  printf '%s\n' "$pid" > "$IOS_PID_FILE"
  wait_for_log_pattern "$IOS_LOG" "Waiting on http://localhost:$IOS_PORT|Metro: exp://" || {
    stop_managed_server "$IOS_PID_FILE" 'Expo native server' "$IOS_LAUNCH_LABEL"
    say "Expo native server did not become ready. See $IOS_LOG" >&2
    return 1
  }
}

ios_up() {
  require_commands
  resolve_simulator

  say "Using $IOS_DEVICE_NAME ($IOS_DEVICE_UDID)"
  xcrun simctl boot "$IOS_DEVICE_UDID" 2>/dev/null || true
  xcrun simctl bootstatus "$IOS_DEVICE_UDID" -b >/dev/null
  open -a Simulator
  printf '%s\n' "$IOS_DEVICE_NAME|$IOS_DEVICE_UDID" > "$IOS_DEVICE_FILE"
  if ! ensure_expo_go; then
    ios_down
    die "Expo Go setup failed for $IOS_DEVICE_NAME"
  fi
  if ! start_native_server; then
    ios_down
    die "Expo native server failed to start. See $IOS_LOG"
  fi

  local project_url
  project_url="exp://$(lan_ip):$IOS_PORT"
  xcrun simctl openurl "$IOS_DEVICE_UDID" "$project_url"
  say "Expo Go opened on $IOS_DEVICE_NAME: $project_url"
}

ios_down() {
  local device_name device_udid

  stop_managed_server "$IOS_PID_FILE" 'Expo native server' "$IOS_LAUNCH_LABEL"
  if [[ -f "$IOS_DEVICE_FILE" ]]; then
    IFS='|' read -r device_name device_udid < "$IOS_DEVICE_FILE"
    xcrun simctl terminate "$device_udid" "$EXPO_GO_BUNDLE_ID" 2>/dev/null || true
    xcrun simctl shutdown "$device_udid" 2>/dev/null || true
    osascript -e 'tell application "Simulator" to quit' 2>/dev/null || true
    say "Expo Go terminated and $device_name shut down."
    rm -f "$IOS_DEVICE_FILE"
  else
    say "No managed iOS session found."
  fi
}

start_web_server() {
  local pid launch_path

  pid="$(launch_job_pid "$WEB_LAUNCH_LABEL")"
  if [[ -n "$pid" ]]; then
    say "Expo web server already running (pid $pid); reusing it."
    printf '%s\n' "$pid" > "$WEB_PID_FILE"
    return 0
  fi
  if pid="$(read_pid "$WEB_PID_FILE" 2>/dev/null || true)"; then
    if [[ -n "$pid" ]] && pid_is_alive "$pid"; then
      say "Expo web server already running (pid $pid); reusing it."
      return 0
    fi
  fi

  : > "$WEB_LOG"
  launch_path="$PATH"
  launchctl remove "$WEB_LAUNCH_LABEL" 2>/dev/null || true
  launchctl submit -l "$WEB_LAUNCH_LABEL" -- /bin/bash -c "export PATH=\"$launch_path\"; cd \"$ROOT_DIR\"; exec env BROWSER=none npm start -- --web --lan --clear --port \"$WEB_PORT\" >> \"$WEB_LOG\" 2>&1"
  for _ in {1..10}; do
    pid="$(launch_job_pid "$WEB_LAUNCH_LABEL")"
    [[ -n "$pid" ]] && break
    sleep 1
  done
  [[ -n "$pid" ]] || pid="launchd:$WEB_LAUNCH_LABEL"
  printf '%s\n' "$pid" > "$WEB_PID_FILE"
  wait_for_log_pattern "$WEB_LOG" "http://localhost:$WEB_PORT" || {
    stop_managed_server "$WEB_PID_FILE" 'Expo web server' "$WEB_LAUNCH_LABEL"
    say "Expo web server did not become ready. See $WEB_LOG" >&2
    return 1
  }
  say "Expo web preview ready at http://localhost:$WEB_PORT"
}

web_up() {
  require_commands
  start_web_server
}

web_down() {
  stop_managed_server "$WEB_PID_FILE" 'Expo web server' "$WEB_LAUNCH_LABEL"
  say "Expo web preview stopped."
}

status() {
  local pid launch_pid device_record pid_file launch_label

  for pid_file in "$IOS_PID_FILE" "$WEB_PID_FILE"; do
    launch_label="$IOS_LAUNCH_LABEL"
    [[ "$pid_file" == "$WEB_PID_FILE" ]] && launch_label="$WEB_LAUNCH_LABEL"
    if [[ -f "$pid_file" ]]; then
      pid="$(read_pid "$pid_file" || true)"
      launch_pid="$(launch_job_pid "$launch_label")"
      if [[ -n "$launch_pid" ]]; then
        say "$pid_file: running (pid $launch_pid)"
      elif [[ -n "$pid" ]] && pid_is_alive "$pid"; then
        say "$pid_file: running (pid $pid)"
      else
        say "$pid_file: stale"
      fi
    else
      say "$pid_file: stopped"
    fi
  done

  if [[ -f "$IOS_DEVICE_FILE" ]]; then
    device_record="$(cat "$IOS_DEVICE_FILE")"
    say "managed iOS device: $device_record"
  else
    say "managed iOS device: none"
  fi
}

command="${1:-}"
case "$command" in
  ios-up) ios_up ;;
  ios-down) ios_down ;;
  web-up) web_up ;;
  web-down) web_down ;;
  up)
    ios_up
    if ! web_up; then
      ios_down
      exit 1
    fi
    ;;
  down) web_down && ios_down ;;
  status) status ;;
  -h|--help|help) usage ;;
  *) usage; exit 64 ;;
esac
