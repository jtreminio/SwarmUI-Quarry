"""`quarry text` subcommands: plain-text edits.

delete-string -- carried over from delete_string.py. Pure stdlib; no heavy imports.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from .common import atomic_output

_DELETE_STRING_DESC = """\
Delete every occurrence of a string from a text file, overwriting in place.

Reads the target file, removes all (non-overlapping) occurrences of the given
string, and writes the result back to the same file. The substring is matched
literally -- no regular-expression or glob interpretation -- so characters like
'.', '*' or '(' mean themselves.

The new content is written to a temp file in the destination directory first, then
atomically moved into place, so a failure mid-write can't corrupt the target (or an
existing --output file).

By default the file is read and written as UTF-8 text. Pass --encoding to use a
different codec. Deleting an empty string is refused.

Usage:
    quarry text delete-string <file> <string>
    quarry text delete-string notes.txt "TODO: "
    quarry text delete-string config.ini "secret_key" -o config.clean.ini
    quarry text delete-string data.txt $'\\r'          # strip carriage returns
    quarry text delete-string page.html "<script>" --count
"""


def cmd_delete_string(args) -> int:
    if args.string == "":
        raise SystemExit("error: refusing to delete an empty string (no-op)")

    path = Path(args.file)
    if not path.is_file():
        raise SystemExit(f"error: no such file: {path}")

    dest = Path(args.output) if args.output else path

    try:
        text = path.read_text(encoding=args.encoding)
    except UnicodeDecodeError as exc:
        raise SystemExit(
            f"error: cannot decode {path} as {args.encoding} ({exc}); "
            f"pass --encoding for the right codec"
        )

    occurrences = text.count(args.string)
    new_text = text.replace(args.string, "")

    with atomic_output(dest) as tmp_path:
        with tmp_path.open("w", encoding=args.encoding, newline="") as fh:
            fh.write(new_text)

    detail = f" ({occurrences} occurrence(s))" if args.count else ""
    print(f"Removed {args.string!r}{detail} from {path} -> {dest}")
    return 0


def register(subparsers) -> None:
    p = subparsers.add_parser(
        "delete-string",
        help="delete every occurrence of a literal string from a text file",
        description=_DELETE_STRING_DESC,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("file", help="the text file to edit")
    p.add_argument("string", help="the literal substring to remove (matched as-is)")
    p.add_argument(
        "-o", "--output", default=None,
        help="write the result here instead of overwriting the file in place",
    )
    p.add_argument(
        "--encoding", default="utf-8",
        help="text encoding used to read and write the file (default: utf-8)",
    )
    p.add_argument(
        "--count", action="store_true",
        help="report how many occurrences were removed",
    )
    p.set_defaults(func=cmd_delete_string)
