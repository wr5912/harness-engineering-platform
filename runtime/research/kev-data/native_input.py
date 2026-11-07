"""Pinned Kev rendering identities, without tokenizer or model dependencies.

Rendering semantics follow jaredpalmer/kev ``kev/api.py`` at commit
2074cc44256200bb37540103fa4572901faa10f3 (Apache-2.0; license copy in
upstream/LICENSE). The rendering helpers below are adapted from that
source; the grouping and integrity hashes are additions for this data pipeline.

JSON canonicalization alone misses model-visible collisions: an object and a
string may render to the same text. Keep existing provenance/canonical grouping
and add these identities. Do not use the hashes as token counts or proof of
semantic equivalence. Object insertion order is significant to Kev rendering.
"""
from __future__ import annotations

import hashlib
import json


KEV_COMMIT = "2074cc44256200bb37540103fa4572901faa10f3"
IDENTITY_VERSION = "kev-rendered-input/v1"


def render(value, indent=0):
    """Match the pinned native renderer for already validated JSON values."""
    pad = "  " * indent
    if value is None:
        return ""
    if isinstance(value, (str, int, float, bool)):
        return str(value)
    if isinstance(value, list):
        return "\n".join(f"{pad}- {render(item, indent + 1).lstrip()}" for item in value)
    if not isinstance(value, dict):
        raise TypeError("state or question content must be JSON")
    return "\n".join(
        f"{pad}{key}:\n{render(item, indent + 1)}" if isinstance(item, (dict, list))
        else f"{pad}{key}: {render(item)}"
        for key, item in value.items()
    )


def option_text(name, description):
    return name if description is None or description == "" else f"{name}: {render(description)}"


def _digest(value):
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def state_key(state):
    """Group states which the pinned native API renders identically."""
    return _digest(render(state))


def _question_form(question, *, canonical_choices):
    kind, criteria = question.get("type"), question.get("criteria")
    if kind == "choice":
        if not isinstance(criteria, dict) or not criteria:
            raise ValueError("choice criteria must be a non-empty object")
        pairs = list(criteria.items())
        if canonical_choices:
            pairs.sort(key=lambda item: item[0])
        options = [(name, option_text(name, description)) for name, description in pairs]
    elif kind == "noul":
        if criteria is not None and not isinstance(criteria, dict):
            raise ValueError("noul criteria must be an object or null")
        criteria = criteria or {}
        options = [("false", option_text("no", criteria.get("false"))),
                   ("true", option_text("yes", criteria.get("true")))]
    elif kind == "score":
        if not isinstance(criteria, list) or not criteria:
            raise ValueError("score criteria must be a non-empty list")
        options = [(str(index), render(value)) for index, value in enumerate(criteria)]
    else:
        raise ValueError("unsupported native question type")
    # Keys are retained so labels remain names, not indices. Choice order alone
    # cannot manufacture independent data; score level order is never sorted.
    return {"type": kind, "instructions": render(question.get("instructions")), "options": options}


def question_key(state, question):
    """Rendered task identity; choice permutation is one conservative group."""
    return _digest({"state": render(state), "question": _question_form(question, canonical_choices=True)})


def record_key(record):
    """Integrity identity preserving the actual question and option order.

    Labels, target distributions, qids and metadata are not model input. Their
    own validation remains the caller's responsibility.
    """
    return _digest({"state": render(record["state"]), "questions": [
        _question_form(question, canonical_choices=False) for question in record["questions"].values()
    ]})
