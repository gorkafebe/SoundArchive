# Redaction filter for anything the ops scripts save or print.
#
# Use:   some-command | sed -E -f ops/lib/redact.sed
#
# Why: the checks read network state (ss, tailscale), and reports end up in
# files that may be shared or committed. Addresses, MACs and the tailnet name
# say where the server is and how to reach it, so they are replaced by
# placeholders. Loopback (127.x), the "any" address (0.0.0.0, [::]) and
# version numbers are left alone, because they are what a check needs to show.
#
# GNU sed, extended regular expressions (-E). The I flag = case-insensitive.

# MAC addresses (six pairs of hex digits).
s/\b([0-9a-f]{2}:){5}[0-9a-f]{2}\b/<MAC>/Ig

# Tailscale IPv6 (the fd7a:115c:a1e0::/48 range Tailscale uses).
s/\bfd7a:115c:a1e0(:[0-9a-f]{0,4}){1,6}/<IPv6-tailscale>/Ig
# Link-local IPv6 (fe80::/10).
s/\bfe[89ab][0-9a-f]:(:?[0-9a-f]{0,4}){1,7}/<IPv6-link-local>/Ig
# Other unique-local IPv6 (fc00::/7).
s/\bf[cd][0-9a-f]{2}:(:?[0-9a-f]{0,4}){1,7}/<IPv6-local>/Ig
# Global IPv6 (2000::/3): starts with 2 or 3, at least three groups.
s/\b[23][0-9a-f]{3}:(:?[0-9a-f]{0,4}){2,7}/<IPv6-global>/Ig

# Tailscale IPv4 (CGNAT range 100.64.0.0/10).
s/\b100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}\b/<IP-tailscale>/g
# Private IPv4 (home network).
s/\b(10\.[0-9]{1,3}|192\.168|172\.(1[6-9]|2[0-9]|3[01]))\.[0-9]{1,3}\.[0-9]{1,3}\b/<IP-local>/g
# Docker's own bridge networks are 172.17-31.x: covered above.
# Any other IPv4 except loopback and 0.0.0.0 is treated as public.
s/\b(12[0-6]|12[89]|1[3-9][0-9]|2[0-5][0-9]|[1-9][0-9]?|1[01][0-9])\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\b/<IP-publica>/g

# Tailnet names (MagicDNS).
s/\b[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net\b/<tailnet>.ts.net/Ig

# E-mail addresses, except GitHub's noreply form.
# The noreply "@" is hidden first, then every other address is replaced,
# then the noreply "@" is put back.
s/@(users\.noreply\.github\.com)/{AT}\1/Ig
s/\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/<correo>/Ig
s/\{AT\}/@/g
