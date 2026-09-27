"""The six languages (Iñaki, 2026-09-27): es, en, fr, it, de, pt - the same set the iOS and
Android apps already ship, fallback English. Before this change the integration/card spoke a
different nine-language set (es, en, fr, de, pt, zh-Hans, ru, hi, ar) with no Italian - now every
client agrees.

This has to be checked in THREE independent places that must never drift apart again:
  - custom_components/ig_doorbell/translations/*.json (the config-flow strings HA loads)
  - the three JS dictionaries inside frontend/ig-doorbell-card.js (igLocales, IG_EV_TEXT,
    IG_HTTPS_TEXT - the card's own runtime i18n, not read from translations/)
  - the T dictionary inside frontend/https-install.html (a plain page HA serves, no relation to
    the two above)

A JS object literal is parsed with a real regex-based extractor further down, NOT by asking Node
to `eval()` it: a first version of this test shelled out to Node, and that broke the moment a
single apostrophe inside a single-quoted string anywhere else in the 7000-line card file threw
the naive string-stripping off by thousands of characters - a wrong "10-character language
block" that no human would believe if they saw it directly. The extractor below tracks JS string
literals character-by-character (respecting escapes) instead of a global regex, which is what a
sentence like "...set it up once:'," (a colon INSIDE running prose, immediately followed by the
string's own closing quote) needs to not be mistaken for the start of the next key.

Per the project's own rule on instruments (CLAUDE.md, "Cómo auditar las rutas HTTP..."): a checker
without a negative control is not a measurement. test_the_extractor_itself_catches_a_dropped_
language and test_the_extractor_itself_catches_a_missing_key run the extractor against small
synthetic literals with a language deliberately removed / a key deliberately dropped, so a
checker that always said "OK" would be caught here before it could rubber-stamp the real files.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

EXPECTED_LANGUAGES = {"es", "en", "fr", "it", "de", "pt"}

TRANSLATIONS_DIR = (
    Path(__file__).parent.parent
    / "custom_components"
    / "ig_doorbell"
    / "translations"
)
CARD_JS = (
    Path(__file__).parent.parent
    / "custom_components"
    / "ig_doorbell"
    / "frontend"
    / "ig-doorbell-card.js"
)
INSTALL_HTML = (
    Path(__file__).parent.parent
    / "custom_components"
    / "ig_doorbell"
    / "frontend"
    / "https-install.html"
)


# ---------------------------------------------------------------------------
# translations/*.json (config-flow strings)
# ---------------------------------------------------------------------------


def _json_key_paths(value, prefix: str = "") -> set[str]:
    paths: set[str] = set()
    if isinstance(value, dict):
        for k, v in value.items():
            here = f"{prefix}.{k}" if prefix else k
            paths.add(here)
            paths |= _json_key_paths(v, here)
    return paths


def test_translations_directory_has_exactly_the_six_languages():
    found = {p.stem for p in TRANSLATIONS_DIR.glob("*.json")}
    assert found == EXPECTED_LANGUAGES, (
        f"translations/ has {found}, expected exactly {EXPECTED_LANGUAGES} "
        f"(missing={EXPECTED_LANGUAGES - found}, extra={found - EXPECTED_LANGUAGES})"
    )


def test_italian_translation_is_a_complete_translation_of_english():
    en = json.loads((TRANSLATIONS_DIR / "en.json").read_text(encoding="utf-8"))
    it = json.loads((TRANSLATIONS_DIR / "it.json").read_text(encoding="utf-8"))
    en_keys, it_keys = _json_key_paths(en), _json_key_paths(it)
    assert en_keys == it_keys, (
        f"it.json is not a full match of en.json's keys: "
        f"missing={en_keys - it_keys}, extra={it_keys - en_keys}"
    )


def test_no_translation_file_has_keys_english_does_not_have():
    # es/fr/de/pt only translate a subset of en.json by design (config-flow strings fall back to
    # English) - that's fine. What would NOT be fine is a stray or renamed key nothing reads.
    en_keys = _json_key_paths(json.loads((TRANSLATIONS_DIR / "en.json").read_text(encoding="utf-8")))
    for path in TRANSLATIONS_DIR.glob("*.json"):
        if path.stem == "en":
            continue
        keys = _json_key_paths(json.loads(path.read_text(encoding="utf-8")))
        extra = keys - en_keys
        assert not extra, f"{path.name} has keys not present in en.json: {extra}"


# ---------------------------------------------------------------------------
# A string/bracket-aware extractor for the JS object literals below. See the module docstring for
# why this doesn't just regex the whole blob or shell out to `node --eval`.
# ---------------------------------------------------------------------------

_KEY_RE = re.compile(r"([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(?=[{\[\"'])")


def _blank_out_strings(text: str) -> str:
    """Keep the quotes and structural characters, replace everything ELSE inside a string or a
    `//` comment with filler of the SAME LENGTH - so a colon INSIDE a sentence can never be
    mistaken for the start of the next `key:`, and a brace/bracket INSIDE a sentence can never
    confuse depth tracking either. Length-preserving on purpose: every index found in the
    blanked text is later used to slice the ORIGINAL text.

    This is a single left-to-right PASS WITH STATE (in-string or not, and which quote opened it),
    not independent regex matches. That distinction is the whole reason this exists: a first
    version used `'...'|"..."` with `re.finditer`, which finds a quote-delimited span starting
    at ANY position regardless of context. On this file that means the apostrophe in "Home
    Assistant can't reach the doorbell..." (a DOUBLE-quoted string) reads as the OPENING of a
    single-quoted string, and the regex then happily matches 8500+ characters forward to the
    next unescaped `'` it can find - miles past the table being parsed. A stateful scanner never
    makes that mistake: while already inside a `"..."` string, a `'` is just a character, exactly
    like a real JS tokenizer would see it.
    """
    out = list(text)
    i, n = 0, len(text)
    in_string: str | None = None  # the quote character that opened the current string, or None
    while i < n:
        c = text[i]
        if in_string:
            if c == "\\" and i + 1 < n:
                out[i] = "_"
                out[i + 1] = "_"
                i += 2
                continue
            if c == in_string:
                in_string = None
                i += 1
                continue
            out[i] = "_"
            i += 1
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "/":
            j = text.find("\n", i)
            j = n if j == -1 else j
            for k in range(i, j):
                out[k] = "_"
            i = j
            continue
        if c in ("'", '"'):
            in_string = c
            i += 1
            continue
        i += 1
    return "".join(out)


def _matching_close_brace(skeleton: str, open_idx: int) -> int:
    depth = 0
    for j in range(open_idx, len(skeleton)):
        if skeleton[j] == "{":
            depth += 1
        elif skeleton[j] == "}":
            depth -= 1
            if depth == 0:
                return j
    raise ValueError("unbalanced braces")


def top_level_object_entries(obj_literal: str) -> list[tuple[str, str]]:
    """`obj_literal` is `{ key: value, key: value, ... }` (outer braces included). Returns
    [(key, value_text), ...] for keys directly inside it - not one level deeper, so a nested
    array like `ios_steps: [...]` is returned whole and never mistaken for extra keys."""
    inner = obj_literal[1:-1]
    skeleton = _blank_out_strings(inner)
    entries: list[tuple[str, str]] = []
    i, n = 0, len(skeleton)
    while i < n:
        m = _KEY_RE.match(skeleton, i)
        if not m:
            i += 1
            continue
        key = m.group(1)
        val_start = m.end()
        depth = 0
        j = val_start
        while j < n:
            c = skeleton[j]
            if c in "{[":
                depth += 1
            elif c in "}]":
                depth -= 1
            elif c == "," and depth == 0:
                break
            j += 1
        entries.append((key, inner[val_start:j].strip()))
        i = j + 1
    return entries


def extract_language_table(src: str, const_name: str) -> dict[str, set[str]]:
    """Returns {lang_code: {key, key, ...}} for `const <const_name> = { lang: { key: val, ... },
    ... };` exactly as it appears in the source (JS file, or the <script> block of an HTML page)."""
    start_tok = f"const {const_name} = {{"
    start = src.index(start_tok)
    open_idx = start + len(start_tok) - 1
    # Blank strings starting FRESH at open_idx, not from the top of the file: a real JS engine
    # has no leftover string/comment state to carry into a `const X = {` it hasn't reached yet,
    # but this scanner does not understand every JS construct (regex literals, template strings)
    # that can appear earlier in a 7000-line file and legitimately close a quote our simpler
    # model thinks is still open. Scoping to `src[open_idx:]` sidesteps that instead of trying to
    # make the scanner understand all of JS - it only has to be correct about what's INSIDE the
    # table, which is plain quoted strings and `//` comments.
    tail_skeleton = _blank_out_strings(src[open_idx:])
    close_idx = open_idx + _matching_close_brace(tail_skeleton, 0)
    literal = src[open_idx : close_idx + 1]
    table: dict[str, set[str]] = {}
    for lang, body in top_level_object_entries(literal):
        assert body.startswith("{") and body.endswith("}"), (
            f"{const_name}.{lang}: expected a `{{...}}` block, got {body[:40]!r}"
        )
        table[lang] = {k for k, _ in top_level_object_entries(body)}
    return table


def _assert_exactly_six_languages_with_full_parity(table: dict[str, set[str]], where: str) -> None:
    langs = set(table)
    assert langs == EXPECTED_LANGUAGES, (
        f"{where}: languages are {sorted(langs)}, expected exactly {sorted(EXPECTED_LANGUAGES)} "
        f"(missing={EXPECTED_LANGUAGES - langs}, extra={langs - EXPECTED_LANGUAGES})"
    )
    en_keys = table["en"]
    for lang, keys in table.items():
        missing = en_keys - keys
        extra = keys - en_keys
        assert not missing and not extra, (
            f"{where}.{lang}: missing={missing}, extra={extra} (relative to .en)"
        )


# ---------------------------------------------------------------------------
# Negative/positive controls on the extractor ITSELF, before trusting it on the real files.
# ---------------------------------------------------------------------------


def test_the_extractor_itself_catches_a_dropped_language():
    fixture = """
