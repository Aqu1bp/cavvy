# launchctl on the pretend Mac (fake-ssh.ts): it keeps which jobs are loaded, starts a loaded job's program once (as
# launchd does at load; nothing starts it again), and refuses what the real one refuses. $FAKE_DIR: the pretend
# server's folder. $FAKE_SUDO: run by its sudo.
who=user
[ -n "$FAKE_SUDO" ] && who=root
echo "$who $*" >> "$FAKE_DIR/launchctl.log"
mark() { echo "$FAKE_DIR/loaded-$(printf '%s' "$1" | tr '/' '_')"; }
# Only an administrator changes the system's jobs.
may() { case "$1" in system*) [ "$who" = root ] ;; esac; }
case "$1" in
print)
    [ -f "$(mark "$2")" ] || { echo "Bad request. Could not find service \"$2\"" >&2; exit 113; }
    ;;
bootstrap)
    may "$2" || { echo "Bootstrap failed: 1: Operation not permitted" >&2; exit 1; }
    case "$2" in system) [ -f "$FAKE_DIR/refuse-daemon" ] && { echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; } ;; esac
    m=$(mark "$2/$(basename "$3" .plist)")
    # One that's loaded already, and an agent that isn't for the background session: both are refused like this.
    refused() { echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; }
    [ -f "$m" ] && refused
    case "$2" in user/*) grep -q '<key>LimitLoadToSessionType</key><string>Background</string>' "$3" || refused ;; esac
    unxml() { sed -e 's/&gt;/>/g' -e 's/&lt;/</g' -e 's/&amp;/\&/g'; }
    line=$(grep '<key>ProgramArguments</key>' "$3")
    script=$(printf '%s' "$line" | sed -e 's/.*<string>-c<\/string><string>//' -e 's/<\/string><string>.*//' | unxml)
    arg0=$(printf '%s' "$line" | sed -e 's/.*<\/string><string>//' -e 's/<\/string><\/array>.*//' | unxml)
    nohup /bin/sh -c "$script" "$arg0" > /dev/null 2>&1 < /dev/null &
    echo $! > "$m"
    ;;
bootout)
    may "$2" || { echo "Boot-out failed: 1: Operation not permitted" >&2; exit 1; }
    m=$(mark "$2")
    [ -f "$m" ] || { echo "Boot-out failed: 3: No such process" >&2; exit 3; }
    pid=$(cat "$m")
    kill -TERM "$pid" 2>/dev/null
    n=0
    while kill -0 "$pid" 2>/dev/null && [ "$n" -lt 100 ]; do sleep 0.1; n=$((n + 1)); done
    rm -f "$m"
    ;;
*)
    echo "fake launchctl: $1 isn't something Cavvy should ask" >&2
    exit 64
    ;;
esac
exit 0
