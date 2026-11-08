#!/bin/sh
# Static check of the Makefile: every target whose recipe runs Compose must have
# a guard as its FIRST prerequisite (make runs prerequisites in order, and the
# guard must stop it before anything else happens):
#   guard-prod     for targets that use $(PROD) or name sound-archive,
#   guard-project  for every other one.
#
# A recipe "runs Compose" if it says `docker compose`, or uses a variable whose
# definition does (found by following the definitions, so a new macro counts).
#
#   scripts/check-make-guards.sh [Makefile]          fails if a guard is missing
#   scripts/check-make-guards.sh --list [Makefile]   prints: <target> <guard>
#
# What it cannot see: a Compose command inside a script that a recipe calls.
set -eu

mode=check
if [ "${1:-}" = --list ]; then
    mode=list
    shift
fi
makefile="${1:-Makefile}"
[ -r "$makefile" ] || { echo "FAIL: cannot read $makefile" >&2; exit 2; }

awk -v mode="$mode" '
# Join lines ending in a backslash: make sees them as one line.
{
    line = pending $0
    pending = ""
    if (line ~ /\\$/) { sub(/\\$/, " ", line); pending = line; next }
    logical[++n] = line
}

function is_assignment(s) {
    return s !~ /^\t/ && s ~ /^(override[ \t]+)?[A-Za-z_][A-Za-z0-9_]*[ \t]*(\?|:|::|\+)?=/
}
function assignment_name(s,    name) {
    name = s
    sub(/^override[ \t]+/, "", name)
    sub(/[ \t]*(\?|::|:|\+)?=.*/, "", name)
    return name
}
function runs_compose(s,    v) {
    if (s ~ /docker[ \t]+compose/) return 1
    for (v in compose_var) if (index(s, "$(" v ")") || index(s, "${" v "}")) return 1
    return 0
}

END {
    compose_var["COMPOSE"] = 1
    # Definitions can refer to one another: repeat until nothing new appears.
    do {
        changed = 0
        for (i = 1; i <= n; i++) {
            if (is_assignment(logical[i]) && runs_compose(logical[i])) {
                name = assignment_name(logical[i])
                if (!(name in compose_var)) { compose_var[name] = 1; changed = 1 }
            }
        }
    } while (changed)

    for (i = 1; i <= n; i++) {
        s = logical[i]
        if (s ~ /^\t/) {
            recipe = s
        } else if (s ~ /^#/ || is_assignment(s) || s !~ /:/) {
            continue
        } else {
            rule = s
            sub(/[ \t]*#.*/, "", rule)
            colon = index(rule, ":")
            targets = substr(rule, 1, colon - 1)
            prereqs = substr(rule, colon + 1)
            recipe = ""
            semi = index(prereqs, ";")
            if (semi) { recipe = substr(prereqs, semi + 1); prereqs = substr(prereqs, 1, semi - 1) }
            current_count = split(targets, current, /[ \t]+/)
            word_count = split(prereqs, words, /[ \t]+/)
            first = ""
            for (w = 1; w <= word_count; w++) if (words[w] != "") { first = words[w]; break }
            for (t = 1; t <= current_count; t++) first_prereq[current[t]] = first
        }
        if (recipe == "" || !runs_compose(recipe)) continue
        wanted = (recipe ~ /\$\(PROD\)/ || recipe ~ /-p[ \t]+sound-archive/) ? "guard-prod" : "guard-project"
        for (t = 1; t <= current_count; t++) {
            target = current[t]
            if (target == "" || target ~ /^\./ || target ~ /^guard-/) continue
            if (need[target] != "guard-prod") need[target] = wanted
        }
    }

    bad = 0
    count = 0
    for (target in need) {
        count++
        if (mode == "list") { print target, need[target]; continue }
        if (first_prereq[target] != need[target]) {
            printf "FAIL: make %s runs Compose, so its first prerequisite must be %s (found: \"%s\")\n", target, need[target], first_prereq[target]
            bad = 1
        }
    }
    if (count == 0) { print "FAIL: found no target that runs Compose; this check is broken"; exit 2 }
    if (bad) exit 1
    if (mode == "check") printf "OK: all %d targets that run Compose have their guard first.\n", count
}
' "$makefile"
