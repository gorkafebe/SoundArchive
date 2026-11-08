#!/bin/sh
# Trust the instance's private root certificate in this container's browser
# profile (Chromium reads $HOME/.pki/nssdb), then run the given command.
#
#   trust-ca /ca/root.crt npx playwright test
set -eu
ca="$1"; shift
mkdir -p "$HOME/.pki/nssdb"
certutil -d "sql:$HOME/.pki/nssdb" -N --empty-password
certutil -d "sql:$HOME/.pki/nssdb" -A -t "C,," -n sound-archive-root -i "$ca"
exec "$@"
