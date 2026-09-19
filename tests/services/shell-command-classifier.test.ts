/**
 * Shell Command Classifier — unit tests
 *
 * Exhaustive coverage of the categories produced by classifyShellCommand:
 *   - read            inspection-only
 *   - mutating        state-changing
 *   - sensitive-read  read-only but touches a sensitive path
 *   - risky           network / indirection / traversal
 *   - unknown         cannot be confidently classified
 *
 * Plus the tokenize() helper and the edge cases (empty, null, undefined,
 * non-string, sudo prefix, env-var prefix, redirect, command substitution,
 * pipelines, sensitive patterns).
 */

import { describe, it, expect } from "vitest"
import {
  classifyShellCommand,
  tokenize,
  type ShellCategory,
} from "../../src/services/shell-command-classifier"

function cat(command: string, opts?: { workingDir?: string; extraSensitivePatterns?: ReadonlyArray<string> }): ShellCategory {
  return classifyShellCommand(command, opts).category
}

// ─── Read-only commands ────────────────────────────────────────────────────

describe("classifyShellCommand: read-only commands", () => {
  const readOnlyCases: ReadonlyArray<[string, string]> = [
    ["ls", "ls"],
    ["ls -la", "ls -la"],
    ["ls -la path", "ls -la /tmp"],
    ["pwd", "pwd"],
    ["find with path", "find . -name '*.ts'"],
    ["find with depth", "find /var/log -maxdepth 2 -type f"],
    ["head", "head -n 20 README.md"],
    ["tail", "tail -f /var/log/app.log"],
    ["tail -n", "tail -n 50 file.log"],
    ["cat file", "cat package.json"],
    ["cat with flag", "cat -n src/index.ts"],
    ["less", "less file.txt"],
    ["more", "more file.txt"],
    ["wc", "wc -l file.txt"],
    ["file", "file /bin/ls"],
    ["stat", "stat package.json"],
    ["du", "du -sh /tmp"],
    ["df", "df -h"],
    ["tree", "tree -L 2"],
    ["echo no redirect", "echo hello"],
    ["printf", "printf '%s\\n' hi"],
    ["env", "env"],
    ["printenv", "printenv PATH"],
    ["which", "which bun"],
    ["type", "type ls"],
    ["command -v", "command -v bash"],
    ["date", "date"],
    ["uname", "uname -a"],
    ["whoami", "whoami"],
    ["id", "id"],
    ["hostname", "hostname"],
    ["ps", "ps aux"],
    ["lsof", "lsof -i :8080"],
    ["netstat", "netstat -tlnp"],
    ["ss", "ss -tlnp"],
    ["ip", "ip addr"],
    ["ifconfig", "ifconfig"],
    ["md5sum", "md5sum file.txt"],
    ["sha256sum", "sha256sum file.txt"],
    ["base64", "base64 file.txt"],
    ["xxd", "xxd file.bin"],
    ["od", "od -c file.bin"],
    ["sort", "sort file.txt"],
    ["uniq", "uniq file.txt"],
    ["diff", "diff a.txt b.txt"],
    ["grep", "grep -r pattern src/"],
    ["rg", "rg 'TODO' src/"],
    ["fd", "fd pattern src/"],
    ["basename", "basename /tmp/file.txt"],
    ["dirname", "dirname /tmp/file.txt"],
    ["realpath", "realpath ./link"],
    ["tr", "tr a-z A-Z < file.txt"],
    ["cut", "cut -d: -f1 /etc/passwd"],
    ["seq", "seq 1 10"],
    ["true", "true"],
    ["false", "false"],
  ]
  for (const [label, cmd] of readOnlyCases) {
    it(`classifies '${label}' as read`, () => {
      expect(cat(cmd)).toBe("read")
    })
  }
})

// ─── Read-only git subcommands ─────────────────────────────────────────────

