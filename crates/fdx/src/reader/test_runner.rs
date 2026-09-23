use crate::runner::{run, run_in_dir, CommandOutput};
use crate::tee::save_tee;
use anyhow::{bail, Result};

/// Run tests with the specified runner and token-optimized output.
///
/// Supported runners: cargo, pytest, jest, vitest, go, rspec, rails.
pub fn run_tests(runner: &str, args: &[String]) -> Result<CommandOutput> {
    let output = match runner {
        "cargo" => run_cargo_test(args)?,
        "pytest" => run_pytest(args)?,
        "jest" => run_jest(args)?,
        "vitest" => run_vitest(args)?,
        "go" => run_go_test(args)?,
        "rspec" => run_rspec(args)?,
        "rails" => run_rails_test(args)?,
        _ => bail!(
            "unsupported test runner: {} (supported: cargo, pytest, jest, vitest, go, rspec, rails)",
            runner
        ),
    };

    let compressed = compress_test_output(runner, &output)?;
    Ok(compressed)
}

fn run_cargo_test(args: &[String]) -> Result<CommandOutput> {
    let mut cmd_args = vec!["test"];
    let extra: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    cmd_args.extend(extra);
    run("cargo", &cmd_args)
}

fn run_pytest(args: &[String]) -> Result<CommandOutput> {
    let extra: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    run("pytest", &extra)
}

fn run_jest(args: &[String]) -> Result<CommandOutput> {
    let mut cmd_args = vec!["--no-coverage"];
    let extra: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    cmd_args.extend(extra);
    run("jest", &cmd_args)
}

fn run_vitest(args: &[String]) -> Result<CommandOutput> {
    let mut cmd_args = vec!["run"];
    let extra: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    cmd_args.extend(extra);
    run("vitest", &cmd_args)
}

fn run_go_test(args: &[String]) -> Result<CommandOutput> {
    let (max_procs, parallelism) = go_cpu_cap();
    let gomaxprocs = max_procs.to_string();
    let env: [(&str, &str); 1] = [("GOMAXPROCS", gomaxprocs.as_str())];
    let go_args = with_parallelism_flag(args, parallelism);

    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    // Single-module repo: keep today's behavior (run in the inherited cwd).
    if cwd.join("go.mod").is_file() {
        let cmd_args: Vec<&str> = std::iter::once("test")
            .chain(go_args.iter().map(|s| s.as_str()))
            .collect();
        return run_with_env_go("go", &cmd_args, &env, None);
    }
    // Multi-module workspace: one `go test` per `use` dir.
    let go_work = cwd.join("go.work");
    if go_work.is_file() {
        if let Ok(content) = std::fs::read_to_string(&go_work) {
            let modules = parse_go_work_uses(&content);
            if !modules.is_empty() {
                return run_go_workspace_tests(&cwd, &modules, &go_args, &env);
            }
        }
        // Unparseable/empty go.work: fall through to go's natural error.
    }

    let cmd_args: Vec<&str> = std::iter::once("test")
        .chain(go_args.iter().map(|s| s.as_str()))
        .collect();
    run_with_env_go("go", &cmd_args, &env, None)
}

/// Max parallel `go test` packages (`-p`) and `GOMAXPROCS` cap.
///
/// Hard requirement: never use more than 16 cores. Defaults mirror
/// `make test` in the linkcalendar repo: 4 parallel packages x 4 procs.
fn go_cpu_cap() -> (u32, u32) {
    let cpus: u32 = std::env::var("FD_TEST_CPUS")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|v: &u32| *v > 0)
        .unwrap_or(16);
    let parallelism: u32 = std::env::var("FD_TEST_P")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|v: &u32| *v > 0)
        .unwrap_or(4);
    let max_procs = std::cmp::max(1, cpus / std::cmp::max(1, parallelism));
    (max_procs, parallelism)
}

/// Prepend `-p <parallelism>` unless the caller already passed a `-p` flag.
/// With no caller args, default to testing the whole module (`./...`).
fn with_parallelism_flag(args: &[String], parallelism: u32) -> Vec<String> {
    let has_p = args.iter().any(|a| {
        a == "-p" || a.starts_with("-p=") || (a.starts_with("-p") && a[2..].starts_with(|c: char| c.is_ascii_digit()))
    });
    let mut out = Vec::with_capacity(args.len() + 3);
    if !has_p {
        out.push("-p".to_string());
        out.push(parallelism.to_string());
    }
    out.extend(args.iter().cloned());
    if args.is_empty() {
        out.push("./...".to_string());
    }
    out
}

