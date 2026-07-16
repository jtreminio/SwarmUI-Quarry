"""Argparse command tree and dispatch for the Quarry dataset-prep CLI.

Building the tree stays cheap: the command modules import only stdlib + common at
module scope, so the heavy libraries (duckdb / lance / pyarrow / huggingface_hub /
visidata) are pulled in only once a command that needs them actually runs.
"""

from __future__ import annotations

import argparse

from . import browse, columns, convert, hf, lance, text


def _add_group(subparsers, name: str, help: str, module) -> None:
    """Register a command group whose own subparsers are filled by ``module``."""
    group = subparsers.add_parser(name, help=help)
    group.set_defaults(_help_parser=group)
    group_sub = group.add_subparsers(dest="subcommand", metavar="<subcommand>")
    module.register(group_sub)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="quarry",
        description=(
            "Quarry dataset-prep CLI: prepare Parquet/CSV/JSONL/Lance datasets for "
            "the SwarmUI-Quarry extension."
        ),
    )
    sub = parser.add_subparsers(dest="command", metavar="<command>")

    _add_group(sub, "columns", "inspect and reshape a file's columns", columns)
    _add_group(sub, "convert", "change a dataset's on-disk representation", convert)
    _add_group(sub, "lance", "create and prep standalone Lance datasets", lance)
    _add_group(sub, "hf", "fetch datasets from the Hugging Face Hub", hf)
    _add_group(sub, "text", "plain-text edits", text)
    browse.register(sub)  # a top-level command, not a group

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    func = getattr(args, "func", None)
    if func is None:
        # Bare `quarry` (or a bare group like `quarry columns`): same as --help.
        getattr(args, "_help_parser", parser).print_help()
        return 0
    return func(args)