describe("classifyShellCommand: git read-only subcommands", () => {
  const gitReadOnly: ReadonlyArray<[string, string]> = [
    ["git status", "git status"],
    ["git status with flags", "git status --short --branch"],
    ["git log", "git log --oneline -10"],
    ["git log graph", "git log --graph --decorate"],
    ["git diff", "git diff"],
    ["git diff staged", "git diff --staged"],
    ["git diff stat", "git diff --stat HEAD~1"],
    ["git show", "git show HEAD"],
    ["git blame", "git blame README.md"],
    ["git ls-files", "git ls-files"],
    ["git ls-remote", "git ls-remote origin"],
    ["git rev-parse", "git rev-parse HEAD"],
    ["git rev-list", "git rev-list HEAD"],
    ["git describe", "git describe --tags"],
    ["git reflog", "git reflog"],
    ["git shortlog", "git shortlog -s -n"],
    ["git grep", "git grep pattern"],
    ["git -C dir status", "git -C xxx/yyy status"],
    ["git -C dir log", "git -C /abs/path log --oneline"],
    ["git --git-dir= status", "git --git-dir=.git --work-tree=. status"],
    ["git -c config log", "git -c color.ui=false log -1"],
    ["git --no-pager diff", "git --no-pager -P diff --stat"],
    ["git rev-parse flags", "git rev-parse --show-toplevel --abbrev-ref HEAD"],
    ["git blame -C", "git blame -C -C README.md"],
    ["git diff -M", "git diff -M --stat HEAD~1"],
    ["git log -m", "git log -m -1"],
    ["git cat-file", "git cat-file -p HEAD"],
    ["git merge-base", "git merge-base main HEAD"],
    ["git for-each-ref", "git for-each-ref refs/heads"],
    ["git show-ref", "git show-ref --heads"],
    ["git name-rev", "git name-rev HEAD"],
    ["git check-ignore", "git check-ignore -v dist"],
    ["git --version", "git --version"],
    ["rtk git -C dir status", "rtk git -C xxx/yyy status"],
    ["cd", "cd src"],
    ["cd and git status", "cd xxx/yyy && git status"],
    ["git branch --show-current", "git branch --show-current"],
    ["git branch", "git branch"],
    ["git branch -a", "git branch -a -vv"],
    ["git branch --list pattern", "git branch --list 'feat/*'"],
    ["git branch --merged", "git branch --merged main"],
    ["git branch -r --contains", "git branch -r --contains HEAD"],
    ["git tag", "git tag"],
    ["git tag -l pattern", "git tag -l 'v*'"],
    ["git tag --points-at", "git tag --points-at HEAD --sort=-v:refname"],
    ["git stash list", "git stash list"],
    ["git stash show", "git stash show -p stash@{0}"],
    ["git remote", "git remote"],
    ["git remote -v", "git remote -v"],
    ["git remote get-url", "git remote get-url origin"],
    ["git remote show", "git remote show origin"],
    ["git worktree list", "git worktree list --porcelain"],
    ["git config --get", "git config --get user.name"],
    ["git config --list", "git config --list --show-origin"],
    ["git submodule status", "git submodule status"],
    ["user pipeline", "cd /home/iqdev && git status --short 2>/dev/null | head; echo \"\"; git branch --show-current; echo \"\"; find . -type f -not -path './git' | head -60"],
    ["user pipeline 2", "git status --short | head -n20; echo \"\"; git branch --show-current;cat go.mod"],
  ]
  for (const [label, cmd] of gitReadOnly) {
    it(`classifies '${label}' as read`, () => {
      expect(cat(cmd)).toBe("read")
    })
  }
})

// ─── Mutating commands ─────────────────────────────────────────────────────