/// Strip one layer of surrounding single or double quotes, if present.
fn strip_path_quotes(s: &str) -> &str {
    let s = s.trim();
    if s.len() >= 2 {
        let b = s.as_bytes();
        if (b[0] == b'"' && b[s.len() - 1] == b'"')
            || (b[0] == b'\'' && b[s.len() - 1] == b'\'')
        {
            return s[1..s.len() - 1].trim();
        }
    }
    s
}

/// Push whitespace-separated tokens, dropping empties, lone parens, and quotes.
fn push_use_tokens(uses: &mut Vec<String>, s: &str) {
    for part in s.split_whitespace() {
        if part.is_empty() || part == "(" || part == ")" {
            continue;
        }
        let p = strip_path_quotes(part.trim_matches(|c| c == '(' || c == ')'));
        if p.is_empty() || p == ")" || p == "use" {
            continue;
        }
        uses.push(p.to_string());
    }
}

/// Parse `use` directives from go.work content.
///
/// Supports `use ./x` one-liners and `use ( ... )` blocks.
/// Strips `//` comments and blank lines; ignores `go`/`toolchain`/`replace`.
fn parse_go_work_uses(content: &str) -> Vec<String> {
    let mut uses = Vec::new();
    let mut in_use_block = false;
    for raw in content.lines() {
        let line = match raw.find("//") {
            Some(i) => &raw[..i],
            None => raw,
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if in_use_block {
            if line == ")" {
                in_use_block = false;
                continue;
            }
            // Trailing `)` on the same line closes the block (e.g. `./b )`).
            let (effective, closes) = match line.strip_suffix(')') {
                Some(prefix) => (prefix.trim(), true),
                None => (line, false),
            };
            if effective == "use" || effective.is_empty() {
                if closes {
                    in_use_block = false;
                }
                continue;
            }
            let candidate = match effective.strip_prefix("use") {
                Some(tail)
                    if tail.starts_with(|c: char| c.is_whitespace() || c == '(') =>
                {
                    tail.trim_start().trim_start_matches('(').trim()
                }
                _ => effective,
            };
            push_use_tokens(&mut uses, candidate);
            if closes {
                in_use_block = false;
            }
            continue;
        }
        let Some(tail) = line.strip_prefix("use") else {
            continue;
        };
        if !(tail.is_empty() || tail.starts_with(|c: char| c.is_whitespace() || c == '('))
        {
            continue;
        }
        let tail = tail.trim();
        if tail.is_empty() {
            continue;
        }
        if tail.starts_with('(') {
            let inner = tail.trim_start_matches('(').trim();
            if inner.is_empty() {
                in_use_block = true;
                continue;
            }
            if inner.ends_with(')') {
                let body = inner.trim_end_matches(')').trim();
                if body.is_empty() {
                    continue; // `use ( )`: empty single-line block, stays closed.
                }
                push_use_tokens(&mut uses, body);
                continue;
            }
            in_use_block = true; // `use ( ./a` with entries on later lines.
            push_use_tokens(&mut uses, inner);
            continue;
        }
        push_use_tokens(&mut uses, tail);
    }
    uses
}

fn run_with_env_go(
    program: &str,
    args: &[&str],
    env: &[(&str, &str)],
    cwd: Option<&std::path::Path>,
) -> Result<CommandOutput> {
    run_in_dir(program, args, env, cwd)
}

fn run_go_workspace_tests(
    root: &std::path::Path,
    modules: &[String],
    go_args: &[String],
    env: &[(&str, &str)],
) -> Result<CommandOutput> {
    let mut combined_out = String::new();
    let mut combined_err = String::new();
    let mut success = true;
    let mut first_code = 0;
    for module in modules {
        let dir = root.join(module);
        let cmd_args: Vec<&str> = std::iter::once("test")
            .chain(go_args.iter().map(|s| s.as_str()))
            .collect();
        let header = format!("=== {} ===", module);
        match run_in_dir("go", &cmd_args, env, Some(&dir)) {
            Ok(out) => {
                combined_out.push_str(&header);
                combined_out.push('\n');
                combined_out.push_str(&out.stdout);
                if !out.stdout.ends_with('\n') {
                    combined_out.push('\n');
                }
                combined_err.push_str(&header);
                combined_err.push('\n');
                combined_err.push_str(&out.stderr);
                if !out.stderr.ends_with('\n') {
                    combined_err.push('\n');
                }
                if !out.success {
                    success = false;
                    if first_code == 0 {
                        first_code = out.exit_code;
                    }
                }
            }
            Err(e) => {
                combined_out.push_str(&header);
                combined_out.push('\n');
                combined_out.push_str(&format!("error running go test: {}\n", e));
                success = false;
                if first_code == 0 {
                    first_code = 1;
                }
            }
        }
    }
    Ok(CommandOutput {
        stdout: combined_out,
        stderr: combined_err,
        exit_code: if success { 0 } else { first_code },
        success,
    })
}

fn run_rspec(args: &[String]) -> Result<CommandOutput> {
    let mut cmd_args = vec!["--format", "json"];
    let extra: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    cmd_args.extend(extra);
    run("rspec", &cmd_args)
}

fn run_rails_test(args: &[String]) -> Result<CommandOutput> {
    let extra: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    run("rails", &std::iter::once("test").chain(extra.iter().copied()).collect::<Vec<_>>())
}

/// Compress test output to show failures only.
fn compress_test_output(runner: &str, output: &CommandOutput) -> Result<CommandOutput> {
    let combined = format!("{}\n{}", output.stdout, output.stderr);

    match runner {
        "cargo" => compress_cargo_output(output, &combined),
        "pytest" => compress_pytest_output(output, &combined),
        "jest" => compress_jest_output(output, &combined),
        "vitest" => compress_vitest_output(output, &combined),
        "go" => compress_go_output(output, &combined),
        "rspec" => compress_rspec_output(output, &combined),
        "rails" => compress_rails_output(output, &combined),
        _ => Ok(output.clone()),
    }
}

fn compress_cargo_output(original: &CommandOutput, combined: &str) -> Result<CommandOutput> {
    // Check if all passed
    if original.success {
        let count = count_cargo_tests(combined);
        return Ok(CommandOutput {
            stdout: format!("ok  {} tests passed\n", count),
            stderr: String::new(),
            exit_code: 0,
            success: true,
        });
    }

    // Extract failures
    let mut failures = Vec::new();
    let mut in_failure = false;
    let mut current_failure = String::new();
    let mut current_name = String::new();

    for line in combined.lines() {
        if line.starts_with("test ") && line.contains(" ... FAILED") {
            if in_failure && !current_failure.is_empty() {
                failures.push((current_name.clone(), current_failure.clone()));
            }
            in_failure = true;
            current_name = line
                .trim_start_matches("test ")
                .trim_end_matches(" ... FAILED")
                .to_string();
            current_failure = format!("{}\n", line);
        } else if in_failure {
            if line.starts_with("---- ") && line.contains(" stdout ----") {
                // Start of failure detail
                current_failure.push_str(line);
                current_failure.push('\n');
            } else if line.starts_with("---- ") && line.contains(" stderr ----") {
                // End of this failure block
                failures.push((current_name.clone(), current_failure.clone()));
                in_failure = false;
                current_failure.clear();
            } else if line.starts_with("test result:") {
                // End of all tests
                if !current_failure.is_empty() {
                    failures.push((current_name.clone(), current_failure.clone()));
                }
                in_failure = false;
            } else {
                current_failure.push_str(line);
                current_failure.push('\n');
            }
        }
    }

    if failures.is_empty() {
        // Couldn't parse failures, return raw
        return Ok(original.clone());
    }

    let mut result = String::new();
    for (name, detail) in &failures {
        result.push_str(&format!("FAIL  {}\n", name));
        // Limit detail to first 20 lines
        let lines: Vec<&str> = detail.lines().collect();
        let capped = if lines.len() > 20 {
            &lines[..20]
        } else {
            &lines
        };
        for line in capped {
            result.push_str(line);
            result.push('\n');
        }
        if lines.len() > 20 {
            result.push_str("  [...truncated]\n");
        }
        result.push('\n');
    }

    let total = count_cargo_tests(combined);
    let failed = failures.len();
    result.push_str(&format!("FAILED  {}/{} tests\n", failed, total));

    // Hard cap: 100 lines
    let result_lines: Vec<&str> = result.lines().collect();
    let (final_output, truncated) = if result_lines.len() > 100 {
        let capped = result_lines[..100].join("\n");
        (capped + "\n", true)
    } else {
        (result, false)
    };

    if truncated {
        if let Ok(tee_path) = save_tee("cargo_test", &final_output) {
            let mut with_tee = final_output;
            with_tee.push_str(&format!("[full output saved: {}]\n", tee_path.display()));
            return Ok(CommandOutput {
                stdout: with_tee,
                stderr: String::new(),
                exit_code: original.exit_code,
                success: false,
            });
        }
    }

    Ok(CommandOutput {
        stdout: final_output,
        stderr: String::new(),
        exit_code: original.exit_code,
        success: false,
    })
}

fn count_cargo_tests(output: &str) -> usize {
    output
        .lines()
        .find(|line| line.starts_with("test result:"))
        .and_then(|line| {
            // Parse: "test result: ok. 2 passed; 0 failed; ..."
            // or: "test result: FAILED. 1 passed; 2 failed; ..."
            let parts: Vec<&str> = line.split_whitespace().collect();
            for (i, part) in parts.iter().enumerate() {
                if *part == "passed;" || *part == "passed." {
                    return parts.get(i.saturating_sub(1))
                        .and_then(|s| s.parse().ok());
                }
            }
            None
        })
        .unwrap_or(0)
}

fn compress_pytest_output(original: &CommandOutput, combined: &str) -> Result<CommandOutput> {
    if original.success {
        return Ok(CommandOutput {
            stdout: "ok  all tests passed\n".to_string(),
            stderr: String::new(),
            exit_code: 0,
            success: true,
        });
    }

    // Extract FAILED lines and short test summary
    let mut failures = Vec::new();
    let mut in_summary = false;

    for line in combined.lines() {
        if line.contains("short test summary info") {
            in_summary = true;
        }
        if in_summary && line.starts_with("FAILED") {
            failures.push(line.to_string());
        }
    }

    let mut result = failures.join("\n");
    result.push('\n');
    result.push_str("FAILED  pytest\n");

    Ok(CommandOutput {
        stdout: result,
        stderr: String::new(),
        exit_code: original.exit_code,
        success: false,
    })
}

fn compress_jest_output(original: &CommandOutput, combined: &str) -> Result<CommandOutput> {
    if original.success {
        return Ok(CommandOutput {
            stdout: "ok  all tests passed\n".to_string(),
            stderr: String::new(),
            exit_code: 0,
            success: true,
        });
    }

    let mut failures = Vec::new();
    for line in combined.lines() {
        if line.starts_with('✕') || line.contains("FAIL") {
            failures.push(line.to_string());
        }
    }

    let mut result = failures.join("\n");
    result.push('\n');
    result.push_str("FAILED  jest\n");

    Ok(CommandOutput {
        stdout: result,
        stderr: String::new(),
        exit_code: original.exit_code,
        success: false,
    })
}

fn compress_vitest_output(original: &CommandOutput, combined: &str) -> Result<CommandOutput> {
    if original.success {
        return Ok(CommandOutput {
            stdout: "ok  all tests passed\n".to_string(),
            stderr: String::new(),
            exit_code: 0,
            success: true,
        });
    }

    let mut failures = Vec::new();
    for line in combined.lines() {
        if line.starts_with('×') || line.contains("FAIL") {
            failures.push(line.to_string());
        }
    }

    let mut result = failures.join("\n");
    result.push('\n');
    result.push_str("FAILED  vitest\n");

    Ok(CommandOutput {
        stdout: result,
        stderr: String::new(),
        exit_code: original.exit_code,
        success: false,
    })
}

fn compress_go_output(original: &CommandOutput, combined: &str) -> Result<CommandOutput> {
    if original.success {
        return Ok(CommandOutput {
            stdout: "ok  all tests passed\n".to_string(),
            stderr: String::new(),
            exit_code: 0,
            success: true,
        });
    }

    let mut failures = Vec::new();
    let mut in_failure = false;

    for line in combined.lines() {
        if line.starts_with("=== ") {
            // Per-module header from workspace runs: keep for attribution.
            failures.push(line.to_string());
        } else if line.starts_with("--- FAIL:") {
            in_failure = true;
            failures.push(line.to_string());
        } else if in_failure {
            if line.starts_with("---") || line.is_empty() {
                in_failure = false;
            } else {
                failures.push(line.to_string());
            }
        }
    }

    let mut result = failures.join("\n");
    result.push('\n');
    result.push_str("FAILED  go test\n");

    Ok(CommandOutput {
        stdout: result,
        stderr: String::new(),
        exit_code: original.exit_code,
        success: false,
    })
}

fn compress_rspec_output(original: &CommandOutput, _combined: &str) -> Result<CommandOutput> {
    if original.success {
        return Ok(CommandOutput {
            stdout: "ok  all tests passed\n".to_string(),
            stderr: String::new(),
            exit_code: 0,
            success: true,
        });
    }

    // rspec --format json output
    let mut failures = Vec::new();
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&original.stdout) {
        if let Some(examples) = json.get("examples").and_then(|v| v.as_array()) {
            for ex in examples {
                if ex.get("status")
                    .and_then(|s| s.as_str())
                    == Some("failed")
                {
                    let desc = ex
                        .get("description")
                        .and_then(|d| d.as_str())
                        .unwrap_or("unknown");
                    let msg = ex
                        .get("exception")
                        .and_then(|e| e.get("message"))
                        .and_then(|m| m.as_str())
                        .unwrap_or("no message");
                    let file = ex
                        .get("file_path")
                        .and_then(|f| f.as_str())
                        .unwrap_or("unknown");
                    let line = ex
                        .get("line_number")
                        .and_then(|l| l.as_u64())
                        .unwrap_or(0);
                    failures.push(format!(
                        "FAIL  {}\n  {}:{}\n  {}\n",
                        desc, file, line, msg
                    ));
                }
            }
        }
    }

    let mut result = failures.join("\n");
    result.push_str("FAILED  rspec\n");

    Ok(CommandOutput {
        stdout: result,
        stderr: String::new(),
        exit_code: original.exit_code,
        success: false,
    })
}

