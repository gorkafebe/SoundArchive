"""Passwords, tokens and hashes.

Argon2id is the password hashing algorithm the OWASP guidelines recommend: it
is deliberately slow and memory-hungry, so a stolen database cannot be
tried against billions of guesses per second. The defaults of argon2-cffi
(64 MiB, 3 passes, 4 lanes) follow RFC 9106's low-memory profile.

The session token and the invitation code are different: they are long random
values (not chosen by a person), so a fast hash is enough and is what makes
looking them up on every request cheap.
"""

import hashlib
import secrets
from pathlib import Path

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

PASSWORD_MIN = 12
PASSWORD_MAX = 256  # hashing a huge string on purpose would be a cheap attack

_hasher = PasswordHasher()

# A hash of a throwaway value. When a username does not exist, the login still
# verifies against this, so both cases take the same time.
_DUMMY_HASH = _hasher.hash(secrets.token_urlsafe(16))

_COMMON = frozenset(
    line.strip().lower()
    for line in (Path(__file__).parent / "common_passwords.txt").read_text().splitlines()
    if line.strip() and not line.startswith("#")
)


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(stored_hash: str | None, password: str) -> bool:
    """True if it matches. With no hash (unknown user) it takes the same time."""
    try:
        _hasher.verify(stored_hash or _DUMMY_HASH, password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False
    return stored_hash is not None


def needs_rehash(stored_hash: str) -> bool:
    return _hasher.check_needs_rehash(stored_hash)


def password_problem(password: str, username: str | None = None) -> str | None:
    """Why this password is not acceptable, as a short code; None if it is fine.

    Length and a list of known passwords, and no composition rules (a capital
    letter, a symbol...): those make passwords harder to remember and barely
    harder to guess (NIST SP 800-63B).
    """
    if len(password) < PASSWORD_MIN:
        return "password_too_short"
    if len(password) > PASSWORD_MAX:
        return "password_too_long"
    lowered = password.lower()
    if lowered in _COMMON or len(set(lowered)) <= 2:
        return "password_too_common"
    if username and username.lower() in lowered:
        return "password_contains_username"
    return None


def new_token() -> str:
    """256 random bits, as URL-safe text."""
    return secrets.token_urlsafe(32)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def csrf_token_for(session_token: str) -> str:
    """The CSRF token of a session, derived from it, so nothing more is stored.

    Another site can neither read the cookie nor compute this value.
    """
    return hashlib.sha256(f"csrf:{session_token}".encode()).hexdigest()


# No 0/O or 1/I/L: a code may be read aloud or typed from another screen.
_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"


def new_invitation_code() -> str:
    """SA-XXXX-XXXX-XXXX-XXXX: 16 symbols from 31, about 79 bits of randomness."""
    symbols = [secrets.choice(_CODE_ALPHABET) for _ in range(16)]
    groups = ["".join(symbols[i : i + 4]) for i in range(0, 16, 4)]
    return "SA-" + "-".join(groups)


def normalise_code(code: str) -> str:
    return code.strip().upper()