describe("classifyShellCommand: mutating commands", () => {
  const mutatingCases: ReadonlyArray<[string, string]> = [
    ["rm -rf", "rm -rf node_modules"],
    ["rm file", "rm package.json"],
    ["mv", "mv a b"],
    ["cp", "cp a b"],
    ["mkdir", "mkdir foo"],
    ["touch", "touch file.txt"],
    ["chmod", "chmod 777 file"],
    ["chown", "chown root file"],
    ["kill", "kill -9 1"],
    ["killall", "killall node"],
    ["apt install", "apt install nginx"],
    ["apt-get install", "apt-get install nginx"],
    ["yum install", "yum install nginx"],
    ["dnf install", "dnf install nginx"],
    ["pacman -S", "pacman -S nginx"],
    ["apk add", "apk add nginx"],
    ["pip install", "pip install requests"],
    ["pip3 install", "pip3 install requests"],
    ["npm install", "npm install lodash"],
    ["npm i", "npm i -g tsx"],
    ["pnpm install", "pnpm install"],
    ["yarn add", "yarn add react"],
    ["bun install", "bun install"],
    ["bunx", "bunx tsx"],
    ["npx", "npx tsx"],
    ["cargo build", "cargo build"],
    ["cargo install", "cargo install ripgrep"],
    ["make", "make build"],
    ["gmake", "gmake"],
    ["cmake", "cmake ."],
    ["docker run", "docker run -it alpine"],
    ["docker exec", "docker exec -it c1 sh"],
    ["docker pull", "docker pull alpine"],
    ["podman run", "podman run alpine"],
    ["kubectl apply", "kubectl apply -f x.yaml"],
    ["kubectl delete", "kubectl delete pod x"],
    ["helm install", "helm install x chart"],
    ["terraform apply", "terraform apply"],
    ["pulumi up", "pulumi up"],
    ["ansible-playbook", "ansible-playbook site.yml"],
    ["vagrant up", "vagrant up"],
    ["brew install", "brew install ripgrep"],
    ["snap install", "snap install code"],
    ["flatpak install", "flatpak install flathub code"],
    ["git commit", "git commit -m 'x'"],
    ["git commit amend", "git commit --amend"],
    ["git push", "git push origin main"],
    ["git pull", "git pull origin main"],
    ["git merge", "git merge feature"],
    ["git rebase", "git rebase main"],
    ["git rebase interactive", "git rebase -i HEAD~3"],
    ["git reset hard", "git reset --hard"],
    ["git reset soft", "git reset --soft HEAD~1"],
    ["git checkout file", "git checkout -- file.txt"],
    ["git checkout branch", "git checkout -b newbranch"],
    ["git switch", "git switch newbranch"],
    ["git restore", "git restore file.txt"],
    ["git branch new", "git branch newbranch"],
    ["git branch delete", "git branch -d old"],
    ["git tag new", "git tag v1.0"],
    ["git tag delete", "git tag -d v1.0"],
    ["git config set", "git config user.name 'x'"],
    ["git config --set", "git config --set user.name x"],
    ["git config --unset", "git config --unset user.name"],
    ["git -C dir commit", "git -C xxx/yyy commit -m x"],
    ["git -C dir only", "git -C xxx/yyy"],
    ["git remote add", "git remote add origin url"],
    ["git remote set-url", "git remote set-url origin url"],
    ["git remote rm", "git remote rm origin"],
    ["git worktree add", "git worktree add ../wt"],
    ["git worktree remove", "git worktree remove wt"],
    ["git branch -m", "git branch -m old new"],
    ["git branch -u", "git branch -u origin/main"],
    ["git branch --set-upstream-to=", "git branch --set-upstream-to=origin/main"],
    ["git branch -f", "git branch -f main HEAD~1"],
    ["git tag annotated", "git tag -a v1.0 -m x"],
    ["git tag -f", "git tag -f v1.0"],
    ["git config --get + --unset", "git config --get --unset user.name"],
    ["git config --edit", "git config --edit"],
    ["git stash show then pop", "git stash show && git stash pop"],
    ["git submodule update", "git submodule update --init"],
    ["git stash push", "git stash push -m x"],
    ["git stash pop", "git stash pop"],
    ["git stash drop", "git stash drop"],
    ["git stash clear", "git stash clear"],
    ["git init", "git init"],
    ["git clean", "git clean -fd"],
    ["git fetch", "git fetch origin"],
    ["git pull network", "git pull origin main"],
    ["git push network", "git push origin main"],
    ["git clone", "git clone https://example.com/repo.git"],
    ["git archive", "git archive HEAD | tar -x"],
    ["git cherry-pick", "git cherry-pick abc123"],
    ["git revert", "git revert abc123"],
    ["ssh", "ssh user@host"],
    ["scp", "scp file user@host:/tmp"],
    ["sftp", "sftp user@host"],
    ["ftp", "ftp ftp.example.com"],
    ["rsync", "rsync -a src/ dst/"],
    ["curl", "curl -X POST http://example.com"],
    ["curl -O", "curl -O http://example.com/file"],
    ["wget", "wget http://example.com/file"],
    ["nc", "nc -l 8080"],
    ["ncat", "ncat -l 8080"],
    ["socat", "socat TCP-LISTEN:8080"],
    ["tar extract", "tar -xf archive.tar"],
    ["tar xz", "tar -xzf archive.tar.gz"],
    ["unzip", "unzip archive.zip"],
    ["gunzip", "gunzip file.gz"],
    ["7z", "7z x archive.7z"],
    ["xz", "xz file"],
    ["gzip", "gzip file"],
    ["vim", "vim file.txt"],
    ["vi", "vi file.txt"],
    ["nvim", "nvim file.txt"],
    ["emacs", "emacs file.txt"],
    ["nano", "nano file.txt"],
    ["sed -i", "sed -i 's/a/b/' file.txt"],
    ["awk write", 'awk \'BEGIN{print "x">"f"}\''],
    ["perl -i", "perl -i -pe 's/a/b/' file.txt"],
    ["mount", "mount /dev/sdb1 /mnt"],
    ["umount", "umount /mnt"],
    ["mkfs", "mkfs.ext4 /dev/sdb1"],
    ["fdisk", "fdisk /dev/sdb"],
    ["iptables", "iptables -A INPUT -j DROP"],
    ["firewall-cmd", "firewall-cmd --add-port=80/tcp"],
    ["crontab", "crontab -e"],
    ["useradd", "useradd newuser"],
    ["usermod", "usermod -aG sudo user"],
    ["passwd", "passwd user"],
    ["systemctl start", "systemctl start nginx"],
    ["systemctl restart", "systemctl restart nginx"],
    ["service restart", "service nginx restart"],
    ["shutdown", "shutdown -h now"],
    ["reboot", "reboot"],
    ["export", "export FOO=bar"],
    ["eval", "eval $CMD"],
    ["source", "source script.sh"],
    ["exec", "exec bash"],
    ["alias", "alias ll='ls -la'"],
    ["unalias", "unalias ll"],
    ["unset", "unset FOO"],
  ]
  for (const [label, cmd] of mutatingCases) {
    it(`classifies '${label}' as mutating or risky`, () => {
      const c = cat(cmd)
      expect(c).toMatch(/mutating|risky/)
    })
  }
})