fn compress_rails_output(original: &CommandOutput, combined: &str) -> Result<CommandOutput> {
    // Rails test output is similar to minitest
    compress_go_output(original, combined)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_single_line_use_directives() {
        let content = "go 1.21\n\nuse ./a\nuse ./services/b\n";
        assert_eq!(parse_go_work_uses(content), vec!["./a", "./services/b"]);
    }

    #[test]
    fn parses_use_block_form() {
        let content = "go 1.21\n\nuse (\n\t./a\n\t./b\n)\n";
        assert_eq!(parse_go_work_uses(content), vec!["./a", "./b"]);
    }

    #[test]
    fn strips_comments_blanks_and_ignores_other_directives() {
        let content = "go 1.21\n\n// a comment\nuse ./a // trailing\n\nuse (\n  ./b // inline\n\n  ./c\n)\n\nreplace example.com => ../x\ntoolchain go1.21.0\n";
        assert_eq!(
            parse_go_work_uses(content),
            vec!["./a", "./b", "./c"]
        );
    }

    #[test]
    fn parses_inline_fixture_workspace() {
        let content = "go 1.21\n\nuse (\n\t./a\n\t./services/b\n\t./tools/c\n)\n";
        assert_eq!(
            parse_go_work_uses(content),
            vec!["./a", "./services/b", "./tools/c"]
        );
    }

    #[test]
    fn injects_p_flag_and_defaults_to_all_packages() {
        assert_eq!(
            with_parallelism_flag(&[], 4),
            vec!["-p", "4", "./..."]
        );
        let args = vec!["./...".to_string()];
        assert_eq!(
            with_parallelism_flag(&args, 4),
            vec!["-p", "4", "./..."]
        );
    }

    #[test]
    fn respects_caller_p_flag() {
        let args = vec!["-p".to_string(), "2".to_string(), "./...".to_string()];
        assert_eq!(
            with_parallelism_flag(&args, 4),
            vec!["-p", "2", "./..."]
        );
        let args = vec!["-p=8".to_string()];
        assert_eq!(with_parallelism_flag(&args, 4), vec!["-p=8"]);
    }

    #[test]
    fn respects_attached_p_flag() {
        let args = vec!["-p4".to_string(), "./...".to_string()];
        assert_eq!(
            with_parallelism_flag(&args, 4),
            vec!["-p4", "./..."]
        );
    }

    #[test]
    fn go_cpu_cap_defaults_and_bad_input() {
        fn with_vars(vars: &[(&str, Option<&str>)], f: impl Fn()) {
            let saved: Vec<(&str, Option<String>)> = vars
                .iter()
                .map(|(k, _)| (*k, std::env::var(*k).ok()))
                .collect();
            for (k, v) in vars {
                match v {
                    Some(val) => unsafe { std::env::set_var(k, val) },
                    None => unsafe { std::env::remove_var(k) },
                }
            }
            f();
            for (k, v) in saved {
                match v {
                    Some(val) => unsafe { std::env::set_var(k, val) },
                    None => unsafe { std::env::remove_var(k) },
                }
            }
        }
        with_vars(&[("FD_TEST_CPUS", None), ("FD_TEST_P", None)], || {
            assert_eq!(go_cpu_cap(), (4, 4)); // 16 / 4
        });
        with_vars(
            &[("FD_TEST_CPUS", None), ("FD_TEST_P", Some("0"))],
            || assert_eq!(go_cpu_cap(), (4, 4)),
        );
        with_vars(
            &[("FD_TEST_CPUS", None), ("FD_TEST_P", Some("bogus"))],
            || assert_eq!(go_cpu_cap(), (4, 4)),
        );
        with_vars(
            &[("FD_TEST_CPUS", Some("0")), ("FD_TEST_P", None)],
            || assert_eq!(go_cpu_cap(), (4, 4)),
        );
        with_vars(
            &[("FD_TEST_CPUS", Some("8")), ("FD_TEST_P", Some("2"))],
            || assert_eq!(go_cpu_cap(), (4, 2)),
        );
    }

    #[test]
    fn parses_single_line_use_block() {
        assert_eq!(parse_go_work_uses("go 1.21\nuse ( ./a )\n"), vec!["./a"]);
        assert_eq!(
            parse_go_work_uses("go 1.21\nuse ( ./a ./b )\n"),
            vec!["./a", "./b"]
        );
    }

    #[test]
    fn empty_use_block_emits_nothing() {
        assert!(parse_go_work_uses("go 1.21\nuse ( )\n").is_empty());
        assert!(parse_go_work_uses("go 1.21\nuse (\n)\nuse ./a\n").eq(&vec!["./a"]));
        assert!(
            parse_go_work_uses("go 1.21\nuse (\n\t./a\n\t./b\n)\nuse ./c\n")
                .eq(&vec!["./a", "./b", "./c"])
        );
    }

    #[test]
    fn tolerates_quotes_and_tab_separators() {
        assert_eq!(
            parse_go_work_uses("go 1.21\nuse \"./a\"\nuse './b'\n"),
            vec!["./a", "./b"]
        );
        assert_eq!(
            parse_go_work_uses("go 1.21\nuse\t./a\nuse(./b)\n"),
            vec!["./a", "./b"]
        );
        assert_eq!(
            parse_go_work_uses("go 1.21\nuse (\n\t\"./a\"\n\t'./b'\n)\n"),
            vec!["./a", "./b"]
        );
        assert!(parse_go_work_uses("go 1.21\nuse\nuse ./a\n").eq(&vec!["./a"]));
    }

    #[test]
    fn failure_output_keeps_module_headers() {
        let out = CommandOutput {
            stdout: "=== ./a ===\n--- FAIL: TestX\n    x_test.go:1: boom\n=== ./b ===\nok\n"
                .to_string(),
            stderr: String::new(),
            exit_code: 1,
            success: false,
        };
        let combined = format!("{}\n{}", out.stdout, out.stderr);
        let compressed = compress_go_output(&out, &combined).unwrap();
        assert!(compressed.stdout.contains("=== ./a ==="));
        assert!(compressed.stdout.contains("--- FAIL: TestX"));
    }
}
