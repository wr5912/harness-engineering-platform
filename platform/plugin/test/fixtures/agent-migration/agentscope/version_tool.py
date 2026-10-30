from packaging.version import Version


def select_newer_version(left: str, right: str) -> dict:
    a, b = Version(left), Version(right)
    return {"left": left, "right": right, "newer": left if a >= b else right}