// ─── Sensitive-path reads ──────────────────────────────────────────────────

describe("classifyShellCommand: sensitive-path reads", () => {
  const sensitiveCases: ReadonlyArray<[string, string, string]> = [
    ["cat .env", "cat .env", ".env"],
    ["cat .env.local", "cat .env.local", ".env"],
    ["cat .envrc", "cat .envrc", ".envrc"],
    ["cat .npmrc", "cat .npmrc", ".npmrc"],
    ["cat .pypirc", "cat .pypirc", ".pypirc"],
    ["cat .netrc", "cat .netrc", ".netrc"],
    ["cat .ssh id_rsa", "cat ~/.ssh/id_rsa", "id_rsa"],
    ["cat .ssh dir", "ls ~/.ssh/", ".ssh/"],
    ["cat .aws credentials", "cat ~/.aws/credentials", ".aws/credentials"],
    ["cat .aws config", "cat ~/.aws/config", ".aws/config"],
    ["cat .kube config", "cat ~/.kube/config", ".kube/config"],
    ["cat .pem", "cat server.pem", ".pem"],
    ["cat .key", "cat tls.key", ".key"],
    ["cat .p12", "cat cert.p12", ".p12"],
    ["cat .pfx", "cat cert.pfx", ".pfx"],
    ["cat .secret", "cat config.secret", ".secret"],
    ["cat credentials", "cat credentials.json", "credentials.json"],
    ["cat /etc/passwd", "cat /etc/passwd", "/etc/passwd"],
    ["cat /etc/shadow", "cat /etc/shadow", "/etc/shadow"],
    ["cat /etc/sudoers", "cat /etc/sudoers", "/etc/sudoers"],
    ["head .env", "head -n 5 .env", ".env"],
    ["less secrets", "less secrets.json", "secrets."],
    ["find .env", "find . -name .env", ".env"],
    ["grep .env", "grep -r password .env", ".env"],
  ]
  for (const [label, cmd, expectedMatch] of sensitiveCases) {
    it(`classifies '${label}' as sensitive-read and includes '${expectedMatch}'`, () => {
      const r = classifyShellCommand(cmd)
      expect(r.category).toBe("sensitive-read")
      expect(r.sensitiveMatches.some(m => m.toLowerCase().includes(expectedMatch.toLowerCase()))).toBe(true)
    })
  }

  it("includes extra sensitive patterns when supplied", () => {
    const r = classifyShellCommand("cat company-secrets.txt", {
      extraSensitivePatterns: ["company-secrets"],
    })
    expect(r.category).toBe("sensitive-read")
    expect(r.sensitiveMatches).toContain("company-secrets")
  })

  it("does not classify non-sensitive cat as sensitive-read", () => {
    expect(cat("cat README.md")).toBe("read")
    expect(cat("cat package.json")).toBe("read")
  })
})

