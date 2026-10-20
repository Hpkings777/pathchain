"""
PATHchain crypto — 100% pure Python, zero external dependencies.

Real cryptographic primitives used by the PATH network:
  * SHA-256 (hashlib, stdlib)              — block hashing + transaction IDs
  * RIPEMD-160                             — Bitcoin-style address hashing
     (hashlib when OpenSSL provides it, otherwise a pure-Python implementation)
  * secp256k1 ECDSA (RFC 6979 deterministic nonces) — transaction signatures
  * Base58Check encoding                   — human-friendly wallet addresses

Everything here is educational: the formats deliberately match Bitcoin
(P2PKH-style addresses starting with "1", compressed WIF keys starting with
K/L) so students can compare PATH with a real blockchain, but PATH is a
school demo currency and is NOT connected to Bitcoin or any real funds.
"""

import hashlib
import hmac
import secrets

# ---------------------------------------------------------------- SHA-256 ----

def sha256_hex(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def sha256_bytes(data):
    return hashlib.sha256(data).digest()


def double_sha256(data):
    return hashlib.sha256(hashlib.sha256(data).digest()).digest()


def canonical_json(obj):
    """Deterministic JSON — the same bytes on every node, so hashes always match."""
    import json
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


# ------------------------------------------------------------ RIPEMD-160 ----
# Pure-Python fallback (used automatically when hashlib.new("ripemd160")
# is unavailable, e.g. OpenSSL 3+ on some systems). Compact reference design.

def _ripemd160_pure(message: bytes) -> bytes:
    # Message schedule rotations
    RL = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
          7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8,
          3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12,
          1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2,
          4, 0, 5, 9, 7, 12, 2, 10, 14, 1, 3, 8, 11, 6, 15, 13]
    RR = [5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12,
          6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2,
          15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13,
          8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14,
          12, 15, 10, 4, 1, 5, 8, 7, 6, 2, 13, 14, 0, 3, 9, 11]
    SL = [11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8,
          7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12,
          11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5,
          11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12,
          9, 15, 5, 11, 6, 8, 13, 12, 5, 12, 13, 14, 11, 8, 5, 6]
    SR = [8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6,
          9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11,
          9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5,
          15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8,
          8, 5, 12, 9, 12, 5, 14, 6, 8, 13, 6, 5, 15, 13, 11, 11]
    KL = [0x00000000, 0x5A827999, 0x6ED9EBA1, 0x8F1BBCDC, 0xA953FD4E]
    KR = [0x50A28BE6, 0x5C4DD124, 0x6D703EF3, 0x7A6D76E9, 0x00000000]

    def rol(x, n):
        return ((x << n) | (x >> (32 - n))) & 0xFFFFFFFF

    def f(j, x, y, z, rnd):
        if rnd == 0:
            return x ^ y ^ z
        if rnd == 1:
            return (x & y) | (~x & z)
        if rnd == 2:
            return (x | ~y) ^ z
        if rnd == 3:
            return (x & z) | (y & ~z)
        return x ^ (y | ~z)

    h = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0]

    # Padding (little-endian length, like MD4/MD5 family)
    msg = bytearray(message)
    bit_len = len(message) * 8
    msg.append(0x80)
    while len(msg) % 64 != 56:
        msg.append(0)
    msg += bit_len.to_bytes(8, "little")

    for off in range(0, len(msg), 64):
        X = [int.from_bytes(msg[off + i * 4: off + i * 4 + 4], "little") for i in range(16)]
        al, bl, cl, dl, el = h
        ar, br, cr, dr, er = h
        for j in range(80):
            rnd = j // 16
            t = (al + f(j, bl, cl, dl, rnd) + X[RL[j]] + KL[rnd]) & 0xFFFFFFFF
            t = (rol(t, SL[j]) + el) & 0xFFFFFFFF
            al, el, dl, cl, bl = el, dl, rol(cl, 10), bl, t
            t = (ar + f(79 - j, br, cr, dr, rnd) + X[RR[j]] + KR[rnd]) & 0xFFFFFFFF
            t = (rol(t, SR[j]) + er) & 0xFFFFFFFF
            ar, er, dr, cr, br = er, dr, rol(cr, 10), br, t
        t = (h[1] + cl + dr) & 0xFFFFFFFF
        h[1] = (h[2] + dl + er) & 0xFFFFFFFF
        h[2] = (h[3] + el + ar) & 0xFFFFFFFF
        h[3] = (h[4] + al + br) & 0xFFFFFFFF
        h[4] = (h[0] + bl + cr) & 0xFFFFFFFF
        h[0] = t

    return b"".join(v.to_bytes(4, "little") for v in h)


def ripemd160(data: bytes) -> bytes:
    try:
        return hashlib.new("ripemd160", data).digest()
    except (ValueError, TypeError):
        return _ripemd160_pure(data)


def hash160(data: bytes) -> bytes:
    """SHA-256 followed by RIPEMD-160 — exactly how Bitcoin derives address hashes."""
    return ripemd160(sha256_bytes(data))


# ------------------------------------------------------------- Base58Check ----

