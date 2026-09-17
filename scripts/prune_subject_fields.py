#!/usr/bin/env python3
"""Keep selected fields in JSONL subject objects; leave the source untouched."""

import argparse
import json


KEEP = {
    "age", "subject", "lighting_type", "camera_angle", "color_palette",
    "hair_length", "hair_color", "clothing", "skin_color", "eye_color",
    "sex", "expression", "pose",
}


def prune(subject):
    if subject is None:
        return None
    if not isinstance(subject, dict):
        raise ValueError("subject must be an object or an array of objects")
    return {key: value for key, value in subject.items() if key in KEEP}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", help="Source JSONL file")
    parser.add_argument("output", help="New output JSONL file (must not already exist)")
    args = parser.parse_args()
    rows = 0
    with open(args.input, encoding="utf-8") as source, open(
        args.output, "x", encoding="utf-8"
    ) as output:
        for line_number, line in enumerate(source, 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
                if not isinstance(row, dict):
                    raise ValueError("each JSONL row must be an object")
                if "subject" in row:
                    subject = row["subject"]
                    row["subject"] = (
                        [prune(item) for item in subject]
                        if isinstance(subject, list) else prune(subject)
                    )
                output.write(json.dumps(row, ensure_ascii=False) + "\n")
                rows += 1
            except ValueError as exc:
                raise SystemExit(
                    f"Line {line_number}: {exc}. Output is incomplete: {args.output}"
                ) from exc
    print(f"Wrote {rows} rows to {args.output}")


if __name__ == "__main__":
    main()