// ─── Risky / network / indirection ─────────────────────────────────────────

describe("classifyShellCommand: risky / network / indirection", () => {
  it("classifies `git fetch` (network) as risky", () => {
    expect(cat("git fetch origin")).toBe("risky")
  })
  it("classifies `git clone` (network) as risky", () => {
    expect(cat("git clone https://example.com/repo.git")).toBe("risky")
  })
  it("classifies `git pull` (network) as risky", () => {
    expect(cat("git pull origin main")).toBe("risky")
  })
  it("classifies `git push` (network) as risky", () => {
    expect(cat("git push origin main")).toBe("risky")
  })
  it("classifies `git archive` (writes extract) as risky", () => {
    expect(cat("git archive HEAD")).toBe("risky")
  })

  it("classifies `bash -c '...'` as unknown (indirection)", () => {
    expect(cat("bash -c 'ls'")).toBe("unknown")
  })
  it("classifies `sh -c '...'` as unknown (indirection)", () => {
    expect(cat("sh -c 'ls'")).toBe("unknown")
  })

  it("classifies path-traversal as risky", () => {
    expect(cat("ls ../../..")).toBe("risky")
  })

  it("classifies `~`-expansion as risky", () => {
    expect(cat("ls ~")).toBe("risky")
    expect(cat("cat ~/file")).toBe("risky")
  })
})

// ─── Redirects and command substitution ────────────────────────────────────