B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def base58_encode(raw: bytes) -> str:
    value = int.from_bytes(raw, "big")
    encoded = ""
    while value:
        value, rem = divmod(value, 58)
        encoded = B58_ALPHABET[rem] + encoded
    leading_zeros = len(raw) - len(raw.lstrip(b"\x00"))
    return "1" * leading_zeros + encoded


def base58_decode(text: str) -> bytes:
    value = 0
    for char in text:
        value = value * 58 + B58_ALPHABET.index(char)
    body = value.to_bytes((value.bit_length() + 7) // 8, "big") if value else b""
    leading_zeros = len(text) - len(text.lstrip("1"))
    return b"\x00" * leading_zeros + body


def base58check_encode(payload: bytes) -> str:
    checksum = double_sha256(payload)[:4]
    return base58_encode(payload + checksum)


def base58check_decode(text: str):
    decoded = base58_decode(text)
    payload, checksum = decoded[:-4], decoded[-4:]
    if double_sha256(payload)[:4] != checksum:
        raise ValueError("invalid Base58Check checksum")
    return payload


# ------------------------------------------------------- secp256k1 ECDSA ----
# Jacobian coordinates for fast-ish pure-Python point arithmetic.

P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
Gx = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798
Gy = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8


def _inv(a, m):
    """Modular inverse (works on Python 3.8+ via pow, with a guaranteed fallback)."""
    try:
        return pow(a, -1, m)
    except (ValueError, TypeError):
        lm, hm = 1, 0
        low, high = a % m, m
        while low > 1:
            r = high // low
            lm, hm = hm - lm * r, lm
            low, high = high % low, low
        return lm % m


def _jac_double(pt):
    if pt is None or pt[2] == 0:
        return None
    x, y, z = pt
    ysq = (y * y) % P
    s = (4 * x * ysq) % P
    m = (3 * x * x) % P
    nx = (m * m - 2 * s) % P
    ny = (m * (s - nx) - 8 * ysq * ysq) % P
    nz = (2 * y * z) % P
    return (nx, ny, nz)


def _jac_add(p1, p2):
    if p1 is None or p1[2] == 0:
        return p2
    if p2 is None or p2[2] == 0:
        return p1
    x1, y1, z1 = p1
    x2, y2, z2 = p2
    z1z1 = (z1 * z1) % P
    z2z2 = (z2 * z2) % P
    u1 = (x1 * z2z2) % P
    u2 = (x2 * z1z1) % P
    s1 = (y1 * z2 * z2z2) % P
    s2 = (y2 * z1 * z1z1) % P
    if u1 == u2:
        if s1 != s2:
            return None
        return _jac_double(p1)
    h = (u2 - u1) % P
    i = (4 * h * h) % P
    j = (h * i) % P
    r = (2 * (s2 - s1)) % P
    v = (u1 * i) % P
    nx = (r * r - j - 2 * v) % P
    ny = (r * (v - nx) - 2 * s1 * j) % P
    nz = (2 * h * z1 * z2) % P
    return (nx, ny, nz)


def _jac_mul(pt, scalar):
    result = None
    addend = pt
    while scalar:
        if scalar & 1:
            result = _jac_add(result, addend)
        addend = _jac_double(addend)
        scalar >>= 1
    return result


def _jac_to_affine(pt):
    if pt is None:
        return None
    x, y, z = pt
    zinv = _inv(z, P)
    zinv2 = (zinv * zinv) % P
    return ((x * zinv2) % P, (y * zinv2 * zinv) % P)


def pubkey_from_priv(scalar: int):
    """Returns (x, y) affine public key for the private key scalar."""
    return _jac_to_affine(_jac_mul((Gx, Gy, 1), scalar % N))


def compressed_pubkey_hex(priv_scalar: int) -> str:
    x, y = pubkey_from_priv(priv_scalar)
    prefix = "02" if y % 2 == 0 else "03"
    return prefix + format(x, "064x")


# --- RFC 6979 deterministic nonce (same algorithm real Bitcoin wallets use) ---

def _rfc6979_nonce(priv_scalar: int, msg_hash: bytes) -> int:
    def bits2int(b):
        v = int.from_bytes(b, "big")
        return v >> (max(0, len(b) * 8 - 256))

    h1 = msg_hash
    V = b"\x01" * 32
    K = b"\x00" * 32
    K = hmac.new(K, V + b"\x00" + format(priv_scalar, "064x").encode() + h1, hashlib.sha256).digest()
    V = hmac.new(K, V, hashlib.sha256).digest()
    K = hmac.new(K, V + b"\x01" + format(priv_scalar, "064x").encode() + h1, hashlib.sha256).digest()
    V = hmac.new(K, V, hashlib.sha256).digest()
    while True:
        V = hmac.new(K, V, hashlib.sha256).digest()
        k = bits2int(V)
        if 1 <= k < N:
            return k
        K = hmac.new(K, V + b"\x00", hashlib.sha256).digest()
        V = hmac.new(K, V, hashlib.sha256).digest()


def ecdsa_sign(priv_scalar: int, message_hash: bytes) -> str:
    """Returns signature as 128-char hex (r||s), 32 bytes each. Deterministic (RFC 6979)."""
    z = int.from_bytes(message_hash, "big")
    while True:
        k = _rfc6979_nonce(priv_scalar, message_hash)
        x, y = pubkey_from_priv(k)
        r = x % N
        if r == 0:
            continue
        s = (_inv(k, N) * (z + r * priv_scalar)) % N
        if s == 0:
            continue
        return format(r, "064x") + format(s, "064x")


def ecdsa_verify(pubkey_hex: str, message_hash: bytes, sig_hex: str) -> bool:
    """Verify an ECDSA signature against a compressed secp256k1 public key."""
    try:
        if len(pubkey_hex) != 66 or pubkey_hex[:2] not in ("02", "03") or len(sig_hex) != 128:
            return False
        x = int(pubkey_hex[2:66], 16)
        y_sq = (pow(x, 3, P) + 7) % P
        y = pow(y_sq, (P + 1) // 4, P)
        if pow(y, 2, P) != y_sq:
            return False
        if (y % 2) == (int(pubkey_hex[:2], 16) % 2):
            y_parity = y
        else:
            y_parity = P - y
        if y_parity % 2 != int(pubkey_hex[:2], 16) % 2:
            return False
        r = int(sig_hex[:64], 16)
        s = int(sig_hex[64:], 16)
        if not (1 <= r < N and 1 <= s < N):
            return False
        z = int.from_bytes(message_hash, "big")
        w = _inv(s, N)
        u1 = (z * w) % N
        u2 = (r * w) % N
        p1 = _jac_mul((Gx, Gy, 1), u1)
        p2 = _jac_mul((x, y_parity, 1), u2)
        point = _jac_to_affine(_jac_add(p1, p2))
        if point is None:
            return False
        return point[0] % N == r
    except (ValueError, ZeroDivisionError, TypeError):
        return False


# ------------------------------------------- Wallets / addresses / scripts ----

class Wallet:
    """A PATH wallet: real secp256k1 keypair + Bitcoin-style P2PKH address."""

    def __init__(self, name: str, private_key_hex: str):
        self.name = name
        self.priv = int(private_key_hex, 16)
        if not (1 <= self.priv < N):
            raise ValueError("private key out of range")
        self.public_key_hex = compressed_pubkey_hex(self.priv)
        self.address = self.address_from_pubkey(self.public_key_hex)

    @staticmethod
    def address_from_pubkey(pubkey_hex: str) -> str:
        # version byte 0x00 (Bitcoin mainnet style) + HASH160(pubkey) -> Base58Check
        return base58check_encode(b"\x00" + hash160(bytes.fromhex(pubkey_hex)))

    @staticmethod
    def generate(name: str) -> "Wallet":
        return Wallet(name, format(secrets.randbits(256) % N, "064x"))

    @property
    def private_key_hex(self) -> str:
        return format(self.priv, "064x")

    @property
    def wif(self) -> str:
        """Compressed-key WIF (Bitcoin wallet-import format), for educational display."""
        return base58check_encode(b"\x80" + bytes.fromhex(self.private_key_hex) + b"\x01")

    def signing_payload(self, tx: dict) -> dict:
        """Fields covered by the signature — everything except the signature itself and the txid."""
        return {k: v for k, v in tx.items()
                if k not in ("signature", "script_sig", "txid", "to_name")}

    def sign_transaction(self, tx: dict) -> dict:
        payload = canonical_json(self.signing_payload(tx)).encode("utf-8")
        tx["signature"] = ecdsa_sign(self.priv, sha256_bytes(payload))
        tx["script_sig"] = f"PUSHDATA({tx['signature']}) PUSHDATA({self.public_key_hex})"
        return tx

    def export(self) -> dict:
        return {
            "name": self.name,
            "address": self.address,
            "public_key_hex": self.public_key_hex,
            "private_key_hex": self.private_key_hex,
            "wif": self.wif,
        }


def verify_transaction(tx: dict) -> bool:
    """Verify a signed TRANSFER exactly like a miner would before including it."""
    if not isinstance(tx, dict) or tx.get("type") != "TRANSFER":
        return True  # system transactions (coinbase) verified by block rules
    pub = tx.get("public_key")
    sig = tx.get("signature")
    from_addr = tx.get("from_addr")
    if not pub or not sig or not from_addr:
        return False
    try:
        if Wallet.address_from_pubkey(pub) != from_addr:
            return False  # public key does not hash to the claimed sender address
        payload = canonical_json(
            {k: v for k, v in tx.items() if k not in ("signature", "script_sig", "txid", "to_name")}
        ).encode("utf-8")
        return ecdsa_verify(pub, sha256_bytes(payload), sig)
    except (ValueError, TypeError):
        return False


def signing_script(address: str) -> str:
    """Readable P2PKH locking script notation, computed from the address itself."""
    try:
        payload = base58check_decode(address)
        if len(payload) == 21 and payload[0] == 0x00:
            return f"OP_DUP OP_HASH160 {payload[1:].hex()} OP_EQUALVERIFY OP_CHECKSIG"
        return "OP_RETURN INVALID_ADDRESS"
    except (ValueError, IndexError):
        return "OP_RETURN INVALID_ADDRESS"
