#!/usr/bin/env python3
"""Stand-in for the `claude` CLI used by the e2e test.

Fires the hooks from .claude/settings.local.json like Claude Code would, writes a
Claude-Code-shaped JSONL transcript, and for every line typed appends it to
agent.txt (simulating a Write tool call), then "stops".
"""
import datetime, json, os, subprocess, sys, tempfile, uuid

SID = os.environ.get("FAKE_SESSION_ID") or str(uuid.uuid4())
args = sys.argv[1:]
if "--resume" in args:
    SID = args[args.index("--resume") + 1]

TDIR = os.path.join(tempfile.gettempdir(), "fake-claude-transcripts")
os.makedirs(TDIR, exist_ok=True)
TRANSCRIPT = os.path.join(TDIR, SID + ".jsonl")
USED = [12000]

def now():
    return datetime.datetime.utcnow().isoformat() + "Z"

def record(obj):
    obj.setdefault("uuid", str(uuid.uuid4()))
    obj.setdefault("timestamp", now())
    obj.setdefault("sessionId", SID)
    with open(TRANSCRIPT, "a") as f:
        f.write(json.dumps(obj, ensure_ascii=False) + "\n")

def assistant(content):
    USED[0] += 1500
    record({"type": "assistant", "message": {"role": "assistant", "model": "claude-opus-4-5", "content": content,
            "usage": {"input_tokens": 10, "cache_creation_input_tokens": 0, "cache_read_input_tokens": USED[0], "output_tokens": 200}}})

def hook(event, extra=None):
    try:
        settings = json.load(open(".claude/settings.local.json"))
    except Exception:
        return
    for entry in settings.get("hooks", {}).get(event, []):
        for h in entry.get("hooks", []):
            payload = {"session_id": SID, "transcript_path": TRANSCRIPT, "hook_event_name": event, "cwd": os.getcwd()}
            payload.update(extra or {})
            subprocess.run(h["command"], shell=True, input=json.dumps(payload).encode())

def work(text):
    if "echo vatra-ok > hello.txt" in text:
        hook("UserPromptSubmit", {"prompt": text})
        record({"type": "user", "message": {"role": "user", "content": text}})
        tool_input = {"command": "echo vatra-ok > hello.txt"}
        hook("PreToolUse", {"tool_name": "Bash", "tool_input": tool_input})
        hook("Notification", {"message": "Claude needs your permission to use Bash", "notification_type": "permission_prompt"})
        if sys.stdin.readline().strip():
            return
        with open("hello.txt", "w") as f:
            f.write("vatra-ok\n")
        hook("PostToolUse", {"tool_name": "Bash", "tool_input": tool_input})
        assistant([{"type": "text", "text": "done"}])
        hook("Stop")
        return
    if text.startswith("/"):
        name = text.split()[0]
        rest = text[len(name):].strip()
        record({"type": "user", "message": {"role": "user", "content":
                f"<command-name>{name}</command-name>\n<command-message>{name[1:]}</command-message>\n<command-args>{rest}</command-args>"}})
        record({"type": "system", "subtype": "local_command", "content": f"<local-command-stdout>ran {name}</local-command-stdout>"})
        print(f"[fake-claude] command {name}", flush=True)
        return
    hook("UserPromptSubmit", {"prompt": text})
    record({"type": "user", "message": {"role": "user", "content": text}})
    tool_id = "toolu_" + uuid.uuid4().hex[:12]
    tool_input = {"file_path": os.path.join(os.getcwd(), "agent.txt"), "content": text}
    hook("PreToolUse", {"tool_name": "Write", "tool_input": tool_input})
    if "ask-permission" in text:
        hook("Notification", {"message": "Claude needs your permission to use Write", "notification_type": "permission_prompt"})
        print("[fake-claude] waiting for permission (Enter = yes)", flush=True)
        answer = sys.stdin.readline().strip()
        if answer:
            print("[fake-claude] denied", flush=True)
            return
        print("[fake-claude] approved", flush=True)
    assistant([{"type": "text", "text": f"Записую «{text}» у agent.txt"},
               {"type": "tool_use", "id": tool_id, "name": "Write", "input": tool_input}])
    with open("agent.txt", "a") as f:
        f.write(text + "\n")
    record({"type": "user", "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": tool_id, "content": "File written successfully"}]}})
    hook("PostToolUse", {"tool_name": "Write", "tool_input": tool_input})
    assistant([{"type": "text", "text": f"**Готово.** Додав рядок `{text}`."}])
    print(f"[fake-claude] wrote: {text}", flush=True)
    hook("Stop")

print(f"[fake-claude] session {SID} args={args!r} PORT={os.environ.get('PORT')} API_KEY={'set' if os.environ.get('ANTHROPIC_API_KEY') else 'unset'}", flush=True)
print("MODE=RESUMED" if "--resume" in args else "MODE=FRESH", flush=True)
if any(("trust-me" in a or "automated check of the Vatra" in a) for a in args) and "--resume" not in args:
    print("Do you trust the files in this folder?  1. Yes, proceed  2. No, exit", flush=True)
    if sys.stdin.readline().strip():
        sys.exit(1)
    print("[fake-claude] trusted", flush=True)
hook("SessionStart", {"source": "resume" if "--resume" in args else "startup"})
# real claude takes a moment between SessionStart and the first prompt; keep that gap
# so tests can't pass by racing it (CI on macOS is slower than a dev box)
import time
time.sleep(0.4)
positional = [a for i, a in enumerate(args) if not a.startswith("--") and (i == 0 or args[i - 1] != "--resume")]
if positional:
    work(positional[-1])
# like the real TUI, ask the terminal for bracketed paste so multi-line pastes arrive as one message
sys.stdout.write("\x1b[?2004h"); sys.stdout.flush()
paste = None
for line in sys.stdin:
    line = line.rstrip("\n")
    if "\x1b[200~" in line:
        paste = []
        line = line.split("\x1b[200~", 1)[1]
    if paste is not None:
        if "\x1b[201~" in line:
            paste.append(line.split("\x1b[201~", 1)[0])
            text = "\n".join(paste).strip()
            paste = None
            # the Enter that submits comes right after the paste
            if text:
                work(text)
        else:
            paste.append(line)
        continue
    line = line.strip()
    if line == "exit":
        break
    if line:
        work(line)
hook("SessionEnd")
sys.exit(0)
