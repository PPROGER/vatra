#!/usr/bin/env python3
"""Minimal stand-in for the GitHub CLI used by the e2e test."""
import os, sys
state_file = os.environ["FAKE_GH_STATE"]
args = sys.argv[1:]
if args[:1] == ["--version"]:
    print("gh version 2.0.0 (fake)"); sys.exit(0)
if args[:2] == ["pr", "create"]:
    if os.path.exists(state_file) and open(state_file).read().strip() == "OPEN":
        print("a pull request for branch already exists", file=sys.stderr); sys.exit(1)
    open(state_file, "w").write("OPEN")
    print("https://github.com/acme/demo/pull/7")
elif args[:2] == ["pr", "view"]:
    if "url" in args[args.index("--json") + 1]:
        print("https://github.com/acme/demo/pull/7")
    else:
        print(open(state_file).read().strip())
else:
    print("unsupported", args, file=sys.stderr); sys.exit(2)
