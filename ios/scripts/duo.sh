#!/bin/bash
# Fold, turn and screenshot the iPhone Duo simulator from a script. Xcode 27.2 draws the Duo in DeviceHub, whose
# action bar has Closed, Partially Open, Open and Rotate Right buttons; nothing on the command line sets the hinge,
# so this presses them through System Events (the app running the script needs Accessibility access).
#   ios/scripts/duo.sh pose closed|half|open      fold the device (DeviceHub opens on it first)
#   ios/scripts/duo.sh turn portrait|landscape    rotate until the device reports it: open, portrait is the inner
#                                                 screen held wide (951 x 669 pt) and landscape turns it tall
#   ios/scripts/duo.sh shot <file.png>            screenshot the display the app is on (LCD closed, LCD-1 open)
#   ios/scripts/duo.sh state                      the orientation and the active display
#   SNIP_SIM="iPhone Duo (mine)" ios/scripts/duo.sh ...   another device (default "iPhone Duo")
# `xcrun devicectl device orientation set` is ignored on the Duo, hence Rotate Right.
#
# DeviceHub's buttons act on whichever device its window shows, and other sessions (this app's and
# the audiobook app's, jakeschaeffer/audiobooth-fork scripts/duo/hub.sh) fold Duo simulators of their
# own, so every press runs under one lockf lock shared by every script on this Mac that folds a Duo:
# select the device, press, wait out the fold, then let the next caller in. The lock file is
# $DUO_HUB_LOCK, default ~/Library/Caches/duo-devicehub.lock; keep that default identical in both repos.
set -euo pipefail

LOCK="${DUO_HUB_LOCK:-$HOME/Library/Caches/duo-devicehub.lock}"

DEVICE="${SNIP_SIM:-iPhone Duo}"
UDID=$(xcrun simctl list devices available | grep -F "$DEVICE (" | head -1 | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')
[ -n "$UDID" ] || { echo "error: no available simulator named '$DEVICE'" >&2; exit 1; }

# Press one of DeviceHub's buttons for this device, then wait `settle` seconds for the fold, all under the
# shared lock (the script re-runs itself as `_press` inside lockf).
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
press() { /usr/bin/lockf -k -t 900 "$LOCK" "$SELF" _press "$1" "${2:-0}"; }

# Show the device in DeviceHub's window (its sidebar row holds the device's name), then press one of its buttons.
press_unlocked() {
  open -g "$(xcode-select -p)/../Applications/DeviceHub.app"
  osascript - "$DEVICE" "$1" <<'OSA'
on run argv
  set deviceName to item 1 of argv
  set label to item 2 of argv
  tell application "System Events"
    tell process "DeviceHub"
      repeat 50 times
        if (count of windows) > 0 then exit repeat
        delay 0.2
      end repeat
      set split to splitter group 1 of group 1 of splitter group 1 of group 1 of window 1
      set sidebar to outline 1 of scroll area 1 of group 1 of split
      repeat with r in (rows of sidebar)
        try
          if (value of static text 1 of UI element 1 of r) is deviceName then
            if not (selected of r) then
              set selected of r to true
              delay 1.5
            end if
            exit repeat
          end if
        end try
      end repeat
      -- Selecting a device renames the window, which invalidates the reference above: look it up again.
      set split to splitter group 1 of group 1 of splitter group 1 of group 1 of window 1
      repeat with b in (buttons of group 3 of split)
        try
          if (value of attribute "AXHelp" of b) is label then
            perform action "AXPress" of b
            return label
          end if
        end try
      end repeat
      error "DeviceHub has no button " & label & " for " & deviceName
    end tell
  end tell
end run
OSA
}

orientation() { xcrun devicectl device orientation get --device "$UDID" 2>/dev/null | tail -1 | sed 's/.*: //'; }

active_display() {
  xcrun devicectl device info displays --device "$UDID" 2>/dev/null \
    | sed -nE 's/^[^0-9]*[0-9]+: ([A-Za-z0-9-]+) .*\(active\).*/\1/p' | head -1
}

case "${1:-}" in
  _press)
    # Inside the lock (see press).
    press_unlocked "$2"
    sleep "$3"
    ;;
  pose)
    case "${2:-}" in
      closed) press "Closed" 3 ;;
      half) press "Partially Open" 3 ;;
      open) press "Open" 3 ;;
      *) echo "usage: $0 pose closed|half|open" >&2; exit 2 ;;
    esac
    ;;
  turn)
    want="${2:-}"
    [ "$want" = landscape ] && want=landscapeRight
    for _ in 1 2 3 4 5; do
      [ "$(orientation)" = "$want" ] && exit 0
      press "Rotate Right" 2.5 >/dev/null
    done
    echo "error: the device stayed $(orientation)" >&2
    exit 1
    ;;
  shot)
    [ -n "${2:-}" ] || { echo "usage: $0 shot <file.png>" >&2; exit 2; }
    display=$(active_display)
    xcrun simctl io "$UDID" screenshot --display="${display:-LCD}" "$2" >/dev/null 2>&1
    echo "$2 (${display:-LCD})"
    ;;
  state)
    echo "$DEVICE ($UDID): $(orientation), app on $(active_display)"
    ;;
  *)
    sed -n '2,12p' "$0"
    exit 2
    ;;
esac