const FIXTURE = {
  en: { a: "x", b: "y" },
  es: { a: "x", b: "y" },
};
"""
    table = extract_language_table(fixture, "FIXTURE")
    try:
        _assert_exactly_six_languages_with_full_parity(table, "fixture")
    except AssertionError as e:
        assert "missing=" in str(e) or "extra=" in str(e)
    else:
        raise AssertionError("the checker passed a table missing 4 of the 6 required languages")


def test_the_extractor_itself_catches_a_dropped_key():
    fixture = """
const FIXTURE = {
  en: { a: "x", b: "y" },
  es: { a: "x", b: "y" },
  fr: { a: "x", b: "y" },
  it: { a: "x" },
  de: { a: "x", b: "y" },
  pt: { a: "x", b: "y" },
};
"""
    table = extract_language_table(fixture, "FIXTURE")
    try:
        _assert_exactly_six_languages_with_full_parity(table, "fixture")
    except AssertionError as e:
        assert "it" in str(e) and "missing=" in str(e)
    else:
        raise AssertionError("the checker passed 'it' silently missing key 'b'")


def test_the_extractor_itself_accepts_a_correct_table():
    fixture = """
const FIXTURE = {
  en: { a: "x", b: 'contains a colon: right here', c: ["step one:", "step two"] },
  es: { a: "x", b: "y", c: ["1", "2"] },
  fr: { a: "x", b: "y", c: ["1", "2"] },
  it: { a: "x", b: "y", c: ["1", "2"] },
  de: { a: "x", b: "y", c: ["1", "2"] },
  pt: { a: "x", b: "y", c: ["1", "2"] },
};
"""
    table = extract_language_table(fixture, "FIXTURE")
    _assert_exactly_six_languages_with_full_parity(table, "fixture")  # must not raise


# ---------------------------------------------------------------------------
# The real files.
# ---------------------------------------------------------------------------


def test_card_js_igLocales_table_has_exactly_the_six_languages():
    src = CARD_JS.read_text(encoding="utf-8")
    table = extract_language_table(src, "igLocales")
    _assert_exactly_six_languages_with_full_parity(table, "ig-doorbell-card.js igLocales")


def test_card_js_notice_bell_table_has_exactly_the_six_languages():
    src = CARD_JS.read_text(encoding="utf-8")
    table = extract_language_table(src, "IG_EV_TEXT")
    _assert_exactly_six_languages_with_full_parity(table, "ig-doorbell-card.js IG_EV_TEXT")


def test_card_js_https_notice_table_has_exactly_the_six_languages():
    src = CARD_JS.read_text(encoding="utf-8")
    table = extract_language_table(src, "IG_HTTPS_TEXT")
    _assert_exactly_six_languages_with_full_parity(table, "ig-doorbell-card.js IG_HTTPS_TEXT")


def test_install_page_table_has_exactly_the_six_languages():
    html = INSTALL_HTML.read_text(encoding="utf-8")
    m = re.search(r"<script[^>]*>([\s\S]*?)</script>", html)
    assert m, "https-install.html has no <script> block to check"
    table = extract_language_table(m.group(1), "T")
    _assert_exactly_six_languages_with_full_parity(table, "https-install.html T")


def test_install_page_has_no_leftover_rtl_switch_for_a_removed_language():
    # Arabic was the only RTL language in the old nine-language set; removing it without touching
    # this line would leave a dead (harmless, but misleading) `lang === 'ar'` check behind.
    html = INSTALL_HTML.read_text(encoding="utf-8")
    assert "=== 'ar'" not in html
    assert "documentElement.dir" in html  # the line itself must still be there, just simplified