describe("classifyShellCommand: redirects and command substitution", () => {
  it("classifies `>` redirect as mutating", () => {
    expect(cat("echo hi > /tmp/x")).toBe("mutating")
  })
  it("classifies `>>` redirect as mutating", () => {
    expect(cat("echo hi >> /tmp/x")).toBe("mutating")
  })
  it("classifies bare `<` redirect as read-only (not mutating)", () => {
    expect(cat("cat < /etc/hostname")).toBe("read")
  })
  it("classifies `&>` redirect as mutating", () => {
    expect(cat("ls &> /tmp/x")).toBe("mutating")
  })
  it("classifies `2>` redirect as mutating", () => {
    expect(cat("ls /nonexistent 2> /tmp/err")).toBe("mutating")
  })
  it("classifies process substitution `<(...)` as mutating", () => {
    expect(cat("cat <(ls)")).toBe("mutating")
  })
  it("classifies `$(...)` command substitution as mutating", () => {
    expect(cat("echo $(ls)")).toBe("mutating")
  })
  it("classifies backtick command substitution as mutating", () => {
    expect(cat("echo `ls`")).toBe("mutating")
  })
  for (const cmd of [
    "git status >/dev/null",
    "git status > /dev/null",
    "ls /nonexistent 2>/dev/null",
    "ls /nonexistent 2>> /dev/null",
    "ls &>/dev/null",
    "ls &> /dev/null",
    "git -C xxx/yyy status 2>&1",
    "git status >/dev/null 2>&1",
    "git status 2>&1 >/dev/null",
    "cat </dev/null",
    "ls 2>/dev/null | wc -l",
    "ls 2>/dev/null && git status 2>/dev/null",
  ]) {
    it(`treats /dev/null and fd-dup redirects as read-only: ${cmd}`, () => {
      expect(cat(cmd)).toBe("read")
    })
  }
  it("still blocks writes to other /dev nodes", () => {
    expect(cat("echo hi > /dev/sda")).toBe("mutating")
  })
  it("still blocks writes when only stderr goes to /dev/null", () => {
    expect(cat("ls > /tmp/x 2>/dev/null")).toBe("mutating")
  })
  it("still flags reads from other /dev nodes as sensitive", () => {
    expect(cat("cat /dev/mem")).toBe("sensitive-read")
  })
})

// ─── Pipelines and control operators ───────────────────────────────────────

describe("classifyShellCommand: pipelines and control operators", () => {
  it("classifies read-only pipeline `ls | head` as read", () => {
    expect(cat("ls | head -5")).toBe("read")
  })
  it("classifies read-only pipeline `cat | grep` as read", () => {
    expect(cat("cat README.md | grep -i flowdeck")).toBe("read")
  })
  it("classifies `ls; rm -rf /` as mutating (segment is mutating)", () => {
    expect(cat("ls; rm -rf /")).toBe("mutating")
  })
  it("classifies `ls && rm -rf /` as mutating", () => {
    expect(cat("ls && rm -rf /")).toBe("mutating")
  })
  it("classifies `ls || rm -rf /` as mutating", () => {
    expect(cat("ls || rm -rf /")).toBe("mutating")
  })
  it("classifies read-only chain `uname && date` as read", () => {
    expect(cat("uname && date")).toBe("read")
  })
  it("reports the mutating segment's reason, not the first segment's", () => {
    const r = classifyShellCommand("cd src && git status && git commit -m x")
    expect(r.category).toBe("mutating")
    expect(r.reason).toMatch(/git command mutates repository state/)
  })
})

// ─── Sudo and env-var prefix stripping ─────────────────────────────────────

describe("classifyShellCommand: sudo and env-var prefix stripping", () => {
  it("strips `sudo` from a read-only command", () => {
    expect(cat("sudo ls -la /tmp")).toBe("read")
  })
  it("strips `sudo` from a mutating command", () => {
    expect(cat("sudo rm -rf /tmp")).toBe("mutating")
  })
  it("strips `LANG=C` env-var prefix from a read-only command", () => {
    expect(cat("LANG=C ls")).toBe("read")
  })
  it("strips multiple env-var prefixes", () => {
    expect(cat("FOO=bar BAZ=qux ls")).toBe("read")
  })
})

// ─── Unknown / edge cases ──────────────────────────────────────────────────

