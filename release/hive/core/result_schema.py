"""Result schemas: the shape a goal's result must have before the goal can be done.

A goal can carry a `result_schema` (in its binding, or in its request's `constraints.result_schema`). Then a mind's
done result is checked *before* the goal becomes done: a result of the wrong shape is refused with a list of
problems the same mind can repair, and the goal stays claimed by it. Every attempt is kept verbatim.

The schema language is a strict subset of JSON Schema. Keywords outside the subset are refused when the schema is
set, never silently ignored, so a schema means exactly what it says:
  type (object | array | string | number | integer | boolean | null, or a list of them), enum, const,
  properties, required, additionalProperties (true/false), minProperties, maxProperties,
  items, minItems, maxItems, minLength, maxLength, pattern, minimum, maximum, description, title.
Passing a schema means the shape is right; it never means the content is true or accepted.
"""

from __future__ import annotations

import json
import re

MAX_SCHEMA_BYTES = 32 * 1024
MAX_ERRORS = 12
TYPES = {"object": dict, "array": list, "string": str, "boolean": bool, "null": type(None)}
KEYWORDS = {"type", "enum", "const", "properties", "required", "additionalProperties", "minProperties", "maxProperties",
            "items", "minItems", "maxItems", "minLength", "maxLength", "pattern", "minimum", "maximum", "description", "title"}


class SchemaError(ValueError):
    pass


def check_schema(schema, path="$"):
    """Refuse a schema that uses anything outside the subset (or is malformed)."""
    if path == "$" and len(json.dumps(schema)) > MAX_SCHEMA_BYTES:
        raise SchemaError(f"a result schema is at most {MAX_SCHEMA_BYTES // 1024} KB")
    if not isinstance(schema, dict):
        raise SchemaError(f"{path}: a schema is an object")
    unknown = set(schema) - KEYWORDS
    if unknown:
        raise SchemaError(f"{path}: unsupported keyword(s) {sorted(unknown)}; supported: {sorted(KEYWORDS)}")
    t = schema.get("type")
    for name in ([t] if isinstance(t, str) else t or []):
        if name not in TYPES and name not in ("number", "integer"):
            raise SchemaError(f"{path}: unknown type {name!r}")
    if "pattern" in schema:
        try:
            re.compile(schema["pattern"])
        except (re.error, TypeError) as exc:
            raise SchemaError(f"{path}: bad pattern ({exc})")
    for key in ("required",):
        if key in schema and not (isinstance(schema[key], list) and all(isinstance(k, str) for k in schema[key])):
            raise SchemaError(f"{path}: required is a list of names")
    if "additionalProperties" in schema and not isinstance(schema["additionalProperties"], bool):
        raise SchemaError(f"{path}: additionalProperties is true or false")
    for name, sub in (schema.get("properties") or {}).items():
        check_schema(sub, f"{path}.{name}")
    if "items" in schema:
        check_schema(schema["items"], f"{path}[]")
    return schema


def _is_type(value, name):
    if name == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if name == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    return isinstance(value, TYPES[name])


def validate(value, schema, path="$", errors=None):
    """A list of 'path: problem' strings (empty when the value fits)."""
    errors = [] if errors is None else errors
    if len(errors) >= MAX_ERRORS:
        return errors
    t = schema.get("type")
    if t is not None:
        names = [t] if isinstance(t, str) else list(t)
        if not any(_is_type(value, n) for n in names):
            errors.append(f"{path}: expected {' or '.join(names)}, got {type(value).__name__}")
            return errors
    if "const" in schema and value != schema["const"]:
        errors.append(f"{path}: must be exactly {json.dumps(schema['const'])}")
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{path}: must be one of {json.dumps(schema['enum'])[:200]}")
    if isinstance(value, str):
        if "minLength" in schema and len(value) < schema["minLength"]:
            errors.append(f"{path}: at least {schema['minLength']} characters (has {len(value)})")
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            errors.append(f"{path}: at most {schema['maxLength']} characters (has {len(value)})")
        if "pattern" in schema and not re.search(schema["pattern"], value):
            errors.append(f"{path}: must match {schema['pattern']}")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            errors.append(f"{path}: at least {schema['minimum']}")
        if "maximum" in schema and value > schema["maximum"]:
            errors.append(f"{path}: at most {schema['maximum']}")
    if isinstance(value, list):
        if "minItems" in schema and len(value) < schema["minItems"]:
            errors.append(f"{path}: at least {schema['minItems']} items (has {len(value)})")
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            errors.append(f"{path}: at most {schema['maxItems']} items (has {len(value)})")
        if "items" in schema:
            for i, item in enumerate(value):
                validate(item, schema["items"], f"{path}[{i}]", errors)
    if isinstance(value, dict):
        props = schema.get("properties") or {}
        for name in schema.get("required") or []:
            if name not in value:
                errors.append(f"{path}: missing required field {name!r}")
        if schema.get("additionalProperties") is False:
            extra = sorted(set(value) - set(props))
            if extra:
                errors.append(f"{path}: unexpected field(s) {extra}; allowed: {sorted(props)}")
        if "minProperties" in schema and len(value) < schema["minProperties"]:
            errors.append(f"{path}: at least {schema['minProperties']} fields")
        if "maxProperties" in schema and len(value) > schema["maxProperties"]:
            errors.append(f"{path}: at most {schema['maxProperties']} fields")
        for name, sub in props.items():
            if name in value:
                validate(value[name], sub, f"{path}.{name}", errors)
    return errors[:MAX_ERRORS]
