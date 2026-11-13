# Servers

Cavvy can run on another machine and be used from this one: a VPS, a build box, anything running Linux that you reach with `ssh`. The sessions, the agent CLIs, the files and the commands are all on the server, and they keep going when your laptop sleeps or the connection drops.

```bash
cavvy servers add box me@box.example     # connect, put Cavvy there, start it
cavvy --server box                       # the terminal app, running on the server
cavvy --server box:~/code/app -c         # in a folder there; the rest of the line is passed on
cavvy gui --server box                   # the server's GUI, in your browser
```

`--port` and `--identity <file>` say how to connect when that isn't in your SSH config. Everything else in `~/.ssh/config` applies (a `Host` alias, `ProxyJump`, your agent): Cavvy runs the system's `ssh`.

A server needs Linux on x64 or arm64 with glibc (so not Alpine), about 400 MB of disk, and nothing installed beforehand. Your login shell there has to be sh, bash, zsh, dash or ksh (not csh or tcsh). Only put credentials on a server that you'd accept an agent using: agents there run as the user you signed in as, so they can read what that user can.

## Adding a server

`cavvy servers add` connects, checks the machine can run Cavvy, copies this machine's build of Cavvy to it, and starts it. Then it says what the server is missing for agents to use: an agent CLI (Claude Code, Codex), `git`, the GitHub CLI, a Chrome for the Browser tool. Install and sign in to those on the server as you would anywhere, for example from `cavvy --server box` or a plain `ssh`. API keys for the server are added there too (`cavvy --server box auth add`, or Settings in its GUI) and are kept in a file only your user there can read.

You're offered a one-time copy of this machine's settings, memory, skills and commands (`--copy` or `--no-copy` to answer ahead). Nothing already on the server is replaced, and Cavvy says what the server took.

Never copied: keys and sign-ins, hooks and the status line (they're commands, and would run there), and the permission mode. Permission rules and MCP servers can have a key written into them anywhere (an address's path, an option's value), so they go only when every word in them reads as a name: a rule of plain words with no options in it (`Bash(npm run lint:*)`), and an MCP server that's just a package to run (`npx -y @scope/server`) or a public address with a plain path. A long run of letters and digits, or groups of them, reads as a key and stays. A password that's an ordinary word can't be told from a command's own words, so look through your rules for one before you copy. The rest stay, and Cavvy says how many; add those on the server yourself (`cavvy --server box mcp add …`). A memory, skill or command file is left out when it's named like a key file or has a key of a known format in it.

What can go wrong, and what you see:

| | |
|---|---|
| The server doesn't answer | `Can't reach <host>.`, with ssh's own line. Nothing is added. |
| It refuses your key | `<host> refused this key.` |
| Your key needs its passphrase, and no agent holds it | `This key needs its passphrase. Add it to ssh-agent, then retry.`, with the `ssh-add` command. Cavvy never asks for a passphrase or a password. |
| First connection | Its key's fingerprint, and `Trust <host>?`. Only the key you were shown is saved: to your `known_hosts`, or to Cavvy's own list when your SSH config keeps no keys for that host. Without a terminal to ask at, nothing is trusted. |
| Its key changed | `<host>'s identity changed.`, with the `ssh-keygen -R` command that removes the old one. Cavvy never accepts a changed key itself. |
| It can't run Cavvy | `Cavvy can't run on <host>:` and why (not Linux, the processor, musl, no room). |
| The copy arrived changed, or doesn't start there | It says so, and nothing is installed. |

## Working there

`cavvy --server <name>[:<folder>]` runs the terminal app on the server over SSH, in that folder (your home there without one). Everything after it goes to that Cavvy: `-c`, `-r <id>`, `-p "…"`, `auth add`. If the connection drops, that terminal app ends with it, and Cavvy says `Connection to <name> lost.` and how to continue the session (`-c`); the session is saved as it goes. A server can take a long while to notice a connection that went without a word (a laptop closing), and the terminal app there runs on meanwhile: the next `cavvy --server` to that server from this machine ends it first, so the session can be continued.

`cavvy gui --server <name>` opens the server's GUI in your browser through an SSH tunnel, and stays running to keep the tunnel up. Ctrl+C disconnects and signs the page out; work on the server keeps running, and connecting again shows it where it is, with any question it's waiting on. If the connection drops, the tunnel comes back by itself (`Connection to <name> lost. Reconnecting…`), at the same address, and prints a new sign-in link in case the page asks for one. A failure that needs you (your key refused, the server's key changed) is said once and not retried.

A `LocalForward` in your SSH config for that host is opened along with Cavvy's own tunnel; if its port is taken, the connection fails.

Sessions on a server are its own: its folders, its `~/.cavvy`, its settings and memory. The GUI's server there is the same one the desktop app runs locally, so sub-agents, other sessions, schedules, pull request watching and worktrees work as they do here, with the server's tools and sign-ins.

## Keeping it running, and updating

Where the server has systemd, Cavvy runs as a user service: started at boot, restarted if it crashes. That needs "lingering" for your user, which Cavvy turns on itself; where the server refuses, Cavvy still runs but won't come back after a reboot, and `cavvy servers check` gives the command an administrator runs to fix that (`sudo loginctl enable-linger <user>`).

```bash
cavvy servers                 # the servers you've added
cavvy servers check [name]    # is Cavvy running there, and what's missing
cavvy servers update <name>   # bring its Cavvy up to this machine's
cavvy servers stop <name>     # stop Cavvy there
cavvy servers remove <name>   # forget it here, and sign this machine out of it
```

A server runs the build of Cavvy that the machine setting it up runs, made from the checkout that machine's Cavvy came from. `update` restarts Cavvy there, which ends turns in flight and drops questions waiting for an answer, so it asks first when sessions are working (`Stop work on <name> to update?`). The new build is tried before the old one is given up: if it doesn't start, the build before it is put back and started. A server on a newer build than this machine's is left alone, so two machines that share a server don't each put their own version back; `--force` replaces it anyway.

`stop` waits until Cavvy there has closed its sessions and gone, and it stays stopped: a connection that was open says `Cavvy on <name> was stopped.` and doesn't start it again by reconnecting. Connecting again (`cavvy gui --server`, `cavvy servers update`) starts it.

`remove` doesn't stop Cavvy on the server or delete anything there. The line it prints puts the server back.

## How a machine signs in

- Cavvy on a server listens on the server's loopback address only. Nothing is opened to the network, and no port needs opening in a firewall beyond SSH.
- One Cavvy runs per user on a server, however many machines connect. A machine quitting or disconnecting doesn't stop it.
- To connect, a machine runs a command on the server over SSH that makes a one-time code (good for two minutes), opens an SSH tunnel to Cavvy's port, and trades the code through the tunnel for a token of its own. Tokens are kept in the server's memory, make new connections for twelve hours, and are gone when Cavvy there restarts: a machine signs in again over SSH each time it connects. Nothing stored on your machine signs it in; your SSH key is what does.
- `cavvy gui --server` signs out what it signed in when it ends (Ctrl+C, or its terminal closing), if the server can be reached then. `cavvy servers remove` signs the whole machine out: its open connections close and its tokens stop working.
- Agents on a server are the same user as Cavvy there, so file permissions don't keep them out of its folder. Cavvy's permission checker treats the server's own folder (`~/.cavvy/server`) as it does its credential files: the file tools are refused there, and a shell command that names it, or that runs `cavvy host` to sign a machine in, is asked about. That's a guard against an agent wandering in, not a wall against one set on it.

`cavvy host` is what the server runs (`cavvy host run`, started by the service). You don't need to run it yourself.