describe("classifyShellCommand: unknown / edge cases", () => {
  it("returns unknown for null", () => {
    expect(cat(null as unknown as string)).toBe("unknown")
  })
  it("returns unknown for undefined", () => {
    expect(cat(undefined as unknown as string)).toBe("unknown")
  })
  it("returns unknown for empty string", () => {
    expect(cat("")).toBe("unknown")
  })
  it("returns unknown for whitespace-only string", () => {
    expect(cat("   ")).toBe("unknown")
  })
  it("returns unknown for non-string input", () => {
    expect(cat(42 as unknown as string)).toBe("unknown")
  })
  it("returns unknown for unrecognized command", () => {
    expect(cat("weirdcustombinary --flag")).toBe("unknown")
  })
  it("returns unknown for exotic shell builtin", () => {
    expect(cat("compopt -o plusdirs")).toBe("unknown")
  })
})

// ─── tokenize() helper ─────────────────────────────────────────────────────

describe("tokenize", () => {
  it("splits on whitespace", () => {
    expect(tokenize("ls -la /tmp")).toEqual(["ls", "-la", "/tmp"])
  })
  it("strips single quotes", () => {
    expect(tokenize("echo 'hello world'")).toEqual(["echo", "hello world"])
  })
  it("strips double quotes", () => {
    expect(tokenize('echo "hello world"')).toEqual(["echo", "hello world"])
  })
  it("handles mixed quotes and whitespace", () => {
    expect(tokenize(`ls -la "/tmp with space" 'foo bar'`)).toEqual([
      "ls",
      "-la",
      "/tmp with space",
      "foo bar",
    ])
  })
  it("respects backslash escapes", () => {
    expect(tokenize("echo a\\ b")).toEqual(["echo", "a b"])
  })
  it("returns empty array for empty string", () => {
    expect(tokenize("")).toEqual([])
  })
  it("returns empty array for whitespace-only string", () => {
    expect(tokenize("   \t  ")).toEqual([])
  })
})

describe("classifyShellCommand: rtk proxy wrapper", () => {
  it("classifies `rtk read` as read-only, including FlowDeck's ~/.fd-plan/ root", () => {
    expect(classifyShellCommand("rtk read ~/.fd-plan/qdns/checkpoint.json").category).toBe("read")
    expect(classifyShellCommand("rtk read src/index.ts --head-lines 20").category).toBe("read")
  })

  it("inherits the wrapped command's category for passthrough subcommands", () => {
    expect(classifyShellCommand("rtk ls src").category).toBe("read")
    expect(classifyShellCommand("rtk grep -n foo src").category).toBe("read")
    expect(classifyShellCommand("rtk git status").category).toBe("read")
    expect(classifyShellCommand("rtk git commit -m x").category).toBe("mutating")
    expect(classifyShellCommand("rtk cargo build").category).toBe("mutating")
    expect(classifyShellCommand("rtk npm install").category).toBe("mutating")
  })

  it("classifies the command wrapped by `rtk proxy` / `rtk summary`", () => {
    expect(classifyShellCommand("rtk proxy git log --oneline").category).toBe("read")
    expect(classifyShellCommand("rtk proxy rm -rf dist").category).toBe("mutating")
    expect(classifyShellCommand("rtk summary cargo test").category).toBe("mutating")
  })

  it("treats rtk meta commands as mutating", () => {
    for (const cmd of ["rtk init -g --opencode", "rtk config set x y", "rtk trust", "rtk gain", "rtk rewrite ls"]) {
      expect(classifyShellCommand(cmd).category).toBe("mutating")
    }
    expect(classifyShellCommand("rtk").category).toBe("unknown")
  })
})

describe("classifyShellCommand: ~/.fd-plan/ planning root", () => {
  it("allows read-only inspection of ~/.fd-plan/ but keeps other ~ paths risky", () => {
    expect(classifyShellCommand("cat ~/.fd-plan/qdns/checkpoint.json").category).toBe("read")
    expect(classifyShellCommand("ls ~/.fd-plan/").category).toBe("read")
    expect(classifyShellCommand("cat ~/notes.txt").category).toBe("risky")
    expect(classifyShellCommand("cat ~/.fd-plan/../.ssh/id_rsa").category).not.toBe("read")
  })
})
